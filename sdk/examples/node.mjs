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
