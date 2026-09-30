import { config } from '../config.js';
import type { Database } from '../db.js';
import { newId } from '../security.js';
import { enqueueWebhookEvent } from '../webhooks/outbox.js';
import { decryptWebhookSecret } from '../webhooks/secret-crypto.js';
import { createWebhookSignature } from '../webhooks/signature.js';
import { safeWebhookTransportError } from '../webhooks/error-safety.js';
import { resolveWebhookTarget } from '../webhooks/url.js';
import { sendWebhookPinned, type PinnedWebhookRequest, type PinnedWebhookResponse } from '../webhooks/pinned-request.js';
import type { PaymentLifecycleData, PaymentLifecycleHandler } from './payment-lifecycle.js';

type DueDelivery = {
  id: string;
  endpoint_id: string;
  event_id: string;
  attempts: number;
  payload: Record<string, unknown>;
  url: string;
  secret_ciphertext: string;
  secret_nonce: string;
  secret_auth_tag: string;
};

type DeliveryJob = DueDelivery & { attemptId: string; attemptNumber: number; requestTimestamp: number };
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type WebhookWorkerSecurityOptions = {
  pinDns?: boolean;
  resolveTarget?: typeof resolveWebhookTarget;
  pinnedSender?: (target: Awaited<ReturnType<typeof resolveWebhookTarget>>, input: PinnedWebhookRequest) => Promise<PinnedWebhookResponse>;
};

export class WebhookDeliveryWorker {
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly fetcher: Fetcher = fetch,
    private readonly lifecycleHandlers: PaymentLifecycleHandler[] = [],
    private readonly security: WebhookWorkerSecurityOptions = {},
  ) {}

  async runOnce(): Promise<{ duePayments: number; expiredPayments: number; claimedDeliveries: number }> {
    if (this.running) return { duePayments: 0, expiredPayments: 0, claimedDeliveries: 0 };
    this.running = true;
    try {
      const expiration = await this.expirePayments();
      const jobs = await this.claimDueDeliveries(25);
      for (const job of jobs) await this.deliver(job);
      return { ...expiration, claimedDeliveries: jobs.length };
    } finally {
      this.running = false;
    }
  }

  private async expirePayments(): Promise<{ duePayments: number; expiredPayments: number }> {
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM payments
        WHERE status = 'PENDING' AND tx_hash IS NULL AND expires_at <= now()
        LIMIT 100`,
    );
    let expiredCount = 0;
    for (const { id } of due.rows) {
      const didExpire = await this.db.transaction(async (client) => {
        const locked = await client.query<{
          id: string; merchant_id: string; order_id: string; amount: string; currency: string; network: string;
          status: string; tx_hash: string | null;
        }>(
          `SELECT id, merchant_id, order_id, amount::text AS amount, currency, network, status, tx_hash
             FROM payments WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const payment = locked.rows[0];
        if (!payment || payment.status !== 'PENDING' || payment.tx_hash != null) return false;
        const order = await client.query(
          `UPDATE orders SET status = 'EXPIRED', updated_at = now()
            WHERE id = $1 AND merchant_id = $2 AND status = 'PENDING' RETURNING id`,
          [payment.order_id, payment.merchant_id],
        );
        if (!order.rows[0]) return false;
        await client.query(
          `UPDATE payments SET status = 'EXPIRED', updated_at = now() WHERE id = $1`,
          [payment.id],
        );
        await client.query(
          `INSERT INTO ledger_entries (id, merchant_id, order_id, payment_id, entry_type, amount, currency, reference, metadata)
           VALUES ($1, $2, $3, $4, 'PAYMENT_EXPIRED', 0, $5, $6, $7::jsonb)`,
          [newId(), payment.merchant_id, payment.order_id, payment.id, payment.currency, payment.id,
            JSON.stringify({ amount: payment.amount, network: payment.network })],
        );
        await enqueueWebhookEvent({
          client,
          merchantId: payment.merchant_id,
          eventType: 'payment.expired',
          resourceId: payment.id,
          data: {
            paymentId: payment.id, orderId: payment.order_id, amount: payment.amount,
            currency: payment.currency, network: payment.network, status: 'EXPIRED',
          },
        });
        const expiredPayment: PaymentLifecycleData = {
          paymentId: payment.id, merchantId: payment.merchant_id, orderId: payment.order_id,
          amount: payment.amount, currency: payment.currency, network: payment.network,
        };
        for (const handler of this.lifecycleHandlers) await handler.onPaymentExpired?.(client, expiredPayment);
        return true;
      });
      if (didExpire) expiredCount++;
    }
    return { duePayments: due.rows.length, expiredPayments: expiredCount };
  }

  private async claimDueDeliveries(limit: number): Promise<DeliveryJob[]> {
    return this.db.transaction(async (client) => {
      const due = await client.query<DueDelivery>(
        `SELECT d.id, d.endpoint_id, d.event_id, d.attempts, e.payload,
                ep.url, ep.secret_ciphertext, ep.secret_nonce, ep.secret_auth_tag
           FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id
           JOIN webhook_endpoints ep ON ep.id = d.endpoint_id
          WHERE ep.enabled = true AND ep.deleted_at IS NULL AND (
            (d.status IN ('QUEUED', 'RETRYING') AND d.next_attempt_at <= now()) OR
            (d.status = 'DELIVERING' AND d.updated_at < now() - interval '2 minutes')
          )
          ORDER BY d.next_attempt_at ASC, d.created_at ASC LIMIT $1`,
        [limit],
      );
      const jobs: DeliveryJob[] = [];
      for (const item of due.rows) {
        if (item.attempts >= config.WEBHOOK_MAX_ATTEMPTS) {
          await client.query(
            `UPDATE webhook_deliveries
                SET status = 'FAILED', last_error = 'Delivery worker stopped during the final attempt', updated_at = now()
              WHERE id = $1 AND status = 'DELIVERING'`,
            [item.id],
          );
          await client.query(
            `UPDATE webhook_delivery_attempts SET finished_at = now(), error = 'Delivery worker stopped during the final attempt'
              WHERE delivery_id = $1 AND attempt_number = $2 AND finished_at IS NULL`,
            [item.id, item.attempts],
          );
          continue;
        }
        const claimed = await client.query<{ attempts: number }>(
          `UPDATE webhook_deliveries SET status = 'DELIVERING', attempts = attempts + 1, updated_at = now()
            WHERE id = $1 AND (
              (status IN ('QUEUED', 'RETRYING') AND next_attempt_at <= now()) OR
              (status = 'DELIVERING' AND updated_at < now() - interval '2 minutes')
            ) RETURNING attempts`,
          [item.id],
        );
        if (!claimed.rows[0]) continue;
        const attemptNumber = claimed.rows[0].attempts;
        const requestTimestamp = Math.floor(Date.now() / 1000);
        const attemptId = newId();
        await client.query(
          `INSERT INTO webhook_delivery_attempts (id, delivery_id, attempt_number, request_timestamp)
           VALUES ($1, $2, $3, $4)`,
          [attemptId, item.id, attemptNumber, requestTimestamp],
        );
        jobs.push({ ...item, attemptId, attemptNumber, requestTimestamp });
      }
      return jobs;
    });
  }

  private async deliver(job: DeliveryJob): Promise<void> {
    let httpStatus: number | null = null;
    let error: string | null = null;
    try {
      const target = await (this.security.resolveTarget ?? resolveWebhookTarget)(job.url);
      const secret = decryptWebhookSecret({
        ciphertext: job.secret_ciphertext,
        nonce: job.secret_nonce,
        authTag: job.secret_auth_tag,
      });
      const body = JSON.stringify(job.payload);
      const signature = createWebhookSignature(secret, body, job.requestTimestamp);
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'Tariffia-Webhooks/1.0',
        'x-tariffia-event-id': job.event_id,
        'x-tariffia-timestamp': String(signature.timestamp),
        'x-tariffia-signature': signature.header,
      };
      const signal = AbortSignal.timeout(config.WEBHOOK_REQUEST_TIMEOUT_MS);
      const response = this.security.pinDns
        ? await (this.security.pinnedSender ?? sendWebhookPinned)(target, {
            headers, body, timeoutMs: config.WEBHOOK_REQUEST_TIMEOUT_MS, signal,
          })
        : await this.fetcher(target.url, { method: 'POST', redirect: 'manual', signal, headers, body });
      httpStatus = response.status;
      if (!response.ok) error = `Webhook receiver returned HTTP ${response.status}`;
      if ('body' in response) await response.body?.cancel();
    } catch (caught) {
      error = safeWebhookTransportError(caught);
    }

    const succeeded = httpStatus !== null && httpStatus >= 200 && httpStatus < 300 && error === null;
    const exhausted = !succeeded && job.attemptNumber >= config.WEBHOOK_MAX_ATTEMPTS;
    const status = succeeded ? 'SUCCEEDED' : exhausted ? 'FAILED' : 'RETRYING';
    const nextAttemptAt = status === 'RETRYING' ? this.retryAt(job.attemptNumber) : null;
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE webhook_delivery_attempts
            SET finished_at = now(), http_status = $2, error = $3
          WHERE id = $1`,
        [job.attemptId, httpStatus, error],
      );
      await client.query(
        `UPDATE webhook_deliveries
            SET status = $2, next_attempt_at = COALESCE($3, next_attempt_at),
                last_http_status = $4, last_error = $5,
                delivered_at = CASE WHEN $2 = 'SUCCEEDED' THEN now() ELSE delivered_at END,
                updated_at = now()
          WHERE id = $1 AND status = 'DELIVERING' AND attempts = $6`,
        [job.id, status, nextAttemptAt, httpStatus, error, job.attemptNumber],
      );
    });
  }

  private retryAt(attemptNumber: number): Date {
    const baseDelayMs = Math.min(1000 * 2 ** Math.min(attemptNumber - 1, 12), 60 * 60 * 1000);
    const jitteredMs = Math.floor(baseDelayMs * (0.8 + Math.random() * 0.4));
    return new Date(Date.now() + jitteredMs);
  }
}
