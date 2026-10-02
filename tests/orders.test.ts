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
    verifyTransaction: async () => ({ state: 'not_found' }),
  };
}

describe('merchant order visibility', () => {
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

  const createOrder = (key: string, description: string, idempotencyKey: string, reference?: string) => app.inject({
    method: 'POST', url: '/v1/orders',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey },
    payload: { description, amount: '9.99', currency: 'USDC', ...(reference ? { reference } : {}) },
  });
  const list = (key: string, query = '') => app.inject({ method: 'GET', url: `/v1/orders${query}`, headers: { authorization: `Bearer ${key}` } });
  const detail = (key: string, id: string) => app.inject({ method: 'GET', url: `/v1/orders/${id}`, headers: { authorization: `Bearer ${key}` } });

  beforeEach(async () => {
    db = await createDatabase();
    const registry = new PaymentAdapterRegistry();
    registry.register(stubAdapter(), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    app = await buildApp({ db, adapterRegistry: registry });
    apiKey = await createMerchant('Order Store', 'orders@example.com', '0x5656565656565656565656565656565656565656');
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('lists and reads order details with order and payment status', async () => {
    const first = await createOrder(apiKey, 'First order', 'order-create-0001', 'ref-001');
    expect(first.statusCode, first.body).toBe(201);
    const firstId = first.json().order.id as string;
    await createOrder(apiKey, 'Second order', 'order-create-0002');

    const listed = await list(apiKey);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().orders).toHaveLength(2);
    const entry = listed.json().orders.find((order: { id: string }) => order.id === firstId);
    expect(entry).toMatchObject({
      reference: 'ref-001', description: 'First order', amount: '9.99', currency: 'USDC',
      status: 'PENDING', paymentStatus: 'PENDING',
    });
    expect(entry.createdAt).toBeTruthy();
    expect(entry.updatedAt).toBeTruthy();
    expect(entry.paymentId).toBeTruthy();

    const one = await detail(apiKey, firstId);
    expect(one.statusCode).toBe(200);
    expect(one.json().order).toMatchObject({
      id: firstId, reference: 'ref-001', description: 'First order', amount: '9.99', currency: 'USDC',
      status: 'PENDING', paymentStatus: 'PENDING',
    });
    expect(one.json().order.updatedAt).toBeTruthy();
  });

  it('filters by order status and rejects unknown status filters', async () => {
    const created = await createOrder(apiKey, 'Filterable', 'order-create-0003');
    const status = created.json().order.status as string;

    const filtered = await list(apiKey, `?status=${status}`);
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().orders).toHaveLength(1);
    expect(filtered.json().orders[0].status).toBe(status);
    const otherStatus = status === 'CREATED' ? 'PAID' : 'CREATED';
    expect((await list(apiKey, `?status=${otherStatus}`)).json().orders).toHaveLength(0);
    expect((await list(apiKey, '?status=NOT_A_STATUS')).statusCode).toBe(400);
  });

  it('returns only documented status values', async () => {
    await createOrder(apiKey, 'Statuses', 'order-create-0004');
    const order = (await list(apiKey)).json().orders[0];
    expect(['CREATED', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED']).toContain(order.status);
    expect(['CREATED', 'PENDING', 'DETECTED', 'VERIFYING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'REFUNDED']).toContain(order.paymentStatus);
  });

  it('keeps orders isolated between merchants', async () => {
    const other = await createMerchant('Other Orders', 'other-orders@example.com', '0x7878787878787878787878787878787878787878');
    const created = await createOrder(apiKey, 'Mine', 'order-create-0005');
    const orderId = created.json().order.id as string;
    await createOrder(other, 'Theirs', 'order-create-0006');

    expect((await list(other)).json().orders).toHaveLength(1);
    expect((await list(other)).json().orders[0].description).toBe('Theirs');
    expect((await detail(other, orderId)).statusCode).toBe(404);
    expect((await detail(apiKey, orderId)).json().order.description).toBe('Mine');
  });

  it('rejects unauthenticated requests and missing orders', async () => {
    const created = await createOrder(apiKey, 'Guarded', 'order-create-0007');
    const orderId = created.json().order.id as string;

    expect((await app.inject({ method: 'GET', url: '/v1/orders' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/v1/orders/${orderId}` })).statusCode).toBe(401);
    expect((await detail(apiKey, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).statusCode).toBe(404);
  });
});
