import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { PaymentAdapterRegistry } from '../src/payment-adapters/registry.js';
import type { AdapterPaymentDetails, PaymentAdapter } from '../src/payment-adapter.js';
import { createMigratedDatabase } from './fixtures/pg-mem-database.js';

// Adversarial security invariants asserted against the REAL HTTP surface
// (app.inject), not a mock. These tests attack the running app: cross-tenant
// access, scope escalation, admin/merchant boundary, secret leakage and hostile
// input. They must never be weakened to pass.
//
// If any assertion here fails, it indicates a genuine vulnerability and must be
// reported, not patched silently.

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const usdcAddress = '0x833589fCD6eDb6E08f4c7C32d4f71b54bdA02913';

function stubAdapter(): PaymentAdapter {
  return {
    id: 'usdc',
    manifest: {
      id: 'usdc', name: 'Base USDC', version: 'sec', description: 'Security test adapter',
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

type Merchant = { apiKey: string; merchantId: string; customerId: string; orderId: string; paymentId: string; linkId: string; webhookId: string };

describe('adversarial security invariants', () => {
  let db: Database;
  let app: FastifyInstance;
  let alice: Merchant;
  let bob: Merchant;
  let aliceKeyId: string;
  let aliceWebhookSecret: string;

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  const get = (key: string, url: string) => app.inject({ method: 'GET', url, headers: auth(key) });

  async function provisionMerchant(name: string, wallet: string): Promise<{ apiKey: string; merchantId: string }> {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email: `${name.toLowerCase().replace(/\s+/g, '-')}@example.com`, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return { apiKey: response.json().apiKey as string, merchantId: response.json().merchant.id as string };
  }

  async function seedMerchant(apiKey: string): Promise<Omit<Merchant, 'apiKey' | 'merchantId'>> {
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: auth(apiKey),
      payload: { externalId: `c-${randomUUID()}`, email: `buyer-${randomUUID()}@example.com`, name: 'Buyer' },
    });
    expect(customer.statusCode, customer.body).toBe(201);
    const customerId = customer.json().customer.id as string;

    const order = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { ...auth(apiKey), 'idempotency-key': randomUUID() },
      payload: { customerId, reference: `r-${randomUUID()}`, description: 'Sec item', amount: '3.00', currency: 'USDC' },
    });
    expect(order.statusCode, order.body).toBe(201);
    const orderId = order.json().order.id as string;
    const paymentId = order.json().payment.id as string;

    const link = await app.inject({
      method: 'POST', url: '/v1/payment-links',
      headers: { ...auth(apiKey), 'idempotency-key': randomUUID() },
      payload: { description: 'Sec link', amount: '5.00', currency: 'USDC' },
    });
    expect(link.statusCode, link.body).toBe(201);
    const linkId = link.json().payment.id as string;

    const webhook = await app.inject({
      method: 'POST', url: '/v1/webhooks', headers: auth(apiKey),
      payload: { name: 'Sec hook', url: 'https://hooks.example.test/sec', events: ['payment.confirmed'], secret: `whsec_${'a'.repeat(40)}` },
    });
    expect(webhook.statusCode, webhook.body).toBe(201);
    const webhookId = webhook.json().endpoint.id as string;

    return { customerId, orderId, paymentId, linkId, webhookId };
  }

  beforeEach(async () => {
    db = await createMigratedDatabase();
    const registry = new PaymentAdapterRegistry();
    registry.register(stubAdapter(), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    app = await buildApp({ db, adapterRegistry: registry });

    const aliceCreds = await provisionMerchant('Alice Store', '0x1111111111111111111111111111111111111111');
    const bobCreds = await provisionMerchant('Bob Store', '0x2222222222222222222222222222222222222222');
    const aliceSeed = await seedMerchant(aliceCreds.apiKey);
    const bobSeed = await seedMerchant(bobCreds.apiKey);
    alice = { ...aliceCreds, ...aliceSeed };
    bob = { ...bobCreds, ...bobSeed };

    // A second Alice-scoped key that we will revoke and one to create secrets with.
    const createdKey = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: auth(alice.apiKey), payload: { name: 'sec' } });
    aliceKeyId = createdKey.json().apiKey.id as string;
    aliceWebhookSecret = `whsec_${'a'.repeat(40)}`;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  // 1. Cross-tenant IDOR / isolation sweep -------------------------------------
  it('never lets one merchant read another merchant-scoped resource', async () => {
    const detailRoutes: Array<[string, string]> = [
      ['customer', `/v1/customers/${alice.customerId}`],
      ['order', `/v1/orders/${alice.orderId}`],
      ['payment', `/v1/payments/${alice.paymentId}`],
      ['payment details', `/v1/payments/${alice.paymentId}/details`],
      ['transaction', `/v1/transactions/${alice.paymentId}`],
      ['payment link', `/v1/payment-links/${alice.linkId}`],
      ['credit balance', `/v1/credits/${alice.customerId}/balance`],
      ['credit topups', `/v1/credits/${alice.customerId}/topups`],
      ['credit usage', `/v1/credits/${alice.customerId}/usage`],
      ['customer subscriptions', `/v1/customers/${alice.customerId}/subscriptions`],
    ];
    for (const [label, url] of detailRoutes) {
      const response = await get(bob.apiKey, url);
      expect(response.statusCode, `Bob must not read Alice's ${label} (${url}) — got ${response.statusCode}: ${response.body}`).toBe(404);
      expect(response.body).not.toContain(alice.customerId);
      expect(response.body).not.toContain(alice.paymentId);
    }

    // Per-endpoint delivery history is merchant-scoped: a foreign endpoint must
    // not expose any of its deliveries (an empty result is acceptable; another
    // merchant's deliveries are not).
    const deliveries = await get(bob.apiKey, `/v1/webhooks/${alice.webhookId}/deliveries`);
    expect([200, 404]).toContain(deliveries.statusCode);
    expect(deliveries.body).not.toContain(alice.webhookId);
    expect(deliveries.json().deliveries ?? []).toEqual([]);
  });

  it('never lets one merchant mutate another merchant-scoped resource', async () => {
    const attempts = [
      app.inject({ method: 'PATCH', url: `/v1/payment-links/${alice.linkId}`, headers: auth(bob.apiKey), payload: { enabled: false } }),
      app.inject({ method: 'DELETE', url: `/v1/payment-links/${alice.linkId}`, headers: auth(bob.apiKey) }),
      app.inject({ method: 'PATCH', url: `/v1/webhooks/${alice.webhookId}`, headers: auth(bob.apiKey), payload: { enabled: false } }),
      app.inject({ method: 'DELETE', url: `/v1/webhooks/${alice.webhookId}`, headers: auth(bob.apiKey) }),
      app.inject({ method: 'DELETE', url: `/v1/api-keys/${aliceKeyId}`, headers: auth(bob.apiKey) }),
      app.inject({ method: 'POST', url: `/v1/payments/${alice.paymentId}/verify`, headers: auth(bob.apiKey), payload: { transactionId: 'testnet-mock' } }),
    ];
    for (const attempt of attempts) {
      const response = await attempt;
      expect([404, 403], `cross-tenant mutation returned ${response.statusCode}`).toContain(response.statusCode);
    }
    // Alice's resources are untouched by Bob's attempts.
    expect((await get(alice.apiKey, `/v1/payment-links/${alice.linkId}`)).json().paymentLink.enabled).toBe(true);
    expect((await get(alice.apiKey, '/v1/api-keys')).json().apiKeys.find((k: { id: string }) => k.id === aliceKeyId).status).toBe('active');
  });

  it('never includes another merchant records in list endpoints', async () => {
    const listRoutes = [
      '/v1/customers', '/v1/orders', '/v1/transactions', '/v1/payment-links',
      '/v1/webhooks', '/v1/audit-log', '/v1/invoices', '/v1/receipts', '/v1/ledger',
      '/v1/dashboard/customers', '/v1/dashboard/orders', '/v1/dashboard/payments',
    ];
    for (const url of listRoutes) {
      const response = await get(bob.apiKey, url);
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
      expect(response.body, `${url} must not leak Alice's customer`).not.toContain(alice.customerId);
      expect(response.body, `${url} must not leak Alice's payment`).not.toContain(alice.paymentId);
    }
  });

  // 2. API-key scope escalation ------------------------------------------------
  it('denies out-of-scope routes with 403 and never escalates to other areas', async () => {
    const narrow = await app.inject({
      method: 'POST', url: '/v1/api-keys', headers: auth(alice.apiKey),
      payload: { name: 'customers reader', scopes: ['customers:read'] },
    });
    expect(narrow.statusCode, narrow.body).toBe(201);
    const narrowKey = narrow.json().secret as string;

    // Allowed: its own read area.
    expect((await get(narrowKey, '/v1/customers')).statusCode).toBe(200);
    // Denied: write in the same area, and every unrelated area (both directions).
    const denied: Array<[string, string, unknown?]> = [
      ['POST', '/v1/customers', { externalId: 'x', email: 'x@example.com' }],
      ['GET', '/v1/settings', undefined],
      ['GET', '/v1/orders', undefined],
      ['GET', '/v1/transactions', undefined],
      ['GET', '/v1/ai/models', undefined],
      ['GET', '/v1/usage', undefined],
      ['GET', '/v1/api-keys', undefined],
      ['GET', '/v1/audit-log', undefined],
      ['GET', '/v1/webhooks', undefined],
      ['GET', '/v1/revenue/summary', undefined],
    ];
    for (const [method, url, payload] of denied) {
      const response = await app.inject({ method: method as 'GET', url, headers: auth(narrowKey), ...(payload === undefined ? {} : { payload }) });
      expect(response.statusCode, `${method} ${url} must be denied`).toBe(403);
      expect(response.json().error).toBe('insufficient_scope');
    }
    // A write scope does not grant an unrelated area's write.
    const writer = await app.inject({
      method: 'POST', url: '/v1/api-keys', headers: auth(alice.apiKey),
      payload: { name: 'settings writer', scopes: ['settings:write'] },
    });
    const writerKey = writer.json().secret as string;
    expect((await app.inject({ method: 'PUT', url: '/v1/settings', headers: auth(writerKey), payload: { displayName: 'x', supportEmail: null, defaultCurrency: 'USDC', timezone: 'UTC' } })).statusCode).toBe(200);
    expect((await get(writerKey, '/v1/customers')).statusCode).toBe(403);
  });

  it('rejects a revoked key with 401 and does not resurrect it', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: auth(alice.apiKey), payload: { name: 'revocable' } });
    const key = created.json().secret as string;
    const id = created.json().apiKey.id as string;
    expect((await get(key, '/v1/customers')).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/v1/api-keys/${id}`, headers: auth(alice.apiKey) })).statusCode).toBe(204);
    expect((await get(key, '/v1/customers')).statusCode).toBe(401);
  });

  // 3. Admin / merchant authentication boundary --------------------------------
  it('rejects a merchant key on every admin route and the admin key as a merchant', async () => {
    const adminRoutes: Array<[string, string]> = [
      ['POST', '/v1/admin/merchants'],
      ['GET', '/v1/admin/dashboard/overview'],
      ['GET', '/v1/admin/credits/settings'],
      ['GET', '/v1/admin/ai/providers'],
      ['GET', '/v1/admin/sms/providers'],
      ['GET', '/v1/admin/usage/merchants'],
      ['GET', '/v1/admin/webhook-deliveries'],
      ['GET', '/v1/admin/subscriptions'],
      ['GET', '/v1/admin/invoices'],
      ['GET', '/v1/admin/receipts'],
      ['GET', '/v1/admin/audit-log'],
      ['GET', '/v1/admin/payment-adapters'],
      ['GET', '/v1/health'],
    ];
    for (const [method, url] of adminRoutes) {
      const response = await app.inject({ method: method as 'GET', url, headers: auth(alice.apiKey) });
      expect(response.statusCode, `merchant key must not reach ${method} ${url}`).toBe(401);
    }
    // The admin key is not a merchant bearer credential.
    expect((await app.inject({ method: 'GET', url: '/v1/customers', headers: { authorization: `Bearer ${adminHeaders['x-admin-api-key']}` } })).statusCode).toBe(401);
    // A missing admin header is rejected on an existing admin route.
    expect((await app.inject({ method: 'GET', url: '/v1/admin/dashboard/overview' })).statusCode).toBe(401);
  });

  // 4. Secret-leak sweep -------------------------------------------------------
  it('never leaks secrets in representative merchant and admin responses', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: auth(alice.apiKey), payload: { name: 'secret probe' } });
    const apiKeySecret = created.json().secret as string;
    const apiKeyPrefix = created.json().apiKey.prefix as string;

    const merchantRoutes = [
      '/v1/customers', '/v1/orders', '/v1/payments/' + alice.paymentId, '/v1/transactions',
      '/v1/payment-links', '/v1/webhooks', `/v1/webhooks/${alice.webhookId}/deliveries`,
      '/v1/api-keys', '/v1/audit-log', '/v1/settings', '/v1/notification-preferences',
      '/v1/usage', '/v1/revenue/summary', '/v1/dashboard/overview', '/v1/dashboard/customers',
    ];
    const adminRoutes = [
      '/v1/admin/dashboard/overview', '/v1/admin/dashboard/merchants', '/v1/admin/ai/providers',
      '/v1/admin/sms/providers', '/v1/admin/payment-adapters', '/v1/admin/audit-log',
      '/v1/admin/usage/merchants', '/v1/admin/webhook-deliveries',
    ];
    const forbidden = [
      apiKeySecret, aliceWebhookSecret, apiKeyPrefix + 'fullkey',
      'API_KEY_PEPPER', 'dev-admin-key-change-this-before-deploy',
      'postgres://', 'whsec_', '-----BEGIN', 'privateKey', 'private_key',
    ];
    const responses = [
      ...merchantRoutes.map((url) => ({ url, response: get(alice.apiKey, url) })),
      ...adminRoutes.map((url) => ({ url, response: app.inject({ method: 'GET', url, headers: adminHeaders }) })),
    ];
    for (const { url, response } of responses) {
      const result = await response;
      for (const secret of forbidden) {
        expect(result.body, `${url} leaked "${secret}"`).not.toContain(secret);
      }
      // Hashes and ciphertext columns must never appear in responses.
      expect(result.body, `${url} exposed internal column names`).not.toMatch(/key_hash|secret_ciphertext|secret_nonce|secret_auth_tag|macaroon/i);
    }
    // The one-time API key secret is exposed exactly once, on its creation response.
    expect(created.body).toContain(apiKeySecret);
    expect((await get(alice.apiKey, '/v1/api-keys')).body).not.toContain(apiKeySecret);
  });

  // 5. Hostile input / path / body robustness ----------------------------------
  it('returns safe 4xx (never 500) and no internals for hostile input', async () => {
    const hostilePaths = [
      "/v1/customers/' OR 1=1 --",
      '/v1/customers/%00%00',
      '/v1/customers/' + 'a'.repeat(5000),
      '/v1/customers/../../etc/passwd',
      '/v1/customers/🚀🚀🚀',
      '/v1/payments/(select 1)',
      '/v1/orders/1;DROP TABLE payments;--',
    ];
    for (const url of hostilePaths) {
      const response = await get(alice.apiKey, url);
      // Any safe client error is acceptable (400 malformed id, 404 not found,
      // 414 path too long); a 5xx or an internal leak is not.
      expect(response.statusCode, `${url} returned ${response.statusCode}`).toBeGreaterThanOrEqual(400);
      expect(response.statusCode, `${url} returned ${response.statusCode}`).toBeLessThan(500);
      expect(response.body).not.toMatch(/stack|at .*\.ts:|SELECT|syntax error|pg-mem/i);
    }

    // Malformed / hostile bodies never 500 and never leak internals.
    const hostileBodies: Array<[string, unknown]> = [
      ['/v1/orders', { description: 'x', amount: '1.00' }], // missing idempotency-key
      ['/v1/orders', { description: "' OR 1=1 --", amount: 'not-a-number' }],
      ['/v1/customers', { email: 'x'.repeat(400) }],
      ['/v1/settings', { displayName: { $ne: null } }],
      ['/v1/webhooks', { name: 'x', url: 'javascript:alert(1)', events: ['payment.confirmed'], secret: 'short' }],
    ];
    for (const [url, payload] of hostileBodies) {
      const response = await app.inject({ method: 'POST', url, headers: { ...auth(alice.apiKey), 'idempotency-key': randomUUID() }, payload });
      expect(response.statusCode, `POST ${url} returned ${response.statusCode}`).toBeLessThan(500);
      expect(response.body).not.toMatch(/stack|at .*\.ts:|syntax error|pg-mem/i);
    }
  });
});
