import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { openApiDocument } from '../src/openapi.js';
import { createMigratedDatabase } from './fixtures/pg-mem-database.js';
import {
  TariffiaApiError,
  TariffiaClient,
  isTariffiaApiErrorCode,
  type TariffiaApiErrorCode,
} from '../sdk/src/server.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };

// A fetch implementation that dispatches the SDK's real HTTP calls into the
// in-process Fastify app via app.inject(). This exercises the real routes,
// handlers, validation, authentication, tenant scoping and error envelopes —
// NOT hand-written fake responses.
function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const response = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: `${url.pathname}${url.search}`,
      headers,
      ...(init?.body === undefined ? {} : { payload: init.body as string }),
    });
    // 204/205/304 must not carry a body.
    const body = [204, 205, 304].includes(response.statusCode) ? null : response.body;
    return new Response(body, {
      status: response.statusCode,
      headers: { 'content-type': (response.headers['content-type'] as string) ?? 'application/json' },
    });
  }) as typeof fetch;
}

describe('SDK against the real in-process API', () => {
  let db: Database;
  let app: FastifyInstance;
  let adminApiKey: string;
  let merchantApiKey: string;
  let tariffia: TariffiaClient;

  async function provisionMerchant(name: string, email: string, wallet: string): Promise<{ merchantId: string; apiKey: string }> {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return { merchantId: response.json().merchant.id as string, apiKey: response.json().apiKey as string };
  }

  beforeEach(async () => {
    db = await createMigratedDatabase();
    app = await buildApp({ db });
    adminApiKey = 'dev-admin-key-change-this-before-deploy';
    const merchant = await provisionMerchant('SDK Store', 'sdk@example.com', '0x7777777777777777777777777777777777777777');
    merchantApiKey = merchant.apiKey;
    tariffia = new TariffiaClient({ apiKey: merchantApiKey, baseUrl: 'http://localhost:8080', fetch: injectFetch(app) });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('drives the real routes for customers, orders, payment status and transactions', async () => {
    const { customer } = await tariffia.createCustomer({ email: 'buyer@example.com', name: 'Buyer' });
    expect(customer.id).toBeTruthy();

    const created = await tariffia.createOrder(
      { customerId: customer.id, description: 'SDK item', amount: '4.50', currency: 'USDC' },
      { idempotencyKey: `sdk-order-${randomUUID()}` },
    );
    expect(created.order.status).toBe('PENDING');
    expect(created.payment.status).toBe('PENDING');
    expect(created.checkoutUrl).toContain(`/p/${created.payment.id}`);

    const status = await tariffia.getPaymentStatus(created.payment.id);
    expect(status.payment.id).toBe(created.payment.id);

    const customers = await tariffia.getCustomers({ limit: 10 });
    expect(customers.customers.some((entry) => entry.id === customer.id)).toBe(true);
    expect(customers.pagination).toMatchObject({ limit: 10, offset: 0 });

    const orders = await tariffia.getOrders({ limit: 5 });
    expect(orders.orders.some((entry) => entry.id === created.order.id)).toBe(true);

    const transactions = await tariffia.getTransactions({ limit: 5 });
    expect(transactions.transactions.some((entry) => entry.paymentId === created.payment.id)).toBe(true);

    const details = await tariffia.getPaymentDetails(created.payment.id);
    expect(details.payment.id).toBe(created.payment.id);
    expect(details.order.id).toBe(created.order.id);
  });

  it('drives payment links, revenue, settings and notifications', async () => {
    const link = await tariffia.createPaymentLink(
      { description: 'Link item', amount: '9.00', currency: 'USDC' },
      { idempotencyKey: `sdk-link-${randomUUID()}` },
    );
    const links = await tariffia.getPaymentLinks({ limit: 10 });
    expect(links.paymentLinks.some((entry) => entry.id === link.payment.id)).toBe(true);
    const one = await tariffia.getPaymentLink(link.payment.id);
    expect(one.paymentLink.enabled).toBe(true);
    const disabled = await tariffia.updatePaymentLink(link.payment.id, { enabled: false });
    expect(disabled.paymentLink.enabled).toBe(false);

    const summary = await tariffia.getRevenueSummary();
    expect(summary.revenue).toBeTruthy();
    const history = await tariffia.getRevenueHistory();
    expect(Array.isArray(history.history)).toBe(true);

    const settings = await tariffia.updateSettings({ displayName: 'SDK Store', defaultCurrency: 'USDC', timezone: 'UTC' });
    expect(settings.settings.displayName).toBe('SDK Store');

    const prefs = await tariffia.updateNotificationPreferences({
      paymentConfirmed: true, paymentFailed: false, paymentExpired: true,
      creditTopup: true, aiRequestFailed: true, smsRequestFailed: false, webhookFailed: true,
    });
    expect(prefs.preferences.paymentFailed).toBe(false);

    const usage = await tariffia.getUsage();
    expect(usage.usage.general.used).toBeGreaterThanOrEqual(0);
  });

  it('drives API keys (secret once), audit log, usage, webhooks and dashboard', async () => {
    const before = await tariffia.getApiKeys();
    expect(Array.isArray(before.apiKeys)).toBe(true);

    const createdKey = await tariffia.createApiKey({ name: 'SDK sub-key', scopes: ['customers:read'] });
    expect(createdKey.secret).toMatch(/^tf_live_/);
    expect(createdKey.apiKey.scopes).toEqual(['customers:read']);

    const listed = await tariffia.getApiKeys();
    expect(listed.apiKeys.some((entry) => entry.id === createdKey.apiKey.id)).toBe(true);

    const hook = await tariffia.createWebhookEndpoint({
      name: 'SDK hook', url: 'https://hooks.example.test/sdk',
      events: ['payment.confirmed'], secret: 'merchant-owned-secret-at-least-32-chars',
    });
    const endpoints = await tariffia.getWebhookEndpoints({ limit: 10 });
    expect(endpoints.endpoints.some((entry) => entry.id === hook.endpoint.id)).toBe(true);
    const deliveries = await tariffia.getWebhookDeliveries(hook.endpoint.id, { limit: 10 });
    expect(Array.isArray(deliveries.deliveries)).toBe(true);
    await tariffia.updateWebhookEndpoint(hook.endpoint.id, { enabled: false });
    await tariffia.deleteWebhookEndpoint(hook.endpoint.id);

    await tariffia.revokeApiKey(createdKey.apiKey.id);
    const afterFetch = await tariffia.getApiKeys();
    expect(afterFetch.apiKeys.find((entry) => entry.id === createdKey.apiKey.id)?.status).toBe('revoked');

    const audit = await tariffia.getAuditLog({ limit: 10 });
    expect(audit.entries.some((entry) => entry.action === 'api_key.create')).toBe(true);

    const overview = await tariffia.getDashboardOverview();
    expect(overview.overview).toBeTruthy();
    const collection = await tariffia.getDashboardCollection('customers', { limit: 5 });
    expect(Array.isArray(collection.items)).toBe(true);
  });

  it('maps real server error envelopes to typed TariffiaApiError', async () => {
    // 401: invalid merchant key.
    const badKey = new TariffiaClient({ apiKey: 'tf_live_invalid', baseUrl: 'http://localhost:8080', fetch: injectFetch(app) });
    await expect(badKey.getCustomers()).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });

    // 403: a narrow key hitting an out-of-scope route.
    const narrow = await tariffia.createApiKey({ name: 'narrow', scopes: ['customers:read'] });
    const narrowClient = new TariffiaClient({ apiKey: narrow.secret, baseUrl: 'http://localhost:8080', fetch: injectFetch(app) });
    const scopedError = await narrowClient.getSettings().catch((error: unknown) => error as TariffiaApiError);
    expect(scopedError).toBeInstanceOf(TariffiaApiError);
    expect(scopedError.statusCode).toBe(403);
    expect(scopedError.code).toBe('insufficient_scope');
    expect(isTariffiaApiErrorCode(scopedError.code)).toBe(true);

    // 404: unknown resource.
    const notFound = await tariffia.getCustomer('11111111-1111-4111-8111-111111111111').catch((error: unknown) => error as TariffiaApiError);
    expect(notFound.statusCode).toBe(404);
    expect(notFound.code).toBe('not_found');

    // 400: invalid pagination is rejected (not clamped).
    const invalidPage = await tariffia.getCustomers({ limit: 9999 }).catch((error: unknown) => error as TariffiaApiError);
    expect(invalidPage.statusCode).toBe(400);
    expect(invalidPage.code).toBe('invalid_pagination');

    // 400: missing required idempotency key is a client-callable error code.
    const missingKey = await app.inject({
      method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${merchantApiKey}` },
      payload: { description: 'x', amount: '1.00' },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error).toBe('missing_idempotency_key');
  });

  it('keeps known error codes in the typed union and preserves unknown codes', () => {
    const known: TariffiaApiErrorCode = 'insufficient_scope';
    expect(isTariffiaApiErrorCode(known)).toBe(true);
    expect(isTariffiaApiErrorCode('definitely_not_a_real_code')).toBe(false);
    const unknownError = new TariffiaApiError('something new', 418, 'from_the_future', {});
    expect(unknownError.code).toBe('from_the_future');
  });

  it('keeps every SDK request path aligned with the documented OpenAPI contract', async () => {
    const canonical = (routePath: string): string =>
      routePath
        .replace(/\{[^}]+\}/g, '*')  // OpenAPI path params
        .replace(/:[^/]+/g, '*')     // SDK literal params
        .replace(/\/$/, '') || '/';
    const documented = new Set(Object.keys(openApiDocument.paths).map(canonical));

    const seen = new Set<string>();
    const capturing = new TariffiaClient({
      apiKey: merchantApiKey,
      baseUrl: 'http://localhost:8080',
      fetch: (async (input: string | URL) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        seen.add(canonical(decodeURIComponent(url.pathname)));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });

    const calls = [
      () => capturing.getCustomers(),
      () => capturing.getOrders(),
      () => capturing.getTransactions(),
      () => capturing.getPaymentLinks(),
      () => capturing.getRevenueSummary(),
      () => capturing.getRevenueHistory(),
      () => capturing.getUsage(),
      () => capturing.getSettings(),
      () => capturing.getNotificationPreferences(),
      () => capturing.getApiKeys(),
      () => capturing.getWebhookEndpoints(),
      () => capturing.getAuditLog(),
      () => capturing.getDashboardOverview(),
      () => capturing.getCustomer(':id').catch(() => undefined),
      () => capturing.getTransaction(':id').catch(() => undefined),
      () => capturing.getPaymentStatus(':id').catch(() => undefined),
    ];
    for (const call of calls) await call().catch(() => undefined);

    expect(seen.size).toBeGreaterThan(10);
    const missing = [...seen].filter((path) => !documented.has(path));
    expect(missing, `SDK paths missing from OpenAPI: ${missing.join(', ')}`).toEqual([]);
  });
});
