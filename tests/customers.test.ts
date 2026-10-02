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

describe('merchant customer visibility', () => {
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

  const createCustomer = (key: string, payload: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${key}` }, payload,
  });
  const list = (key: string) => app.inject({ method: 'GET', url: '/v1/customers', headers: { authorization: `Bearer ${key}` } });
  const detail = (key: string, id: string) => app.inject({ method: 'GET', url: `/v1/customers/${id}`, headers: { authorization: `Bearer ${key}` } });

  beforeEach(async () => {
    db = await createDatabase();
    const registry = new PaymentAdapterRegistry();
    registry.register(stubAdapter(), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    app = await buildApp({ db, adapterRegistry: registry });
    apiKey = await createMerchant('Customer Store', 'customers@example.com', '0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a');
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('lists and reads customer details with basic order and payment counts', async () => {
    const withOrders = await createCustomer(apiKey, { externalId: 'cust-1', name: 'Ada', email: 'ada@example.com' });
    expect(withOrders.statusCode, withOrders.body).toBe(201);
    const customerId = withOrders.json().customer.id as string;
    await createCustomer(apiKey, { externalId: 'cust-2', name: 'Grace' });

    // One order for the first customer, so its counts are non-zero.
    const order = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'customer-order-0001' },
      payload: { customerId, description: 'Customer order', amount: '5.00', currency: 'USDC' },
    });
    expect(order.statusCode, order.body).toBe(201);

    const listed = await list(apiKey);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().customers).toHaveLength(2);
    const entry = listed.json().customers.find((customer: { id: string }) => customer.id === customerId);
    expect(entry).toMatchObject({ name: 'Ada', email: 'ada@example.com', externalId: 'cust-1', orderCount: 1, paymentCount: 1 });
    expect(entry.createdAt).toBeTruthy();
    const empty = listed.json().customers.find((customer: { externalId: string }) => customer.externalId === 'cust-2');
    expect(empty).toMatchObject({ orderCount: 0, paymentCount: 0 });
    expect(listed.body).not.toContain('wallet_address');

    const one = await detail(apiKey, customerId);
    expect(one.statusCode).toBe(200);
    expect(one.json().customer).toMatchObject({ id: customerId, name: 'Ada', orderCount: 1, paymentCount: 1 });
    expect(one.json().customer.createdAt).toBeTruthy();
  });

  it('keeps customers isolated between merchants', async () => {
    const other = await createMerchant('Other Customers', 'other-customers@example.com', '0xbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc');
    const mine = await createCustomer(apiKey, { externalId: 'mine-1', name: 'Mine' });
    const customerId = mine.json().customer.id as string;
    await createCustomer(other, { externalId: 'theirs-1', name: 'Theirs' });

    const otherList = await list(other);
    expect(otherList.json().customers).toHaveLength(1);
    expect(otherList.json().customers[0].name).toBe('Theirs');
    expect(otherList.body).not.toContain(customerId);
    expect((await detail(other, customerId)).statusCode).toBe(404);
    expect((await detail(apiKey, customerId)).json().customer.name).toBe('Mine');
  });

  it('creates customers through the existing API', async () => {
    expect((await createCustomer(apiKey, { externalId: 'new-1', name: 'First' })).statusCode).toBe(201);
    const second = await createCustomer(apiKey, { externalId: 'new-2', email: 'second@example.com' });
    expect(second.statusCode).toBe(201);
    expect(second.json().customer).toMatchObject({ externalId: 'new-2', email: 'second@example.com' });
    const listed = await list(apiKey);
    expect(listed.json().customers).toHaveLength(2);
  });

  it('rejects unauthenticated requests and missing customers', async () => {
    const created = await createCustomer(apiKey, { externalId: 'guarded-1' });
    const customerId = created.json().customer.id as string;
    expect((await app.inject({ method: 'GET', url: '/v1/customers' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/v1/customers/${customerId}` })).statusCode).toBe(401);
    expect((await detail(apiKey, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).statusCode).toBe(404);
  });
});
