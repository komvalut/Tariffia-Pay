import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnits } from 'viem';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import type { AdapterPaymentDetails, PaymentAdapter } from '../src/payment-adapter.js';
import { PaymentAdapterRegistry } from '../src/payment-adapters/registry.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const usdcAddress = '0x833589fCD6eDb6E08f4c7C32d4f71b54bdA02913';

function pgAdapterPool(memory: ReturnType<typeof newDb>): Pool {
  const adapter = memory.adapters.createPg();
  return new adapter.Pool() as Pool;
}

async function createDatabase(): Promise<Database> {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const pool = pgAdapterPool(memory);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  let phaseOne = await readFile(path.join(migrationsDir, '0001_phase1.sql'), 'utf8');
  phaseOne = phaseOne.split('CREATE OR REPLACE FUNCTION reject_ledger_mutation()')[0] ?? phaseOne;
  await pool.query(phaseOne);
  const phaseTwo = await readFile(path.join(migrationsDir, '0002_usdc_base.sql'), 'utf8');
  const backfillStart = phaseTwo.indexOf('UPDATE payments\n   SET adapter_data = jsonb_build_object');
  if (backfillStart >= 0) {
    const backfillEnd = phaseTwo.indexOf(';', backfillStart);
    await pool.query(phaseTwo.slice(0, backfillStart) + phaseTwo.slice(backfillEnd + 1));
  } else {
    await pool.query(phaseTwo);
  }
  let webhookMigration = await readFile(path.join(migrationsDir, '0003_webhooks.sql'), 'utf8');
  webhookMigration = webhookMigration.replace(
    /event_type text NOT NULL CHECK \(event_type IN \([\s\S]*?\)\),/,
    'event_type text NOT NULL,',
  );
  await pool.query(webhookMigration);
  for (const migration of ['0004_credit_engine.sql', '0005_ai_pricing.sql', '0006_invoices_receipts.sql',
    '0007_subscriptions.sql', '0008_ai_provider_integration.sql', '0009_sms_otp.sql',
    '0010_sms_provider_hardening.sql', '0011_merchant_usage_limits.sql', '0012_payment_links.sql',
    '0013_merchant_settings.sql', '0014_notification_preferences.sql']) {
    await pool.query(await readFile(path.join(migrationsDir, migration), 'utf8'));
  }
  return {
    query: (text, values = []) => pool.query(text, values),
    transaction: async (run) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await run(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  } as Database;
}

function stubAdapter(): PaymentAdapter {
  return {
    id: 'usdc',
    manifest: {
      id: 'usdc', name: 'Base USDC', version: 'test', description: 'Test Base USDC adapter',
      capabilities: {
        paymentRequests: true, transactionVerification: true, statusPolling: false, recurringPayments: false,
        automaticDetection: true, refunds: false, paymentRequestFormat: 'wallet',
        currencies: ['USDC'], networks: ['base'],
      },
      idempotency: { paymentCreation: 'stable-key-required', transactionVerification: 'network-and-transaction-id' },
    },
    initialize: async () => {},
    shutdown: async () => {},
    health: async () => ({ status: 'healthy', message: 'Test adapter is ready' }),
    normalizeTransactionId: (transactionId) => transactionId.toLowerCase(),
    createRequest: vi.fn(async (input): Promise<AdapterPaymentDetails> => ({
      adapter: 'usdc', network: 'base', currency: 'USDC',
      recipientAddress: input.recipient.toLowerCase(), tokenAddress: usdcAddress.toLowerCase(),
      amountBaseUnits: parseUnits(input.amount, 6).toString(), adapterData: { chainId: 8453, decimals: 6 },
    })),
    verifyTransaction: async (input) => ({
      state: 'verified',
      receipt: {
        transactionId: input.transactionId, network: input.network, state: 'confirmed',
        amount: input.amount, currency: input.currency, recipient: input.recipientAddress,
        confirmations: 12, blockNumber: '123456',
      },
    }),
  };
}

describe('merchant payment status polish', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let apiKey: string;

  async function createMerchant(name: string, email: string, wallet: string) {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().apiKey as string;
  }

  async function createPayment(key: string, idempotencyKey: string) {
    const order = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey },
      payload: { description: `Order ${idempotencyKey}`, amount: '6.00', currency: 'USDC' },
    });
    expect(order.statusCode, order.body).toBe(201);
    return { orderId: order.json().order.id as string, paymentId: order.json().payment.id as string };
  }

  const confirm = (key: string, paymentId: string, hash: string) => app.inject({
    method: 'POST', url: `/v1/payments/${paymentId}/verify`,
    headers: { authorization: `Bearer ${key}` }, payload: { transactionHash: hash },
  });

  beforeEach(async () => {
    db = await createDatabase();
    const registry = new PaymentAdapterRegistry();
    registry.register(stubAdapter(), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    app = await buildApp({ db, adapterRegistry: registry });
    apiKey = await createMerchant('Status Store', 'status@example.com', '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e');
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('exposes consistent status fields and timestamps on transactions', async () => {
    const { paymentId } = await createPayment(apiKey, 'status-order-0001');
    const pending = await app.inject({ method: 'GET', url: `/v1/transactions/${paymentId}`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().transaction).toMatchObject({
      paymentId, status: 'PENDING', statusLabel: 'Pending', confirmedAt: null,
    });
    // All required timestamps are always present as keys.
    for (const key of ['createdAt', 'expiresAt', 'detectedAt', 'confirmedAt']) {
      expect(pending.json().transaction, key).toHaveProperty(key);
    }
    expect(pending.json().transaction.createdAt).toBeTruthy();
    expect(pending.json().transaction.expiresAt).toBeTruthy();

    expect((await confirm(apiKey, paymentId, `0x${'a'.repeat(64)}`)).statusCode).toBe(200);
    const confirmed = await app.inject({ method: 'GET', url: `/v1/transactions/${paymentId}`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(confirmed.json().transaction).toMatchObject({ status: 'CONFIRMED', statusLabel: 'Confirmed' });
    expect(confirmed.json().transaction.confirmedAt).toBeTruthy();
  });

  it('maps every documented status to a clear label', async () => {
    const { paymentId } = await createPayment(apiKey, 'status-order-0002');
    const expected: Array<[string, string]> = [
      ['CREATED', 'Created'], ['PENDING', 'Pending'], ['DETECTED', 'Detected'], ['VERIFYING', 'Verifying'],
      ['CONFIRMED', 'Confirmed'], ['FAILED', 'Failed'], ['EXPIRED', 'Expired'], ['REFUNDED', 'Refunded'],
    ];
    for (const [status, label] of expected) {
      await db.query('UPDATE payments SET status = $2 WHERE id = $1', [paymentId, status]);
      const response = await app.inject({
        method: 'GET', url: `/v1/transactions/${paymentId}`, headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(response.json().transaction, status).toMatchObject({ status, statusLabel: label });
    }
  });

  it('exposes order and payment status labels with timestamps on orders', async () => {
    const { orderId, paymentId } = await createPayment(apiKey, 'status-order-0003');
    await confirm(apiKey, paymentId, `0x${'b'.repeat(64)}`);

    const list = await app.inject({ method: 'GET', url: '/v1/orders', headers: { authorization: `Bearer ${apiKey}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json().orders[0]).toMatchObject({
      id: orderId, status: 'PAID', statusLabel: 'Paid',
      paymentStatus: 'CONFIRMED', paymentStatusLabel: 'Confirmed',
    });
    for (const key of ['createdAt', 'updatedAt', 'expiresAt', 'detectedAt', 'confirmedAt']) {
      expect(list.json().orders[0], key).toHaveProperty(key);
    }
    expect(list.json().orders[0].confirmedAt).toBeTruthy();

    const detail = await app.inject({ method: 'GET', url: `/v1/orders/${orderId}`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(detail.json().order).toMatchObject({
      statusLabel: 'Paid', paymentStatusLabel: 'Confirmed', paymentStatus: 'CONFIRMED',
    });
    expect(detail.json().order.confirmedAt).toBeTruthy();

    const payment = await app.inject({ method: 'GET', url: `/v1/payments/${paymentId}`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(payment.json().payment).toMatchObject({ status: 'CONFIRMED', statusLabel: 'Confirmed' });
    const details = await app.inject({ method: 'GET', url: `/v1/payments/${paymentId}/details`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(details.json().payment).toMatchObject({ statusLabel: 'Confirmed', confirmedAt: expect.any(String) });
  });

  it('returns empty results for a merchant with no payments and keeps isolation', async () => {
    const empty = await createMerchant('Empty Status', 'empty-status@example.com', '0x6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f');
    expect((await app.inject({ method: 'GET', url: '/v1/transactions', headers: { authorization: `Bearer ${empty}` } })).json().transactions).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/orders', headers: { authorization: `Bearer ${empty}` } })).json().orders).toEqual([]);

    const { paymentId } = await createPayment(apiKey, 'status-order-0004');
    expect((await app.inject({ method: 'GET', url: '/v1/transactions', headers: { authorization: `Bearer ${empty}` } })).json().transactions).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/v1/transactions/${paymentId}`, headers: { authorization: `Bearer ${empty}` } })).statusCode).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/transactions' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/orders' })).statusCode).toBe(401);
  });
});
