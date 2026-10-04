import { randomUUID } from 'node:crypto';
import { TariffiaApiError, TariffiaClient } from '@tariffia/pay/server';

const client = new TariffiaClient({
  apiKey: process.env.TARIFFIA_API_KEY,
  baseUrl: process.env.TARIFFIA_BASE_URL ?? 'http://localhost:8080',
});
const customerId = process.env.CUSTOMER_ID;

try {
  const link = await client.createPaymentLink(
    { customerId, description: 'Integration example', amount: '8.25', currency: 'USDC' },
    { idempotencyKey: `checkout-${randomUUID()}` },
  );
  console.log('Hosted checkout:', link.checkoutUrl);

  const balance = await client.getCustomerCreditBalance(customerId);
  console.log('Current credits:', balance.balance, balance.currency);

  const topup = await client.createCreditTopup(
    { customerId, amount: '5.00' },
    { idempotencyKey: `credit-topup-${randomUUID()}` },
  );
  console.log('Top-up checkout:', topup.checkoutUrl);

  const models = await client.getAiModels();
  console.log('Enabled models/prices:', models.models);

  // Merchant self-service reads (paginated lists return { items, pagination }).
  const customers = await client.getCustomers({ limit: 10 });
  console.log('First page of customers:', customers.customers.length, 'more:', customers.pagination.hasMore);
  const orders = await client.getOrders({ status: 'PENDING', limit: 10 });
  console.log('Pending orders:', orders.orders.length);
  const revenue = await client.getRevenueSummary();
  console.log('Confirmed revenue:', revenue.revenue.totalConfirmed, revenue.revenue.currency);
  const usageSummary = await client.getUsage();
  console.log('General API requests this window:', usageSummary.usage.general.used);

  // Authentication, usage and display preferences.
  const settings = await client.getSettings();
  console.log('Settings:', settings.settings.displayName, settings.settings.timezone);
  const audit = await client.getAuditLog({ limit: 5 });
  console.log('Recent activity:', audit.entries.map((entry) => entry.action));

  // Create a scoped API key; the plaintext secret is returned exactly once.
  const created = await client.createApiKey({ name: 'integration-example', scopes: ['payments:write'] });
  console.log('Created key', created.apiKey.id, 'with scopes', created.apiKey.scopes, '(secret shown once, store securely)');
  await client.revokeApiKey(created.apiKey.id);

  // Report real token counts collected by your existing provider integration.
  const usage = await client.recordAiUsage({
    requestId: `ai-request-${randomUUID()}`,
    customerId,
    provider: 'example-ai',
    model: 'text-small',
    inputTokens: 1200,
    outputTokens: 450,
    metadata: { source: 'server-example' },
  });
  console.log('Tariffia charge:', usage.usage.customerPriceUsd, 'USD');
} catch (error) {
  if (error instanceof TariffiaApiError) {
    console.error('Tariffia rejected the request:', error.statusCode, error.code, error.message);
  }
  throw error;
}
