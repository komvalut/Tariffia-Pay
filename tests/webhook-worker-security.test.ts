import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { Database } from '../src/db.js';
import { newId } from '../src/security.js';
import { WebhookDeliveryWorker } from '../src/services/webhook-delivery-worker.js';
import { encryptWebhookSecret } from '../src/webhooks/secret-crypto.js';
import type { WebhookTarget } from '../src/webhooks/url.js';

describe('production webhook transport hardening', () => {
  it('uses the validated pinned transport instead of resolving the webhook hostname again', async () => {
    const encrypted = encryptWebhookSecret('worker-test-webhook-secret-at-least-32-chars');
    const dueJob = {
      id: newId(), endpoint_id: newId(), event_id: newId(), attempts: 0,
      payload: { id: 'event-1', type: 'payment.confirmed' },
      url: 'https://hooks.example.test/receive',
      secret_ciphertext: encrypted.ciphertext, secret_nonce: encrypted.nonce, secret_auth_tag: encrypted.authTag,
    };
    const target: WebhookTarget = {
      url: new URL(dueJob.url),
      addresses: [{ address: '8.8.8.8', family: 4 }],
    };
    const resolveTarget = vi.fn(async () => target);
    const pinnedSender = vi.fn(async () => ({ status: 204, ok: true }));
    const unpinnedFetcher = vi.fn(async () => new Response(null, { status: 500 }));
    const db = {
      query: async () => ({ rows: [] }),
      transaction: async (run: (transactionClient: PoolClient) => Promise<unknown>) => {
        const transactionClient = {
          query: async (sql: string) => {
            if (sql.includes('SELECT d.id, d.endpoint_id')) return { rows: [dueJob] };
            if (sql.includes('UPDATE webhook_deliveries SET status = \'DELIVERING\'')) return { rows: [{ attempts: 1 }] };
            return { rows: [] };
          },
        };
        return run(transactionClient as unknown as PoolClient);
      },
      close: async () => undefined,
    } as unknown as Database;

    const worker = new WebhookDeliveryWorker(db, unpinnedFetcher, [], {
      pinDns: true,
      resolveTarget,
      pinnedSender,
    });
    await expect(worker.runOnce()).resolves.toMatchObject({ claimedDeliveries: 1 });
    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(pinnedSender).toHaveBeenCalledOnce();
    expect(pinnedSender.mock.calls[0]?.[0].addresses?.[0]?.address).toBe('8.8.8.8');
    expect(unpinnedFetcher).not.toHaveBeenCalled();
  });
});
