import { parseUnits } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { paginate, parsePagination } from '../src/pagination.js';
import type { AdapterPaymentDetails, PaymentAdapter } from '../src/payment-adapter.js';
import { PaymentAdapterRegistry } from '../src/payment-adapters/registry.js';
import { createMigratedDatabase } from './fixtures/pg-mem-database.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const usdcAddress = '0x833589fCD6eDb6E08f4c7C32d4f71b54bdA02913';

async function createDatabase(): Promise<Database> {
  return createMigratedDatabase();
}

function stubAdapter(): PaymentAdapter {
  return {
    id: 'usdc',
    manifest: {
      id: 'usdc', name: 'Base USDC', version: 'pagination', description: 'Pagination test adapter',
      capabilities: {
        paymentRequests: true, transactionVerification: true, statusPolling: false, recurringPayments: false,
        automaticDetection: true, refunds: false, paymentRequestFormat: 'wallet',
        currencies: ['USDC'], networks: ['base'],
      },
      idempotency: { paymentCreation: 'stable-key-required', transactionVerification: 'network-and-transaction-id' },
    },
    initialize: async () => {},
    shutdown: async () => {},
    health: async () => ({ status: 'healthy', message: 'Pagination adapter ready' }),
    normalizeTransactionId: (transactionId) => transactionId.toLowerCase(),
    createRequest: async (input): Promise<AdapterPaymentDetails> => ({
      adapter: 'usdc', network: 'base', currency: 'USDC',
      recipientAddress: input.recipient.toLowerCase(), tokenAddress: usdcAddress.toLowerCase(),
      amountBaseUnits: parseUnits(input.amount, 6).toString(), adapterData: { chainId: 8453, decimals: 6 },
    }),
    verifyTransaction: async () => ({ state: 'not_found' }),
  };
}

describe('pagination contract', () => {
  it('applies one default, bound and rejection policy', () => {
    expect(parsePagination({})).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination({ limit: '10', offset: '5' })).toEqual({ limit: 10, offset: 5 });
    expect(parsePagination({ limit: '100' })).toEqual({ limit: 100, offset: 0 });
    for (const invalid of [{ limit: '0' }, { limit: '101' }, { limit: '-1' }, { limit: 'abc' }, { limit: '1.5' },
      { limit: ' 5' }, { offset: '-1' }, { offset: 'x' }, { offset: '1000001' }]) {
      expect(() => parsePagination(invalid), JSON.stringify(invalid)).toThrow(/invalid_pagination|non-negative|between/);
    }
  });

  it('slices a limit+1 result set into items and metadata', () => {
    expect(paginate([1, 2, 3], 2, 0)).toEqual({
      items: [1, 2], hasMore: true, pagination: { limit: 2, offset: 0, count: 2, hasMore: true },
    });
    expect(paginate([1], 2, 0)).toEqual({
      items: [1], hasMore: false, pagination: { limit: 2, offset: 0, count: 1, hasMore: false },
    });
  });
});

describe('merchant list endpoint pagination', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let aliceKey: string;
  let bobKey: string;
  let customerId: string;
  let endpointId: string;
  let endpoints: string[];

  async function createMerchant(name: string, email: string, wallet: string): Promise<string> {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().apiKey as string;
  }

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  const get = (key: string, url: string) => app.inject({ method: 'GET', url, headers: auth(key) });

  beforeEach(async () => {
    db = await createDatabase();
    const registry = new PaymentAdapterRegistry();
    registry.register(stubAdapter(), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    app = await buildApp({ db, adapterRegistry: registry });
    aliceKey = await createMerchant('Pagination Store', 'pagination@example.com', '0x3333333333333333333333333333333333333333');
    bobKey = await createMerchant('Other Pagination', 'other-pagination@example.com', '0x4444444444444444444444444444444444444444');

    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: auth(aliceKey),
      payload: { externalId: 'page-1', email: 'page1@example.com', name: 'Page One' },
    });
    customerId = customer.json().customer.id as string;
    await app.inject({
      method: 'POST', url: '/v1/customers', headers: auth(aliceKey),
      payload: { externalId: 'page-2', name: 'Page Two' },
    });
    await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { ...auth(aliceKey), 'idempotency-key': 'pagination-order-1' },
      payload: { customerId, description: 'Pagination order', amount: '3.00', currency: 'USDC' },
    });
    await app.inject({
      method: 'POST', url: '/v1/payment-links',
      headers: { ...auth(aliceKey), 'idempotency-key': 'pagination-link-1' },
      payload: { description: 'Pagination link', amount: '5.00', currency: 'USDC' },
    });
    const webhook = await app.inject({
      method: 'POST', url: '/v1/webhooks', headers: auth(aliceKey),
      payload: { name: 'Pagination hook', url: 'https://hooks.example.test/pagination', events: ['payment.confirmed'], secret: 'whsec_' + 'p'.repeat(40) },
    });
    endpointId = webhook.json().endpoint.id as string;
    await app.inject({
      method: 'PUT', url: '/v1/settings', headers: auth(aliceKey),
      payload: { displayName: 'Pagination', supportEmail: null, defaultCurrency: 'USDC', timezone: 'UTC' },
    });

    endpoints = [
      '/v1/orders', '/v1/customers', '/v1/payment-links', '/v1/transactions',
      `/v1/credits/${customerId}/topups`, `/v1/credits/${customerId}/usage`,
      '/v1/ai/usage', '/v1/invoices', '/v1/receipts', '/v1/ledger', '/v1/webhooks',
      `/v1/webhooks/${endpointId}/deliveries`, '/v1/audit-log', '/v1/dashboard/customers',
    ];
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('serves the shared pagination metadata with a consistent default on every list endpoint', async () => {
    for (const url of endpoints) {
      const response = await get(aliceKey, url);
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
      const pagination = response.json().pagination;
      expect(pagination, `${url} is missing pagination metadata`).toBeDefined();
      expect(Object.keys(pagination).sort(), url).toEqual(['count', 'hasMore', 'limit', 'offset']);
      expect(pagination).toMatchObject({ limit: 50, offset: 0 });
      expect(typeof pagination.count).toBe('number');
      expect(typeof pagination.hasMore).toBe('boolean');
    }
  });

  it('honours a custom limit and offset on every list endpoint', async () => {
    for (const url of endpoints) {
      const response = await get(aliceKey, `${url}?limit=1&offset=1`);
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
      expect(response.json().pagination, url).toMatchObject({ limit: 1, offset: 1 });
    }
    // Offset actually skips records: one of the two customers is returned on each page.
    const first = await get(aliceKey, '/v1/customers?limit=1&offset=0');
    const second = await get(aliceKey, '/v1/customers?limit=1&offset=1');
    expect(first.json().pagination).toMatchObject({ count: 1, hasMore: true });
    expect(second.json().pagination).toMatchObject({ count: 1, hasMore: false });
    expect(first.json().customers[0].id).not.toBe(second.json().customers[0].id);
  });

  it('accepts the maximum limit and rejects invalid or too-large limits consistently', async () => {
    for (const url of endpoints) {
      const maxed = await get(aliceKey, `${url}?limit=100`);
      expect(maxed.statusCode, url).toBe(200);
      expect(maxed.json().pagination.limit, url).toBe(100);

      for (const bad of ['?limit=101', '?limit=0', '?limit=-3', '?limit=abc', '?offset=-1', '?offset=xyz']) {
        const rejected = await get(aliceKey, `${url}${bad}`);
        expect(rejected.statusCode, `${url}${bad}`).toBe(400);
        expect(rejected.json()).toMatchObject({ error: 'invalid_pagination' });
      }
    }
  });

  it('keeps existing filters working alongside pagination', async () => {
    const pending = await get(aliceKey, '/v1/orders?status=PENDING&limit=1');
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.json().pagination.limit).toBe(1);
    expect(pending.json().orders.every((order: { status: string }) => order.status === 'PENDING')).toBe(true);

    const noMatch = await get(aliceKey, '/v1/orders?status=PAID');
    expect(noMatch.statusCode, noMatch.body).toBe(200);
    expect(noMatch.json().orders).toEqual([]);
    expect(noMatch.json().pagination).toMatchObject({ count: 0, hasMore: false });

    const byNetwork = await get(aliceKey, '/v1/transactions?network=base&limit=1');
    expect(byNetwork.statusCode, byNetwork.body).toBe(200);
    expect(byNetwork.json().pagination.limit).toBe(1);
  });

  it('keeps pagination merchant-scoped', async () => {
    for (const url of ['/v1/orders', '/v1/customers', '/v1/payment-links', '/v1/transactions', '/v1/webhooks', '/v1/audit-log']) {
      const response = await get(bobKey, url);
      expect(response.statusCode, url).toBe(200);
      expect(response.json().pagination, url).toMatchObject({ count: 0, hasMore: false });
    }
    expect((await get(bobKey, `/v1/customers/${customerId}`)).statusCode).toBe(404);
  });
});
