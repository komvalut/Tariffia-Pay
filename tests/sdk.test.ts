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
        capabilities: { paymentRequests: true, transactionVerification: true, statusPolling: true,
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
});
