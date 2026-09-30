import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';

describe('Phase 1 merchant API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: Database;
  let pool: Pool;

  beforeEach(async () => {
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    const pgAdapter = memory.adapters.createPg();
    pool = new pgAdapter.Pool() as Pool;
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
    let migration = await readFile(path.join(migrationsDir, '0001_phase1.sql'), 'utf8');
    migration = migration.split('CREATE OR REPLACE FUNCTION reject_ledger_mutation()')[0] ?? migration;
    await pool.query(migration);

    db = {
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
    app = await buildApp({ db });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('creates merchant credentials, a customer, and an idempotent order/payment/ledger record', async () => {
    const merchantResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: {
        name: 'Example Store',
        email: 'OWNER@example.com',
        walletAddress: '0x1111111111111111111111111111111111111111',
      },
    });
    expect(merchantResponse.statusCode).toBe(201);
    const { merchant, apiKey } = merchantResponse.json();
    expect(apiKey).toMatch(/^tf_live_/);

    const customerResponse = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'customer-1', email: 'buyer@example.com' },
    });
    expect(customerResponse.statusCode).toBe(201);
    const customerId = customerResponse.json().customer.id as string;

    const payload = {
      customerId,
      reference: 'receipt-001',
      description: 'Coffee',
      amount: '4.50',
      currency: 'USDC',
    };
    const orderResponse = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'checkout-order-0001' },
      payload,
    });
    expect(orderResponse.statusCode).toBe(201);
    expect(orderResponse.headers['idempotency-replayed']).toBe('false');
    const created = orderResponse.json();
    expect(Number(created.order.amount)).toBe(4.5);
    expect(created.order.status).toBe('PENDING');
    expect(created.payment.status).toBe('PENDING');

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'checkout-order-0001' },
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().order.id).toBe(created.order.id);
    expect(replay.json().payment.id).toBe(created.payment.id);

    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'checkout-order-0001' },
      payload: { ...payload, amount: '5.00' },
    });
    expect(conflict.statusCode).toBe(409);

    const ledger = await app.inject({
      method: 'GET',
      url: '/v1/ledger',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().entries).toHaveLength(1);
    expect(ledger.json().entries[0].entryType).toBe('PAYMENT_CREATED');
    expect(Number(ledger.json().entries[0].amount)).toBe(4.5);

    expect(merchant.id).toBeTruthy();
  });

  it('does not permit merchant creation without the admin secret', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/admin/merchants', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('lists API key metadata without exposing hashes and supports revocation', async () => {
    const merchant = await app.inject({
      method: 'POST',
      url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Key Store', email: 'keys@example.com', walletAddress: '0x3333333333333333333333333333333333333333' },
    });
    const firstKey = merchant.json().apiKey as string;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${firstKey}` },
      payload: { name: 'CI deploy' },
    });
    expect(created.statusCode).toBe(201);
    const secondKey = created.json().secret as string;
    const keyId = created.json().apiKey.id as string;
    const list = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: { authorization: `Bearer ${firstKey}` } });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(secondKey);
    expect(JSON.stringify(list.json())).not.toContain('key_hash');

    const revoked = await app.inject({ method: 'DELETE', url: `/v1/api-keys/${keyId}`, headers: { authorization: `Bearer ${firstKey}` } });
    expect(revoked.statusCode).toBe(204);
    const rejected = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: { authorization: `Bearer ${secondKey}` } });
    expect(rejected.statusCode).toBe(401);
  });

  it('does not expose customers to a different merchant', async () => {
    const createMerchant = async (email: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/admin/merchants',
        headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
        payload: { name: 'Store', email, walletAddress: '0x2222222222222222222222222222222222222222' },
      });
      return response.json().apiKey as string;
    };
    const firstKey = await createMerchant('first@example.com');
    const secondKey = await createMerchant('second@example.com');
    const customer = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${firstKey}` },
      payload: { externalId: 'private-customer' },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customer.json().customer.id}`,
      headers: { authorization: `Bearer ${secondKey}` },
    });
    expect(response.statusCode).toBe(404);

    const order = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${firstKey}`, 'idempotency-key': 'first-store-order-01' },
      payload: { description: 'Private order', amount: '1.00' },
    });
    const otherMerchantOrder = await app.inject({
      method: 'GET',
      url: `/v1/orders/${order.json().order.id}`,
      headers: { authorization: `Bearer ${secondKey}` },
    });
    expect(otherMerchantOrder.statusCode).toBe(404);
  });
});
