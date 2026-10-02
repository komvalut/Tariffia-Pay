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
    '0010_sms_provider_hardening.sql', '0011_merchant_usage_limits.sql', '0012_payment_links.sql']) {
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

function stubAdapter(verify: boolean): PaymentAdapter {
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
    verifyTransaction: async (input) => verify ? {
      state: 'verified',
      receipt: {
        transactionId: input.transactionId, network: input.network, state: 'confirmed',
        amount: input.amount, currency: input.currency, recipient: input.recipientAddress,
        confirmations: 12, blockNumber: '123456',
      },
    } : { state: 'not_found' },
  };
}

describe('merchant revenue summary', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let apiKey: string;
  let merchantId: string;

  async function createMerchant(name: string, email: string, wallet: string) {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return { apiKey: response.json().apiKey as string, merchantId: response.json().merchant.id as string };
  }

  async function createPayment(key: string, amount: string, idempotencyKey: string) {
    const order = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey },
      payload: { description: `Order ${idempotencyKey}`, amount, currency: 'USDC' },
    });
    expect(order.statusCode, order.body).toBe(201);
    return order.json().payment.id as string;
  }

  const summary = (key: string, query = '') => app.inject({
    method: 'GET', url: `/v1/revenue/summary${query}`, headers: { authorization: `Bearer ${key}` },
  });

  beforeEach(async () => {
    db = await createDatabase();
    const registry = new PaymentAdapterRegistry();
    registry.register(stubAdapter(true), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    app = await buildApp({ db, adapterRegistry: registry });
    const merchant = await createMerchant('Revenue Store', 'revenue@example.com', '0x8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a');
    apiKey = merchant.apiKey;
    merchantId = merchant.merchantId;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('sums confirmed revenue and counts payments per status bucket', async () => {
    const first = await createPayment(apiKey, '10.00', 'revenue-order-0001');
    const second = await createPayment(apiKey, '2.50', 'revenue-order-0002');
    await createPayment(apiKey, '5.00', 'revenue-order-0003');

    // Confirm two payments; the third stays pending.
    for (const [paymentId, hash] of [[first, `0x${'a'.repeat(64)}`], [second, `0x${'b'.repeat(64)}`]] as const) {
      const verified = await app.inject({
        method: 'POST', url: `/v1/payments/${paymentId}/verify`,
        headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash: hash },
      });
      expect(verified.statusCode, verified.body).toBe(200);
    }
    // Mark one additional payment failed and one expired directly on the payment record.
    await createPayment(apiKey, '1.00', 'revenue-order-0004');
    await db.query(`UPDATE payments SET status = 'FAILED' WHERE merchant_id = $1 AND id IN (
      SELECT id FROM payments WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1)`, [merchantId]);
    await db.query(`UPDATE payments SET status = 'EXPIRED' WHERE merchant_id = $1 AND amount = 5.000000`, [merchantId]);

    const response = await summary(apiKey);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().revenue).toMatchObject({
      currency: 'USDC', totalConfirmed: '12.500000',
      confirmedPaymentCount: 2, pendingPaymentCount: 0, failedPaymentCount: 1, expiredPaymentCount: 1,
    });
    expect(response.json().revenue.totalsByCurrency).toEqual({ USDC: '12.500000' });
    expect(response.body).not.toContain('privateKey');
    void merchantId;
  });

  it('filters by from and to dates', async () => {
    await createPayment(apiKey, '3.00', 'revenue-order-0005');
    const now = new Date();
    const past = new Date(now.getTime() - 86_400_000).toISOString();
    const future = new Date(now.getTime() + 86_400_000).toISOString();

    expect((await summary(apiKey, `?from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`)).json().revenue)
      .toMatchObject({ pendingPaymentCount: 1 });
    // A window entirely in the past excludes the just-created payment.
    expect((await summary(apiKey, `?to=${encodeURIComponent(past)}`)).json().revenue)
      .toMatchObject({ pendingPaymentCount: 0, confirmedPaymentCount: 0 });
    expect((await summary(apiKey, `?from=${encodeURIComponent(future)}`)).json().revenue)
      .toMatchObject({ pendingPaymentCount: 0 });
    expect((await summary(apiKey, `?from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`)).json().revenue.from)
      .toBe(past);
  });

  it('returns a zero summary when the merchant has no payments', async () => {
    const empty = await createMerchant('Empty Store', 'empty@example.com', '0x9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b');
    const response = await summary(empty.apiKey);
    expect(response.statusCode).toBe(200);
    expect(response.json().revenue).toMatchObject({
      currency: null, totalConfirmed: '0.000000',
      confirmedPaymentCount: 0, pendingPaymentCount: 0, failedPaymentCount: 0, expiredPaymentCount: 0,
    });
  });

  it('keeps revenue isolated between merchants', async () => {
    const other = await createMerchant('Other Store', 'other-revenue@example.com', '0x9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c');
    const paymentId = await createPayment(apiKey, '4.00', 'revenue-order-0006');
    await app.inject({
      method: 'POST', url: `/v1/payments/${paymentId}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash: `0x${'e'.repeat(64)}` },
    });

    const mine = (await summary(apiKey)).json().revenue;
    const theirs = (await summary(other.apiKey)).json().revenue;
    expect(mine).toMatchObject({ totalConfirmed: '4.000000', confirmedPaymentCount: 1 });
    expect(theirs).toMatchObject({ totalConfirmed: '0.000000', confirmedPaymentCount: 0 });
  });

  it('rejects unauthenticated requests and invalid date filters', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/revenue/summary' })).statusCode).toBe(401);
    expect((await summary(apiKey, '?from=not-a-date')).statusCode).toBe(400);
    expect((await summary(apiKey, '?to=13/13/2026')).statusCode).toBe(400);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect((await summary(apiKey, `?from=${encodeURIComponent(future)}&to=${encodeURIComponent(past)}`)).statusCode).toBe(400);
  });
});
