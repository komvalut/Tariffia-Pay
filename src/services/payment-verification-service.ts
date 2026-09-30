import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import type { PaymentAdapter, PaymentVerificationResult } from '../payment-adapter.js';
import { newId } from '../security.js';
import { enqueueWebhookEvent } from '../webhooks/outbox.js';
import type { PoolClient } from 'pg';
import type { PaymentLifecycleHandler } from './payment-lifecycle.js';

type PaymentRecord = {
  id: string;
  merchant_id: string;
  order_id: string;
  amount: string;
  amount_base_units: string;
  currency: string;
  adapter: string;
  network: string;
  recipient_address: string;
  token_address: string | null;
  adapter_data: Record<string, unknown>;
  status: string;
  tx_hash: string | null;
  created_at: Date;
};

export type PaymentProcessingResult = {
  status: 'PENDING' | 'DETECTED' | 'CONFIRMED' | 'FAILED';
  transactionHash: string;
  confirmations: number;
  alreadyConfirmed?: boolean;
  alreadyFailed?: boolean;
  failureReason?: string;
};

export class PaymentVerificationService {
  private readonly adapters: Map<string, PaymentAdapter>;
  private readonly lifecycleHandlers: PaymentLifecycleHandler[];

  constructor(private readonly db: Database, adapters: PaymentAdapter[], lifecycleHandlers: PaymentLifecycleHandler[] = []) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.lifecycleHandlers = [...lifecycleHandlers];
  }

  addLifecycleHandler(handler: PaymentLifecycleHandler): void {
    if (!this.lifecycleHandlers.includes(handler)) this.lifecycleHandlers.push(handler);
  }

  async processPublic(paymentId: string, transactionHash: string): Promise<PaymentProcessingResult> {
    const result = await this.db.query<{ merchant_id: string }>(
      'SELECT merchant_id FROM payments WHERE id = $1',
      [paymentId],
    );
    const payment = result.rows[0];
    if (!payment) throw new HttpError(404, 'Payment not found', 'not_found');
    return this.process(paymentId, payment.merchant_id, transactionHash);
  }

  async process(paymentId: string, merchantId: string, transactionHash: string): Promise<PaymentProcessingResult> {
    const result = await this.db.query<PaymentRecord>(
      `SELECT id, merchant_id, order_id, amount::text AS amount, amount_base_units::text AS amount_base_units,
              currency, adapter, network, recipient_address, token_address, adapter_data, status, tx_hash, created_at
         FROM payments WHERE id = $1 AND merchant_id = $2`,
      [paymentId, merchantId],
    );
    const payment = result.rows[0];
    if (!payment) throw new HttpError(404, 'Payment not found', 'not_found');
    const normalizedHash = transactionHash.toLowerCase();
    if (payment.status === 'CONFIRMED') {
      if (payment.tx_hash?.toLowerCase() !== normalizedHash) {
        throw new HttpError(409, 'Payment was already confirmed with a different transaction', 'payment_already_confirmed');
      }
      return { status: 'CONFIRMED', transactionHash: normalizedHash, confirmations: 0, alreadyConfirmed: true };
    }
    if (payment.status === 'FAILED') {
      if (payment.tx_hash?.toLowerCase() !== normalizedHash) {
        throw new HttpError(409, 'Payment already failed with a different transaction', 'payment_already_failed');
      }
      return { status: 'FAILED', transactionHash: normalizedHash, confirmations: 0, alreadyFailed: true };
    }
    if (!['PENDING', 'DETECTED'].includes(payment.status)) {
      throw new HttpError(409, `Payment cannot be verified from status ${payment.status}`, 'invalid_payment_state');
    }
    if (payment.tx_hash && payment.tx_hash.toLowerCase() !== normalizedHash) {
      throw new HttpError(409, 'Another transaction is already being verified for this payment', 'transaction_conflict');
    }

    const adapter = this.adapters.get(payment.adapter);
    if (!adapter) throw new HttpError(503, `Payment adapter '${payment.adapter}' is not configured`, 'adapter_unavailable');
    const verification = await adapter.verifyTransaction({
      paymentId: payment.id,
      transactionHash: normalizedHash,
      amount: payment.amount,
      currency: payment.currency,
      network: payment.network,
      recipientAddress: payment.recipient_address,
      tokenAddress: payment.token_address,
      createdAt: payment.created_at,
    });

    if (verification.state === 'rejected') {
      throw new HttpError(422, verification.reason, 'transaction_verification_failed');
    }
    if (verification.state === 'failed') {
      const alreadyFailed = await this.fail(payment, normalizedHash, verification);
      return {
        status: 'FAILED', transactionHash: normalizedHash, confirmations: 0,
        failureReason: verification.reason,
        ...(alreadyFailed ? { alreadyFailed: true } : {}),
      };
    }
    if (verification.state === 'not_found') {
      const alreadyConfirmed = await this.recordSubmittedHash(payment, normalizedHash);
      return {
        status: alreadyConfirmed ? 'CONFIRMED' : payment.status === 'DETECTED' ? 'DETECTED' : 'PENDING',
        transactionHash: normalizedHash,
        confirmations: 0,
        ...(alreadyConfirmed ? { alreadyConfirmed: true } : {}),
      };
    }
    if (verification.state === 'pending') {
      if (!verification.detected) {
        return { status: 'PENDING', transactionHash: normalizedHash, confirmations: verification.confirmations };
      }
      const alreadyConfirmed = await this.markDetected(payment, normalizedHash);
      return {
        status: alreadyConfirmed ? 'CONFIRMED' : 'DETECTED',
        transactionHash: normalizedHash,
        confirmations: verification.confirmations,
        ...(alreadyConfirmed ? { alreadyConfirmed: true } : {}),
      };
    }

    const alreadyConfirmed = await this.confirm(payment, normalizedHash, verification);
    return {
      status: 'CONFIRMED', transactionHash: normalizedHash, confirmations: verification.confirmations,
      ...(alreadyConfirmed ? { alreadyConfirmed: true } : {}),
    };
  }

  private async recordSubmittedHash(payment: PaymentRecord, transactionHash: string): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const locked = await client.query<Pick<PaymentRecord, 'status' | 'tx_hash'>>(
        'SELECT status, tx_hash FROM payments WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
        [payment.id, payment.merchant_id],
      );
      const current = locked.rows[0];
      if (!current) throw new HttpError(404, 'Payment not found', 'not_found');
      if (current.status === 'CONFIRMED') {
        if (current.tx_hash?.toLowerCase() === transactionHash) return true;
        throw new HttpError(409, 'Payment was already confirmed with a different transaction', 'payment_already_confirmed');
      }
      if (current.tx_hash && current.tx_hash.toLowerCase() !== transactionHash) {
        throw new HttpError(409, 'Another transaction is already being verified for this payment', 'transaction_conflict');
      }
      if (!current.tx_hash && current.status === 'PENDING') {
        await client.query('UPDATE payments SET tx_hash = $2, updated_at = now() WHERE id = $1 AND status = \'PENDING\'', [payment.id, transactionHash]);
      }
      return false;
    });
  }

  private async markDetected(payment: PaymentRecord, transactionHash: string): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const locked = await client.query<Pick<PaymentRecord, 'status' | 'tx_hash'>>(
        'SELECT status, tx_hash FROM payments WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
        [payment.id, payment.merchant_id],
      );
      const row = locked.rows[0];
      if (!row) throw new HttpError(404, 'Payment not found', 'not_found');
      if (row.status === 'CONFIRMED') {
        if (row.tx_hash?.toLowerCase() === transactionHash) return true;
        throw new HttpError(409, 'Payment was already confirmed with a different transaction', 'payment_already_confirmed');
      }
      if (row.tx_hash && row.tx_hash.toLowerCase() !== transactionHash) {
        throw new HttpError(409, 'Another transaction is already being verified for this payment', 'transaction_conflict');
      }
      if (row.status === 'DETECTED' && row.tx_hash) return false;
      if (row.status !== 'PENDING') throw new HttpError(409, `Payment cannot be detected from status ${row.status}`, 'invalid_payment_state');
      await client.query(
        `UPDATE payments SET status = 'DETECTED', tx_hash = $2, detected_at = COALESCE(detected_at, now()), updated_at = now()
          WHERE id = $1 AND status = 'PENDING'`,
        [payment.id, transactionHash],
      );
      await this.appendDetectedEvent(client, payment, transactionHash);
      return false;
    });
  }

  private async fail(payment: PaymentRecord, transactionHash: string, failure: Extract<PaymentVerificationResult, { state: 'failed' }>): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const locked = await client.query<Pick<PaymentRecord, 'status' | 'tx_hash'>>(
        'SELECT status, tx_hash FROM payments WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
        [payment.id, payment.merchant_id],
      );
      const current = locked.rows[0];
      if (!current) throw new HttpError(404, 'Payment not found', 'not_found');
      if (current.status === 'FAILED') {
        if (current.tx_hash?.toLowerCase() === transactionHash) return true;
        throw new HttpError(409, 'Payment already failed with a different transaction', 'payment_already_failed');
      }
      if (!['PENDING', 'DETECTED'].includes(current.status)) {
        throw new HttpError(409, `Payment cannot fail from status ${current.status}`, 'invalid_payment_state');
      }
      if (current.tx_hash && current.tx_hash.toLowerCase() !== transactionHash) {
        throw new HttpError(409, 'Another transaction is already being verified for this payment', 'transaction_conflict');
      }
      if (current.status === 'PENDING') {
        await client.query(
          `UPDATE payments SET status = 'DETECTED', tx_hash = $2, detected_at = COALESCE(detected_at, now()), updated_at = now()
            WHERE id = $1 AND status = 'PENDING'`,
          [payment.id, transactionHash],
        );
        await this.appendDetectedEvent(client, payment, transactionHash);
      }
      const order = await client.query(
        `UPDATE orders SET status = 'FAILED', updated_at = now()
          WHERE id = $1 AND merchant_id = $2 AND status IN ('CREATED', 'PENDING') RETURNING id`,
        [payment.order_id, payment.merchant_id],
      );
      if (!order.rows[0]) throw new HttpError(409, 'Order is not payable in its current state', 'invalid_order_state');
      await client.query(
        `UPDATE payments SET status = 'FAILED', tx_hash = $2, failure_reason = $3, updated_at = now()
          WHERE id = $1`,
        [payment.id, transactionHash, failure.reason],
      );
      await client.query(
        `INSERT INTO ledger_entries (id, merchant_id, order_id, payment_id, entry_type, amount, currency, reference, metadata)
         VALUES ($1, $2, $3, $4, 'PAYMENT_FAILED', 0, $5, $6, $7::jsonb)`,
        [newId(), payment.merchant_id, payment.order_id, payment.id, payment.currency, transactionHash,
          JSON.stringify({ amount: payment.amount, network: payment.network, reason: failure.reason, blockNumber: failure.blockNumber.toString() })],
      );
      await enqueueWebhookEvent({
        client,
        merchantId: payment.merchant_id,
        eventType: 'payment.failed',
        resourceId: payment.id,
        data: {
          paymentId: payment.id, orderId: payment.order_id, amount: payment.amount,
          currency: payment.currency, network: payment.network, transactionHash,
          reason: failure.reason, status: 'FAILED',
        },
      });
      for (const handler of this.lifecycleHandlers) {
        await handler.onPaymentFailed?.(client, {
          paymentId: payment.id, merchantId: payment.merchant_id, orderId: payment.order_id,
          amount: payment.amount, currency: payment.currency, network: payment.network,
          transactionHash, reason: failure.reason,
        });
      }
      return false;
    });
  }

  private async confirm(payment: PaymentRecord, transactionHash: string, verification: Extract<PaymentVerificationResult, { state: 'verified' }>): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const locked = await client.query<Pick<PaymentRecord, 'status' | 'tx_hash'>>(
        'SELECT status, tx_hash FROM payments WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
        [payment.id, payment.merchant_id],
      );
      const current = locked.rows[0];
      if (!current) throw new HttpError(404, 'Payment not found', 'not_found');
      if (current.status === 'CONFIRMED') {
        if (current.tx_hash?.toLowerCase() === transactionHash) return true;
        throw new HttpError(409, 'Payment was already confirmed with a different transaction', 'payment_already_confirmed');
      }
      if (!['PENDING', 'DETECTED'].includes(current.status)) {
        throw new HttpError(409, `Payment cannot be confirmed from status ${current.status}`, 'invalid_payment_state');
      }
      if (current.tx_hash && current.tx_hash.toLowerCase() !== transactionHash) {
        throw new HttpError(409, 'Another transaction is already being verified for this payment', 'transaction_conflict');
      }
      if (current.status === 'PENDING') {
        await client.query(
          `UPDATE payments SET status = 'DETECTED', tx_hash = $2, detected_at = COALESCE(detected_at, now()), updated_at = now()
            WHERE id = $1 AND status = 'PENDING'`,
          [payment.id, transactionHash],
        );
        await this.appendDetectedEvent(client, payment, transactionHash, verification.confirmations);
      }

      const order = await client.query(
        `UPDATE orders SET status = 'PAID', updated_at = now()
          WHERE id = $1 AND merchant_id = $2 AND status IN ('CREATED', 'PENDING')
          RETURNING id`,
        [payment.order_id, payment.merchant_id],
      );
      if (!order.rows[0]) throw new HttpError(409, 'Order is not payable in its current state', 'invalid_order_state');

      await client.query(
        `UPDATE payments
            SET status = 'CONFIRMED', tx_hash = $2, token_address = $3,
                confirmed_at = now(), updated_at = now()
          WHERE id = $1`,
        [payment.id, transactionHash, payment.token_address],
      );
      await client.query(
        `INSERT INTO ledger_entries (id, merchant_id, order_id, payment_id, entry_type, amount, currency, reference, metadata)
         VALUES ($1, $2, $3, $4, 'PAYMENT_CONFIRMED', $5, $6, $7, $8::jsonb)`,
        [
          newId(), payment.merchant_id, payment.order_id, payment.id, payment.amount,
          payment.currency, transactionHash,
          JSON.stringify({ network: payment.network, tokenAddress: payment.token_address, confirmations: verification.confirmations, blockNumber: verification.blockNumber.toString() }),
        ],
      );
      await enqueueWebhookEvent({
        client,
        merchantId: payment.merchant_id,
        eventType: 'payment.confirmed',
        resourceId: payment.id,
        data: {
          paymentId: payment.id, orderId: payment.order_id, amount: payment.amount,
          currency: payment.currency, network: payment.network, transactionHash,
          confirmations: verification.confirmations, status: 'CONFIRMED',
        },
      });
      await enqueueWebhookEvent({
        client,
        merchantId: payment.merchant_id,
        eventType: 'order.paid',
        resourceId: payment.order_id,
        data: {
          orderId: payment.order_id, paymentId: payment.id, amount: payment.amount,
          currency: payment.currency, transactionHash, status: 'PAID',
        },
      });
      for (const handler of this.lifecycleHandlers) {
        await handler.onPaymentConfirmed?.(client, {
          paymentId: payment.id, merchantId: payment.merchant_id, orderId: payment.order_id,
          amount: payment.amount, currency: payment.currency, network: payment.network, transactionHash,
        });
      }
      return false;
    });
  }

  private async appendDetectedEvent(client: PoolClient, payment: PaymentRecord, transactionHash: string, confirmations = 0): Promise<void> {
    await client.query(
      `INSERT INTO ledger_entries (id, merchant_id, order_id, payment_id, entry_type, amount, currency, reference, metadata)
       VALUES ($1, $2, $3, $4, 'PAYMENT_DETECTED', 0, $5, $6, $7::jsonb)`,
      [newId(), payment.merchant_id, payment.order_id, payment.id, payment.currency, transactionHash,
        JSON.stringify({ amount: payment.amount, network: payment.network, confirmations })],
    );
    await enqueueWebhookEvent({
      client,
      merchantId: payment.merchant_id,
      eventType: 'payment.detected',
      resourceId: payment.id,
      data: {
        paymentId: payment.id, orderId: payment.order_id, amount: payment.amount,
        currency: payment.currency, network: payment.network, transactionHash,
        confirmations, status: 'DETECTED',
      },
    });
  }
}
