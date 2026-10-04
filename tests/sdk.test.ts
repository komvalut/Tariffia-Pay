import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkoutUrlForPayment, openCheckout } from '../sdk/src/browser.js';
import {
  TariffiaApiError,
  TariffiaClient,
  TariffiaProtocolError,
  verifyWebhookSignature,
} from '../sdk/src/server.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error('No mocked response configured');
    return response;
  };
  return { calls, fetcher };
}

describe('Tariffia TypeScript SDK', () => {
  it('retrieves invoices and receipts and downloads their server-generated PDFs', async () => {
    const pdf = new Response(Buffer.from('%PDF-1.4\n%%EOF\n'), { headers: { 'content-type': 'application/pdf' } });
    const { calls, fetcher } = fakeFetch([
      jsonResponse({ invoices: [{ id: 'invoice-1', invoiceNumber: 'INV-2026-ONE' }] }),
      jsonResponse({ invoice: { id: 'invoice-1', invoiceNumber: 'INV-2026-ONE' } }),
      pdf.clone(),
      jsonResponse({ receipts: [{ id: 'receipt-1', publicId: 'opaque-public-token' }] }),
      jsonResponse({ receipt: { id: 'receipt-1', publicId: 'opaque-public-token' } }),
      pdf.clone(),
      jsonResponse({ receipt: { invoiceNumber: 'INV-2026-ONE', paymentStatus: 'CONFIRMED' } }),
      pdf.clone(),
    ]);
    const client = new TariffiaClient({ apiKey: 'merchant-secret', baseUrl: 'https://pay.example', fetch: fetcher });

    expect((await client.getInvoices()).invoices[0]?.invoiceNumber).toBe('INV-2026-ONE');
    expect((await client.getInvoice('invoice-1')).invoice.id).toBe('invoice-1');
    expect(Buffer.from(await client.getInvoicePdf('invoice-1')).toString('ascii')).toContain('%PDF-1.4');
    expect((await client.getReceipts()).receipts[0]?.publicId).toBe('opaque-public-token');
    expect((await client.getReceipt('receipt-1')).receipt.id).toBe('receipt-1');
    expect(Buffer.from(await client.getReceiptPdf('receipt-1')).toString('ascii')).toContain('%PDF-1.4');
    expect((await client.getPublicReceipt('opaque-public-token')).receipt.paymentStatus).toBe('CONFIRMED');
    expect(Buffer.from(await client.getPublicReceiptPdf('opaque-public-token')).toString('ascii')).toContain('%PDF-1.4');
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/v1/invoices', '/v1/invoices/invoice-1', '/v1/invoices/invoice-1.pdf', '/v1/receipts',
      '/v1/receipts/receipt-1', '/v1/receipts/receipt-1.pdf',
      '/v1/public/receipts/opaque-public-token', '/v1/public/receipts/opaque-public-token.pdf',
    ]);
  });

  it('discovers enabled checkout methods and selects one when creating an order', async () => {
    const { calls, fetcher } = fakeFetch([
      jsonResponse({ methods: [{
        id: 'lightning', name: 'Bitcoin Lightning', description: 'Lightning invoice payments',
        capabilities: { paymentRequests: true, transactionVerification: true, statusPolling: true, recurringPayments: false,
          automaticDetection: false, refunds: false, paymentRequestFormat: 'invoice',
          currencies: ['SAT'], networks: ['lightning-mainnet'] },
      }] }),
      jsonResponse({ order: { id: 'order-1' }, payment: { id: 'pay-1', adapter: 'lightning' }, checkoutUrl: '/p/pay-1', qrUrl: '/p/pay-1/qr.png' }, 201),
    ]);
    const client = new TariffiaClient({ apiKey: 'merchant-secret', fetch: fetcher });
    const methods = await client.getPaymentMethods();
    expect(methods.methods.map((method) => method.id)).toEqual(['lightning']);
    await client.createOrder(
      { description: 'SAT checkout', amount: '25', currency: 'SAT', adapter: methods.methods[0]!.id },
      { idempotencyKey: 'lightning-sdk-order-1' },
    );
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ currency: 'SAT', adapter: 'lightning' });
  });

  it('authenticates with the merchant key and forwards idempotency keys for order/payment-link/top-up requests', async () => {
    const { calls, fetcher } = fakeFetch([
      jsonResponse({ checkoutUrl: 'https://pay.example/p/pay-1', order: { id: 'order-1' }, payment: { id: 'pay-1' } }, 201),
      jsonResponse({ checkoutUrl: 'https://pay.example/p/pay-2', order: { id: 'order-2' }, payment: { id: 'pay-2' } }, 201),
      jsonResponse({ creditTopup: { id: 'topup-1' }, checkoutUrl: 'https://pay.example/p/pay-3' }, 201),
    ]);
    const client = new TariffiaClient({ apiKey: 'tf_live_private-test-key', baseUrl: 'https://pay.example/', fetch: fetcher });
    expect(Object.keys(client)).not.toContain('apiKey');
    expect('apiKey' in client).toBe(false);

    const order = await client.createOrder(
      { description: 'Order', amount: '2.00' },
      { idempotencyKey: 'order-retry-key-001' },
    );
    const link = await client.createPaymentLink(
      { description: 'Hosted item', amount: '3.00' },
      { idempotencyKey: 'link-retry-key-001' },
    );
    const topup = await client.createCreditTopup(
      { customerId: 'customer-1', amount: '5.00' },
      { idempotencyKey: 'topup-retry-key-001' },
    );

    expect(order.payment.id).toBe('pay-1');
    expect(link.checkoutUrl).toBe('https://pay.example/p/pay-2');
    expect(topup.creditTopup?.id).toBe('topup-1');
    expect(calls.map(({ url }) => url)).toEqual([
      'https://pay.example/v1/orders',
      'https://pay.example/v1/payment-links',
      'https://pay.example/v1/credits/topups',
    ]);
    expect(calls.map(({ init }) => new Headers(init?.headers).get('authorization')))
      .toEqual(Array(3).fill('Bearer tf_live_private-test-key'));
    expect(calls.map(({ init }) => new Headers(init?.headers).get('idempotency-key')))
      .toEqual(['order-retry-key-001', 'link-retry-key-001', 'topup-retry-key-001']);
  });

  it('covers payment status/verification, webhook management, credits, model pricing, and reported AI usage', async () => {
    const { calls, fetcher } = fakeFetch([
      jsonResponse({ payment: { id: 'pay-1', status: 'PENDING' } }),
      jsonResponse({ payment: { status: 'CONFIRMED', transactionId: `0x${'a'.repeat(64)}`, transactionHash: `0x${'a'.repeat(64)}`, confirmations: 12 } }),
      jsonResponse({ endpoint: { id: 'hook-1', name: 'Orders', events: ['payment.confirmed'], enabled: true } }, 201),
      jsonResponse({ endpoints: [{ id: 'hook-1', name: 'Orders', events: ['payment.confirmed'], enabled: true }] }),
      jsonResponse({ endpoint: { id: 'hook-1', name: 'Billing', events: ['payment.confirmed'], enabled: false } }),
      new Response(null, { status: 204 }),
      jsonResponse({ accountId: 'account-1', customerId: 'customer-1', balance: '12.5', currency: 'CREDITS', creditsPerUsdcRate: 100 }),
      jsonResponse({ models: [{ provider: 'demo', providerName: 'Demo', model: 'small', name: 'Small', pricingMode: 'PER_1K_TOKENS', pricePerRequestUsd: '0.00000000', inputPricePer1kUsd: '0.01000000', outputPricePer1kUsd: '0.02000000' }] }),
      jsonResponse({ usage: { id: 'usage-1', requestId: 'request-0001', customerId: 'customer-1', customerPriceUsd: '0.01', creditsDeducted: '1', currency: 'CREDITS' } }, 201),
    ]);
    const client = new TariffiaClient({ apiKey: 'merchant-secret', baseUrl: 'https://pay.example', fetch: fetcher });

    expect((await client.getPaymentStatus('pay-1')).payment.status).toBe('PENDING');
    expect((await client.verifyPayment('pay-1', `0x${'a'.repeat(64)}`)).payment.status).toBe('CONFIRMED');
    await client.createWebhookEndpoint({ name: 'Orders', url: 'https://merchant.example/hooks', events: ['payment.confirmed'], secret: 'merchant-owned-secret-at-least-32-chars' });
    expect((await client.getWebhookEndpoints()).endpoints).toHaveLength(1);
    await client.updateWebhookEndpoint('hook-1', { name: 'Billing', enabled: false });
    await client.deleteWebhookEndpoint('hook-1');
    expect((await client.getCustomerCreditBalance('customer-1')).balance).toBe('12.5');
    expect((await client.getAiModels()).models[0].inputPricePer1kUsd).toBe('0.01000000');
    await client.recordAiUsage({ requestId: 'request-0001', customerId: 'customer-1', provider: 'demo', model: 'small', inputTokens: 1000 });

    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/v1/payments/pay-1', '/v1/payments/pay-1/verify', '/v1/webhooks', '/v1/webhooks',
      '/v1/webhooks/hook-1', '/v1/webhooks/hook-1', '/v1/credits/customer-1/balance',
      '/v1/ai/models', '/v1/ai/usage',
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ transactionId: `0x${'a'.repeat(64)}` });
    expect(new Headers(calls[8].init?.headers).get('idempotency-key')).toBeNull();
    expect(JSON.parse(String(calls[8].init?.body)).requestId).toBe('request-0001');
  });

  it('exposes typed HTTP and protocol errors without swallowing API codes', async () => {
    const failed = new TariffiaClient({
      apiKey: 'merchant-secret',
      fetch: async () => jsonResponse({ error: 'insufficient_credits', message: 'Insufficient credits' }, 409),
    });
    await expect(failed.getCustomerCreditBalance('customer-1')).rejects.toMatchObject({
      name: 'TariffiaApiError', statusCode: 409, code: 'insufficient_credits', message: 'Insufficient credits',
    });
    await expect(failed.getCustomerCreditBalance('customer-1')).rejects.toBeInstanceOf(TariffiaApiError);

    const invalidJson = new TariffiaClient({ apiKey: 'merchant-secret', fetch: async () => new Response('<html>oops</html>') });
    await expect(invalidJson.getAiModels()).rejects.toBeInstanceOf(TariffiaProtocolError);
    expect(() => new TariffiaClient({ apiKey: '' })).toThrow(/merchant API key/i);
  });

  it('verifies signed webhook payloads and rejects altered or stale requests', () => {
    const secret = 'webhook-secret-for-sdk-tests';
    const rawBody = '{"id":"event-1","type":"payment.confirmed"}';
    const timestamp = 1_700_000_000;
    const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const signatureHeader = `t=${timestamp},v1=${digest}`;
    expect(verifyWebhookSignature({ secret, rawBody, signatureHeader, timestampHeader: String(timestamp), nowSeconds: timestamp })).toEqual({ valid: true });
    expect(verifyWebhookSignature({ secret, rawBody: `${rawBody} `, signatureHeader, nowSeconds: timestamp })).toMatchObject({ valid: false });
    expect(verifyWebhookSignature({ secret, rawBody, signatureHeader, nowSeconds: timestamp + 600 })).toMatchObject({ valid: false });
  });

  it('keeps browser checkout helpers credential-free and validates destination URLs', () => {
    const paymentId = '123e4567-e89b-42d3-a456-426614174000';
    expect(checkoutUrlForPayment(paymentId, 'https://pay.example')).toBe(`https://pay.example/p/${paymentId}`);
    const navigations: string[] = [];
    openCheckout(`https://pay.example/p/${paymentId}`, { assign: (url) => navigations.push(url) });
    expect(navigations).toEqual([`https://pay.example/p/${paymentId}`]);
    expect(() => checkoutUrlForPayment('not-a-uuid', 'https://pay.example')).toThrow(/UUID/);
    expect(() => checkoutUrlForPayment(paymentId, 'https://user:password@pay.example')).toThrow(/credentials/);
    expect(() => openCheckout('javascript:alert(1)', { assign: () => undefined })).toThrow(/hosted checkout/);
    expect(() => openCheckout('https://pay.example/account', { assign: () => undefined })).toThrow(/hosted checkout/);
  });

  const pagination = { limit: 50, offset: 0, count: 1, hasMore: false };

  it('covers customers, orders, transactions and payment details with typed responses', async () => {
    const { calls, fetcher } = fakeFetch([
      jsonResponse({ customers: [{ id: 'cust-1', email: 'buyer@example.com', externalId: 'c-1' }], pagination }),
      jsonResponse({ customer: { id: 'cust-1', email: 'buyer@example.com', orderCount: 2, paymentCount: 2 } }),
      jsonResponse({ customer: { id: 'cust-1', email: 'buyer@example.com', externalId: 'c-1' } }, 201),
      jsonResponse({ orders: [{ id: 'order-1', status: 'PENDING', statusLabel: 'Pending' }], pagination }),
      jsonResponse({ order: { id: 'order-1', paymentId: 'pay-1', paymentStatus: 'CONFIRMED' } }),
      jsonResponse({ transactions: [{ paymentId: 'pay-1', statusLabel: 'Confirmed' }], pagination }),
      jsonResponse({ transaction: { paymentId: 'pay-1', transactionHash: `0x${'b'.repeat(64)}` } }),
      jsonResponse({ payment: { id: 'pay-1', status: 'CONFIRMED' }, order: { id: 'order-1' }, invoice: null, receipt: null }),
    ]);
    const client = new TariffiaClient({ apiKey: 'merchant-secret', baseUrl: 'https://pay.example', fetch: fetcher });

    expect((await client.getCustomers({ limit: 10, offset: 20 })).customers[0]?.id).toBe('cust-1');
    expect((await client.getCustomer('cust-1')).customer.orderCount).toBe(2);
    await client.createCustomer({ email: 'buyer@example.com', name: 'Buyer', metadata: { tier: 'gold' } });
    expect((await client.getOrders({ status: 'PENDING', limit: 5 })).orders[0]?.statusLabel).toBe('Pending');
    expect((await client.getOrder('order-1')).order.paymentStatus).toBe('CONFIRMED');
    expect((await client.getTransactions({ status: 'CONFIRMED', network: 'base' })).transactions[0]?.statusLabel).toBe('Confirmed');
    expect((await client.getTransaction('pay-1')).transaction.transactionHash).toBe(`0x${'b'.repeat(64)}`);
    expect((await client.getPaymentDetails('pay-1')).payment.status).toBe('CONFIRMED');

    expect(calls.map(({ url }) => `${new URL(url).pathname}${new URL(url).search}`)).toEqual([
      '/v1/customers?limit=10&offset=20', '/v1/customers/cust-1', '/v1/customers',
      '/v1/orders?status=PENDING&limit=5', '/v1/orders/order-1',
      '/v1/transactions?status=CONFIRMED&network=base', '/v1/transactions/pay-1', '/v1/payments/pay-1/details',
    ]);
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({ email: 'buyer@example.com', metadata: { tier: 'gold' } });
  });

  it('covers payment link management, revenue, usage, settings and notifications', async () => {
    const { calls, fetcher } = fakeFetch([
      jsonResponse({ paymentLinks: [{ id: 'pay-1', enabled: true }], pagination }),
      jsonResponse({ paymentLink: { id: 'pay-1', enabled: true } }),
      jsonResponse({ paymentLink: { id: 'pay-1', enabled: false } }),
      new Response(null, { status: 204 }),
      jsonResponse({ revenue: { currency: 'USDC', totalConfirmed: '4.500000', confirmedPaymentCount: 1, pendingPaymentCount: 0, failedPaymentCount: 0, expiredPaymentCount: 0, totalsByCurrency: { USDC: '4.500000' } } }),
      jsonResponse({ history: [{ date: '2026-01-01', currency: 'USDC', confirmedAmount: '4.500000', confirmedPaymentCount: 1 }], from: null, to: null, currency: 'USDC' }),
      jsonResponse({ usage: { general: { used: 12, limit: 300, unlimited: false, remaining: 288 }, ai: { used: 0, limit: null, unlimited: true, remaining: null }, sms: { used: 1, limit: 60, unlimited: false, remaining: 59 } } }),
      jsonResponse({ settings: { merchantId: 'm-1', displayName: 'Store', defaultCurrency: 'USDC', timezone: 'UTC' } }),
      jsonResponse({ settings: { merchantId: 'm-1', displayName: 'New', defaultCurrency: 'USDC', timezone: 'UTC' } }),
      jsonResponse({ preferences: { paymentConfirmed: true, paymentFailed: false, paymentExpired: true, creditTopup: true, aiRequestFailed: true, smsRequestFailed: false, webhookFailed: true } }),
      jsonResponse({ preferences: { paymentConfirmed: true, paymentFailed: true, paymentExpired: true, creditTopup: true, aiRequestFailed: true, smsRequestFailed: true, webhookFailed: true } }),
    ]);
    const client = new TariffiaClient({ apiKey: 'merchant-secret', baseUrl: 'https://pay.example', fetch: fetcher });

    expect((await client.getPaymentLinks({ limit: 25 })).paymentLinks[0]?.id).toBe('pay-1');
    expect((await client.getPaymentLink('pay-1')).paymentLink.enabled).toBe(true);
    expect((await client.updatePaymentLink('pay-1', { enabled: false })).paymentLink.enabled).toBe(false);
    await client.deletePaymentLink('pay-1');
    expect((await client.getRevenueSummary({ from: '2026-01-01' })).revenue.totalConfirmed).toBe('4.500000');
    expect((await client.getRevenueHistory({ currency: 'USDC' })).history[0]?.confirmedPaymentCount).toBe(1);
    expect((await client.getUsage()).usage.general.used).toBe(12);
    expect((await client.getSettings()).settings.displayName).toBe('Store');
    await client.updateSettings({ displayName: 'New' });
    expect((await client.getNotificationPreferences()).preferences.paymentFailed).toBe(false);
    await client.updateNotificationPreferences({ paymentConfirmed: true, paymentFailed: true, paymentExpired: true, creditTopup: true, aiRequestFailed: true, smsRequestFailed: true, webhookFailed: true });

    expect(calls.map(({ url }) => `${new URL(url).pathname}${new URL(url).search}`)).toEqual([
      '/v1/payment-links?limit=25', '/v1/payment-links/pay-1', '/v1/payment-links/pay-1', '/v1/payment-links/pay-1',
      '/v1/revenue/summary?from=2026-01-01', '/v1/revenue/history?currency=USDC',
      '/v1/usage', '/v1/settings', '/v1/settings', '/v1/notification-preferences', '/v1/notification-preferences',
    ]);
    expect(calls[2].init?.method).toBe('PATCH');
    expect(calls[3].init?.method).toBe('DELETE');
    expect(calls[8].init?.method).toBe('PUT');
  });

  it('covers API keys without leaking the one-time secret, audit log and dashboard', async () => {
    const oneTimeSecret = 'tf_live_super_secret_value_returned_once';
    const { calls, fetcher } = fakeFetch([
      jsonResponse({ apiKeys: [{ id: 'key-1', name: 'Primary', prefix: 'tf_live_abc', scopes: ['orders:read'], status: 'active' }] }),
      jsonResponse({ apiKey: { id: 'key-2', name: 'CI', prefix: 'tf_live_def', scopes: ['payments:write'], status: 'active' }, secret: oneTimeSecret, warning: 'Store this API key now.' }, 201),
      new Response(null, { status: 204 }),
      jsonResponse({ entries: [{ id: 'audit-1', action: 'settings.update', actorType: 'merchant' }], pagination }),
      jsonResponse({ overview: { customers: 3, orders: 5, usdc_received: '9.000000' } }),
      jsonResponse({ items: [{ id: 'cust-1' }], pagination }),
    ]);
    const client = new TariffiaClient({ apiKey: 'merchant-secret', baseUrl: 'https://pay.example', fetch: fetcher });

    const keys = await client.getApiKeys();
    expect(keys.apiKeys[0]?.status).toBe('active');
    const created = await client.createApiKey({ name: 'CI', scopes: ['payments:write'] });
    // The secret is exposed exactly on the create response, never stored on the client.
    expect(created.secret).toBe(oneTimeSecret);
    expect(created.apiKey.scopes).toEqual(['payments:write']);
    expect(JSON.stringify(keys)).not.toContain(oneTimeSecret);
    expect('apiKey' in client).toBe(false);
    await client.revokeApiKey('key-2');
    expect((await client.getAuditLog({ limit: 20 })).entries[0]?.action).toBe('settings.update');
    expect((await client.getDashboardOverview()).overview.customers).toBe(3);
    expect((await client.getDashboardCollection('customers', { limit: 10, status: 'active' })).items).toHaveLength(1);

    expect(calls.map(({ url }) => `${new URL(url).pathname}${new URL(url).search}`)).toEqual([
      '/v1/api-keys', '/v1/api-keys', '/v1/api-keys/key-2', '/v1/audit-log?limit=20',
      '/v1/dashboard/overview', '/v1/dashboard/customers?limit=10&status=active',
    ]);
    expect(calls[2].init?.method).toBe('DELETE');
    expect(new Headers(calls[1].init?.headers).get('authorization')).toBe('Bearer merchant-secret');
  });

  it('exposes pagination metadata and delivery history for webhooks', async () => {
    const { calls, fetcher } = fakeFetch([
      jsonResponse({ endpoints: [{ id: 'hook-1' }], pagination: { limit: 10, offset: 0, count: 1, hasMore: true } }),
      jsonResponse({ deliveries: [{ id: 'del-1', status: 'FAILED' }], pagination: { limit: 10, offset: 0, count: 1, hasMore: false } }),
    ]);
    const client = new TariffiaClient({ apiKey: 'merchant-secret', baseUrl: 'https://pay.example', fetch: fetcher });
    const endpoints = await client.getWebhookEndpoints({ limit: 10 });
    expect(endpoints.pagination).toMatchObject({ count: 1, hasMore: true });
    const deliveries = await client.getWebhookDeliveries('hook-1', { limit: 10, offset: 0 });
    expect(deliveries.deliveries[0]?.status).toBe('FAILED');
    expect(calls.map(({ url }) => `${new URL(url).pathname}${new URL(url).search}`)).toEqual([
      '/v1/webhooks?limit=10', '/v1/webhooks/hook-1/deliveries?limit=10&offset=0',
    ]);
  });

  it('omits empty pagination parameters and normalizes API errors for new methods', async () => {
    const { calls, fetcher } = fakeFetch([jsonResponse({ customers: [], pagination: { limit: 50, offset: 0, count: 0, hasMore: false } })]);
    const client = new TariffiaClient({ apiKey: 'merchant-secret', baseUrl: 'https://pay.example', fetch: fetcher });
    await client.getCustomers({ limit: undefined, offset: undefined });
    expect(new URL(calls[0].url).search).toBe('');

    const failing = new TariffiaClient({
      apiKey: 'merchant-secret',
      fetch: async () => jsonResponse({ error: 'insufficient_scope', message: 'This API key is missing the required scope: customers:read' }, 403),
    });
    await expect(failing.getCustomers()).rejects.toMatchObject({ name: 'TariffiaApiError', statusCode: 403, code: 'insufficient_scope' });
  });
});
