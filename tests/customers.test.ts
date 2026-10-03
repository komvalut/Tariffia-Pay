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

  it('makes email-only creation idempotent and normalizes the email', async () => {
    const first = await createCustomer(apiKey, { email: 'Buyer@Example.com', name: 'Buyer' });
    expect(first.statusCode, first.body).toBe(201);
    const id = first.json().customer.id as string;
    expect(first.json().customer.email).toBe('buyer@example.com');

    // Exact repeat and case/whitespace variants resolve to the same customer, no duplicates.
    const repeat = await createCustomer(apiKey, { email: 'Buyer@Example.com', name: 'Buyer' });
    expect(repeat.statusCode).toBe(201);
    expect(repeat.json().customer.id).toBe(id);
    const variant = await createCustomer(apiKey, { email: '  BUYER@EXAMPLE.COM  ' });
    expect(variant.statusCode, variant.body).toBe(201);
    expect(variant.json().customer.id).toBe(id);
    expect(variant.json().customer.email).toBe('buyer@example.com');

    const listed = await list(apiKey);
    expect(listed.json().customers).toHaveLength(1);

    // A later request may update the stored name without creating a new row.
    const renamed = await createCustomer(apiKey, { email: 'buyer@example.com', name: 'Buyer Updated' });
    expect(renamed.json().customer.id).toBe(id);
    expect(renamed.json().customer.name).toBe('Buyer Updated');
    expect((await list(apiKey)).json().customers).toHaveLength(1);
  });

  it('keeps the same email isolated per merchant', async () => {
    const other = await createMerchant('Other Email Store', 'other-email@example.com', '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd');
    const mine = await createCustomer(apiKey, { email: 'shared@example.com', name: 'Mine' });
    const theirs = await createCustomer(other, { email: 'shared@example.com', name: 'Theirs' });
    expect(mine.statusCode).toBe(201);
    expect(theirs.statusCode).toBe(201);
    expect(mine.json().customer.id).not.toBe(theirs.json().customer.id);
    expect((await list(apiKey)).json().customers).toHaveLength(1);
    expect((await list(other)).json().customers).toHaveLength(1);
  });

  it('promotes an email-only customer when the same email arrives with an external id', async () => {
    const emailOnly = await createCustomer(apiKey, { email: 'ada@example.com', name: 'Ada' });
    const id = emailOnly.json().customer.id as string;

    const identified = await createCustomer(apiKey, { externalId: 'ada-1', email: 'ada@example.com', name: 'Ada Lovelace' });
    expect(identified.statusCode, identified.body).toBe(201);
    expect(identified.json().customer.id).toBe(id);
    expect(identified.json().customer.externalId).toBe('ada-1');
    expect(identified.json().customer.name).toBe('Ada Lovelace');
    expect((await list(apiKey)).json().customers).toHaveLength(1);

    // The external id is now the stable key and updates in place.
    const updated = await createCustomer(apiKey, { externalId: 'ada-1', name: 'Ada L.' });
    expect(updated.json().customer.id).toBe(id);
    expect(updated.json().customer.name).toBe('Ada L.');
    expect(updated.json().customer.email).toBe('ada@example.com');
    expect((await list(apiKey)).json().customers).toHaveLength(1);
  });

  it('keeps distinct external ids separate even when they share an email', async () => {
    const first = await createCustomer(apiKey, { externalId: 'e-1', email: 'same@example.com', name: 'One' });
    const second = await createCustomer(apiKey, { externalId: 'e-2', email: 'same@example.com', name: 'Two' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().customer.id).not.toBe(second.json().customer.id);
    expect((await list(apiKey)).json().customers).toHaveLength(2);
  });

  it('merges metadata and handles conflicting identity data safely', async () => {
    const created = await createCustomer(apiKey, { email: 'meta@example.com', metadata: { tier: 'gold', a: 1 } });
    const id = created.json().customer.id as string;

    const merged = await createCustomer(apiKey, { email: 'META@example.com', metadata: { a: 2, b: 3 } });
    expect(merged.json().customer.id).toBe(id);
    expect(merged.json().customer.metadata).toMatchObject({ tier: 'gold', a: 2, b: 3 });

    // Promoting with an external id keeps the same row and merges the new metadata.
    const promoted = await createCustomer(apiKey, { externalId: 'meta-1', email: 'meta@example.com', metadata: { c: 4 } });
    expect(promoted.json().customer.id).toBe(id);
    expect(promoted.json().customer.metadata).toMatchObject({ tier: 'gold', a: 2, b: 3, c: 4 });

    // A different external id sharing the email stays a distinct customer (no unsafe merge).
    const distinct = await createCustomer(apiKey, { externalId: 'meta-2', email: 'meta@example.com' });
    expect(distinct.json().customer.id).not.toBe(id);
    expect((await list(apiKey)).json().customers).toHaveLength(2);
  });

  it('still upserts by external id and updates the email when provided', async () => {
    const created = await createCustomer(apiKey, { externalId: 'u-1', email: 'old@example.com', name: 'Old' });
    const id = created.json().customer.id as string;
    const updated = await createCustomer(apiKey, { externalId: 'u-1', email: 'new@example.com', name: 'New' });
    expect(updated.statusCode).toBe(201);
    expect(updated.json().customer.id).toBe(id);
    expect(updated.json().customer).toMatchObject({ email: 'new@example.com', name: 'New' });
    expect((await list(apiKey)).json().customers).toHaveLength(1);
  });
});
