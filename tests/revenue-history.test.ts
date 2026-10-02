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

describe('merchant revenue history', () => {
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

  async function confirmPayment(key: string, amount: string, idempotencyKey: string, confirmedAtIso: string, currency = 'USDC') {
    const order = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey },
      payload: { description: `Order ${idempotencyKey}`, amount, currency: 'USDC' },
    });
    expect(order.statusCode, order.body).toBe(201);
    const paymentId = order.json().payment.id as string;
    const verified = await app.inject({
      method: 'POST', url: `/v1/payments/${paymentId}/verify`,
      headers: { authorization: `Bearer ${key}` }, payload: { transactionHash: `0x${idempotencyKey.replace(/[^a-f0-9]/g, '0').padEnd(64, '0').slice(0, 64)}` },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    // Pin the confirmation time and settlement currency for deterministic daily buckets.
    await db.query('UPDATE payments SET confirmed_at = $2, currency = $3 WHERE id = $1', [paymentId, confirmedAtIso, currency]);
    return paymentId;
  }

  const history = (key: string, query = '') => app.inject({
    method: 'GET', url: `/v1/revenue/history${query}`, headers: { authorization: `Bearer ${key}` },
  });

  beforeEach(async () => {
    db = await createDatabase();
    const registry = new PaymentAdapterRegistry();
    registry.register(stubAdapter(), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    app = await buildApp({ db, adapterRegistry: registry });
    apiKey = await createMerchant('History Store', 'history@example.com', '0x8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b');
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('aggregates confirmed revenue per UTC day', async () => {
    await confirmPayment(apiKey, '3.00', 'history-order-0001', '2026-01-01T09:00:00.000Z');
    await confirmPayment(apiKey, '5.00', 'history-order-0002', '2026-01-02T10:00:00.000Z');
    await confirmPayment(apiKey, '1.25', 'history-order-0003', '2026-01-02T23:30:00.000Z');
    // A pending payment is never part of revenue history.
    await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'history-order-0004' },
      payload: { description: 'Pending', amount: '9.00', currency: 'USDC' },
    });

    const response = await history(apiKey);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().history).toEqual([
      { date: '2026-01-01', currency: 'USDC', confirmedAmount: '3.000000', confirmedPaymentCount: 1 },
      { date: '2026-01-02', currency: 'USDC', confirmedAmount: '6.250000', confirmedPaymentCount: 2 },
    ]);
    expect(response.body).not.toContain('privateKey');
  });

  it('applies date range and currency filters', async () => {
    await confirmPayment(apiKey, '3.00', 'history-order-0005', '2026-02-01T09:00:00.000Z', 'USDC');
    await confirmPayment(apiKey, '2.00', 'history-order-0006', '2026-02-02T09:00:00.000Z', 'USDC');
    await confirmPayment(apiKey, '4.00', 'history-order-0007', '2026-02-02T11:00:00.000Z', 'SAT');

    const rangeOnly = await history(apiKey, '?from=2026-02-02T00:00:00.000Z&to=2026-02-02T23:59:59.000Z');
    expect(rangeOnly.json().history).toEqual([
      { date: '2026-02-02', currency: 'SAT', confirmedAmount: '4.000000', confirmedPaymentCount: 1 },
      { date: '2026-02-02', currency: 'USDC', confirmedAmount: '2.000000', confirmedPaymentCount: 1 },
    ]);
    expect(rangeOnly.json().from).toBe('2026-02-02T00:00:00.000Z');

    const usdcOnly = await history(apiKey, '?currency=USDC');
    expect(usdcOnly.json().history).toEqual([
      { date: '2026-02-01', currency: 'USDC', confirmedAmount: '3.000000', confirmedPaymentCount: 1 },
      { date: '2026-02-02', currency: 'USDC', confirmedAmount: '2.000000', confirmedPaymentCount: 1 },
    ]);
    const satOnly = await history(apiKey, '?currency=sat');
    expect(satOnly.json().history).toEqual([
      { date: '2026-02-02', currency: 'SAT', confirmedAmount: '4.000000', confirmedPaymentCount: 1 },
    ]);
    const none = await history(apiKey, '?currency=BTC');
    expect(none.json().history).toEqual([]);
    // Currency matching is case-insensitive but still validated.
    expect((await history(apiKey, '?currency=usd')).json().currency).toBe('USD');
    expect((await history(apiKey, '?currency=TOOLONGCURRENCY123')).statusCode).toBe(400);
    expect((await history(apiKey, '?from=2026-02-02T00:00:00.000Z&to=2026-02-01T00:00:00.000Z')).statusCode).toBe(400);
    expect((await history(apiKey, '?from=nonsense')).statusCode).toBe(400);
  });

  it('returns an empty history for a merchant with no confirmed payments', async () => {
    const empty = await createMerchant('No Revenue', 'no-revenue@example.com', '0x8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c');
    const response = await history(empty);
    expect(response.statusCode).toBe(200);
    expect(response.json().history).toEqual([]);
  });

  it('keeps revenue history isolated between merchants', async () => {
    const other = await createMerchant('Other History', 'other-history@example.com', '0x8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d');
    await confirmPayment(apiKey, '7.00', 'history-order-0008', '2026-03-01T09:00:00.000Z');

    expect((await history(apiKey)).json().history).toEqual([
      { date: '2026-03-01', currency: 'USDC', confirmedAmount: '7.000000', confirmedPaymentCount: 1 },
    ]);
    expect((await history(other)).json().history).toEqual([]);
  });

  it('rejects unauthenticated requests', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/revenue/history' })).statusCode).toBe(401);
  });
});
