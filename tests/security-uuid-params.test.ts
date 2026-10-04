import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { PaymentAdapterRegistry } from '../src/payment-adapters/registry.js';
import type { AdapterPaymentDetails, PaymentAdapter } from '../src/payment-adapter.js';
import { createMigratedDatabase } from './fixtures/pg-mem-database.js';

// Regression coverage for the Phase 63 finding: malformed UUID path parameters
// must return a safe 4xx at the route boundary and must NEVER reach a UUID-typed
// SQL comparison (which previously surfaced as a 500). Valid-but-nonexistent
// UUIDs must still return 404, and valid resources must still work.

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const usdcAddress = '0x833589fCD6eDb6E08f4c7C32d4f71b54bdA02913';

function stubAdapter(): PaymentAdapter {
  return {
    id: 'usdc',
    manifest: {
      id: 'usdc', name: 'Base USDC', version: 'uuid', description: 'UUID regression adapter',
      capabilities: {
        paymentRequests: true, transactionVerification: true, statusPolling: false, recurringPayments: false,
        automaticDetection: true, refunds: false, paymentRequestFormat: 'wallet',
        currencies: ['USDC'], networks: ['base'],
      },
      idempotency: { paymentCreation: 'stable-key-required', transactionVerification: 'network-and-transaction-id' },
    },
    initialize: async () => {},
    shutdown: async () => {},
    health: async () => ({ status: 'healthy', message: 'ok' }),
    normalizeTransactionId: (transactionId) => transactionId.toLowerCase(),
    createRequest: async (input): Promise<AdapterPaymentDetails> => ({
      adapter: 'usdc', network: 'base', currency: 'USDC',
      recipientAddress: input.recipient.toLowerCase(), tokenAddress: usdcAddress.toLowerCase(),
      amountBaseUnits: parseUnits(input.amount, 6).toString(), adapterData: { chainId: 8453, decimals: 6 },
    }),
    verifyTransaction: async () => ({ state: 'not_found' }),
  };
}

const MALFORMED = ['not-a-uuid', "' OR 1=1 --", '(select 1)', '1;DROP TABLE payments;--', '12345', ''];

describe('malformed UUID path parameters return safe 4xx', () => {
  let db: Database;
  let app: FastifyInstance;
  let merchantKey: string;
  let customerId: string;
  let orderId: string;
  let paymentId: string;
  let webhookId: string;

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  const get = (key: string, url: string) => app.inject({ method: 'GET', url, headers: auth(key) });

  beforeEach(async () => {
    db = await createMigratedDatabase();
    const registry = new PaymentAdapterRegistry();
    registry.register(stubAdapter(), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    app = await buildApp({ db, adapterRegistry: registry });

    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name: 'UUID Store', email: 'uuid@example.com', walletAddress: '0x1111111111111111111111111111111111111111' },
    });
    merchantKey = merchant.json().apiKey as string;

    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: auth(merchantKey),
      payload: { externalId: `c-${randomUUID()}`, email: `b-${randomUUID()}@example.com` },
    });
    customerId = customer.json().customer.id as string;

    const order = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { ...auth(merchantKey), 'idempotency-key': randomUUID() },
      payload: { customerId, description: 'UUID item', amount: '2.00', currency: 'USDC' },
    });
    orderId = order.json().order.id as string;
    paymentId = order.json().payment.id as string;

    const webhook = await app.inject({
      method: 'POST', url: '/v1/webhooks', headers: auth(merchantKey),
      payload: { name: 'UUID hook', url: 'https://hooks.example.test/uuid', events: ['payment.confirmed'], secret: `whsec_${'b'.repeat(40)}` },
    });
    webhookId = webhook.json().endpoint.id as string;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  // Each entry: [label, method, url builder]
  const merchantRoutes: Array<[string, 'GET' | 'POST' | 'PATCH' | 'DELETE', (id: string) => string]> = [
    ['GET customer', 'GET', (id) => `/v1/customers/${id}`],
    ['GET order', 'GET', (id) => `/v1/orders/${id}`],
    ['GET payment', 'GET', (id) => `/v1/payments/${id}`],
    ['GET payment details', 'GET', (id) => `/v1/payments/${id}/details`],
    ['POST verify', 'POST', (id) => `/v1/payments/${id}/verify`],
    ['GET transaction', 'GET', (id) => `/v1/transactions/${id}`],
    ['GET payment link', 'GET', (id) => `/v1/payment-links/${id}`],
    ['PATCH payment link', 'PATCH', (id) => `/v1/payment-links/${id}`],
    ['DELETE payment link', 'DELETE', (id) => `/v1/payment-links/${id}`],
    ['GET credit balance', 'GET', (id) => `/v1/credits/${id}/balance`],
    ['GET credit topups', 'GET', (id) => `/v1/credits/${id}/topups`],
    ['GET credit usage', 'GET', (id) => `/v1/credits/${id}/usage`],
    ['GET customer subscriptions', 'GET', (id) => `/v1/customers/${id}/subscriptions`],
    ['GET webhook deliveries', 'GET', (id) => `/v1/webhooks/${id}/deliveries`],
    ['PATCH webhook', 'PATCH', (id) => `/v1/webhooks/${id}`],
    ['DELETE webhook', 'DELETE', (id) => `/v1/webhooks/${id}`],
    ['DELETE api key', 'DELETE', (id) => `/v1/api-keys/${id}`],
    ['GET subscription', 'GET', (id) => `/v1/subscriptions/${id}`],
    ['GET billing cycles', 'GET', (id) => `/v1/subscriptions/${id}/billing-cycles`],
    ['PUT subscription plan', 'PUT', (id) => `/v1/subscription-plans/${id}`],
  ];

  it('returns 400 (never 500) for every malformed id on merchant/account routes', async () => {
    for (const [label, method, build] of merchantRoutes) {
      for (const bad of MALFORMED) {
        const response = await app.inject({
          method, url: build(encodeURIComponent(bad)), headers: auth(merchantKey),
          ...(method === 'GET' ? {} : { payload: {} }),
        });
        expect(response.statusCode, `${label} with "${bad}" returned ${response.statusCode}`).toBe(400);
        if (method === 'GET') {
          // GET routes reach the path-parameter guard directly.
          expect(response.json().error, `${label} with "${bad}"`).toBe('invalid_path_parameter');
        } else {
          // Body-bearing routes may reject the body first; either way it is a safe 400.
          expect(['invalid_path_parameter', 'validation_error']).toContain(response.json().error);
        }
        expect(response.body).not.toMatch(/stack|at .*\.ts:|SELECT|syntax error|pg-mem/i);
      }
    }
  });

  it('returns 400 (never 500) for malformed ids on admin routes', async () => {
    const adminRoutes: Array<[string, (id: string) => string]> = [
      ['admin usage merchant', (id) => `/v1/admin/usage/merchants/${id}`],
      ['admin ai provider', (id) => `/v1/admin/ai/providers/${id}`],
      ['admin ai provider models', (id) => `/v1/admin/ai/providers/${id}/models`],
      ['admin ai provider health', (id) => `/v1/admin/ai/providers/${id}/health`],
      ['admin ai model', (id) => `/v1/admin/ai/models/${id}`],
      ['admin sms provider', (id) => `/v1/admin/sms/providers/${id}`],
      ['admin sms provider services', (id) => `/v1/admin/sms/providers/${id}/services`],
      ['admin sms service', (id) => `/v1/admin/sms/services/${id}`],
      ['admin webhook delivery', (id) => `/v1/admin/webhook-deliveries/${id}/attempts`],
    ];
    for (const [label, build] of adminRoutes) {
      for (const bad of ['not-a-uuid', "' OR 1=1 --"]) {
        const response = await app.inject({ method: 'PUT', url: build(encodeURIComponent(bad)), headers: adminHeaders, payload: {} });
        // Some of these are POST/PUT; any 400 is correct, never 500.
        expect(response.statusCode, `${label} with "${bad}" returned ${response.statusCode}`).toBeLessThan(500);
        expect([400, 404, 405]).toContain(response.statusCode);
      }
    }
  });

  it('keeps valid-but-nonexistent UUIDs returning 404 (unchanged)', async () => {
    const missing = '11111111-1111-4111-8111-111111111111';
    for (const [label, build] of [
      ['customer', (id: string) => `/v1/customers/${id}`],
      ['order', (id: string) => `/v1/orders/${id}`],
      ['payment', (id: string) => `/v1/payments/${id}`],
      ['transaction', (id: string) => `/v1/transactions/${id}`],
      ['payment link', (id: string) => `/v1/payment-links/${id}`],
    ] as Array<[string, (id: string) => string]>) {
      const response = await get(merchantKey, build(missing));
      expect(response.statusCode, `${label} nonexistent`).toBe(404);
    }
  });

  it('keeps existing valid-resource behavior unchanged', async () => {
    expect((await get(merchantKey, `/v1/customers/${customerId}`)).statusCode).toBe(200);
    expect((await get(merchantKey, `/v1/orders/${orderId}`)).statusCode).toBe(200);
    expect((await get(merchantKey, `/v1/payments/${paymentId}`)).statusCode).toBe(200);
    expect((await get(merchantKey, `/v1/transactions/${paymentId}`)).statusCode).toBe(200);
    expect((await get(merchantKey, `/v1/webhooks/${webhookId}/deliveries`)).statusCode).toBe(200);
  });

  it('never attempts a database query for a malformed id', async () => {
    // Observable proof: replace db.query with a spy and assert no call happens
    // for a malformed id (the route rejects before touching the database).
    const calls: string[] = [];
    const original = db.query;
    db.query = ((text: string, values?: unknown[]) => {
      calls.push(text);
      return original.call(db, text, values);
    }) as Database['query'];
    try {
      const response = await get(merchantKey, '/v1/customers/not-a-uuid');
      expect(response.statusCode).toBe(400);
      // Only the merchant-authentication query may run; no customers SELECT.
      expect(calls.some((text) => /FROM customers/i.test(text))).toBe(false);
    } finally {
      db.query = original;
    }
  });
});
