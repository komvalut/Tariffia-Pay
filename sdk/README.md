# Tariffia Pay TypeScript SDK

`@tariffia/pay` is a thin client for the existing Tariffia Pay HTTP API. It forwards requests and responses; payment verification, idempotency storage, credit accounting, pricing, and webhook delivery remain in the Tariffia service.

## Install

```sh
npm install @tariffia/pay
```

The SDK requires Node.js 20+ and uses the built-in `fetch`. It has no runtime dependencies.

## Server SDK

Import the credential-bearing client only from backend code. Keep the merchant API key in a server-side secret store or environment variable. Do not bundle `@tariffia/pay/server` into browser applications, mobile apps, or public client JavaScript.

```ts
import { TariffiaClient, TariffiaApiError } from '@tariffia/pay/server';

const tariffia = new TariffiaClient({
  apiKey: process.env.TARIFFIA_API_KEY!,
  baseUrl: process.env.TARIFFIA_BASE_URL ?? 'https://pay.example.com',
});

try {
  const result = await tariffia.createOrder(
    { description: 'Digital item', amount: '12.50', currency: 'USDC' },
    { idempotencyKey: 'order-1234-create-001' },
  );
  console.log(result.order.id, result.payment.status);
} catch (error) {
  if (error instanceof TariffiaApiError) {
    console.error(error.statusCode, error.code, error.message);
  }
  throw error;
}
```

### Methods

Orders, payments and links:

- `createOrder(input, { idempotencyKey, signal? })`
- `createPaymentLink(input, { idempotencyKey, signal? })`
- `getOrders({ status?, limit?, offset?, signal? })`
- `getOrder(orderId, { signal? })`
- `getPaymentStatus(paymentId, { signal? })`
- `getPaymentDetails(paymentId, { signal? })`
- `verifyPayment(paymentId, transactionHash, { signal? })`
- `getTransactions({ status?, network?, limit?, offset?, signal? })`
- `getTransaction(paymentId, { signal? })`
- `getPaymentLinks({ limit?, offset?, signal? })`
- `getPaymentLink(paymentId, { signal? })`
- `updatePaymentLink(paymentId, { enabled }, { signal? })`
- `deletePaymentLink(paymentId, { signal? })`

Customers:

- `getCustomers({ limit?, offset?, signal? })`
- `getCustomer(customerId, { signal? })`
- `createCustomer(input, { signal? })`

Revenue, usage, settings and notifications:

- `getRevenueSummary({ from?, to?, signal? })`
- `getRevenueHistory({ from?, to?, currency?, signal? })`
- `getUsage({ signal? })`
- `getSettings({ signal? })`
- `updateSettings(input, { signal? })`
- `getNotificationPreferences({ signal? })`
- `updateNotificationPreferences(input, { signal? })`

API keys, webhooks, audit log and dashboard:

- `getApiKeys({ signal? })`
- `createApiKey({ name, scopes? }, { signal? })`
- `revokeApiKey(keyId, { signal? })`
- `createWebhookEndpoint(input, { signal? })`
- `getWebhookEndpoints({ limit?, offset?, signal? })`
- `updateWebhookEndpoint(endpointId, input, { signal? })`
- `deleteWebhookEndpoint(endpointId, { signal? })`
- `getWebhookDeliveries(endpointId, { limit?, offset?, signal? })`
- `getAuditLog({ limit?, offset?, signal? })`
- `getDashboardOverview({ signal? })`
- `getDashboardCollection(collection, { q?, status?, limit?, offset?, signal? })`

Credits, AI, SMS, subscriptions, billing documents and signatures:

- `getCustomerCreditBalance(customerId, { signal? })`
- `createCreditTopup({ customerId, amount }, { idempotencyKey, signal? })`
- `getAiModels({ signal? })`
- `recordAiUsage(input, { signal? })`
- `createChatCompletion(input, { signal? })`
- `streamChatCompletion(input, { signal? })`
- `getSmsServices({ signal? })`
- `sendSms(input, { signal? })`
- `sendOtp(input, { signal? })`
- `createSubscriptionPlan(input, { signal? })`
- `getSubscriptionPlans({ signal? })`
- `updateSubscriptionPlan(planId, input, { signal? })`
- `createSubscription(input, { idempotencyKey, signal? })`
- `getSubscriptions({ signal? })`
- `getSubscription(subscriptionId, { signal? })`
- `updateSubscription(subscriptionId, action, { signal? })`
- `renewSubscription(subscriptionId, { idempotencyKey, signal? })`
- `getSubscriptionBillingCycles(subscriptionId, { signal? })`
- `getCustomerSubscriptions(customerId, { signal? })`
- `getInvoices({ limit?, offset?, signal? })`
- `getInvoice(invoiceIdOrNumber, { signal? })`
- `getInvoicePdf(invoiceIdOrNumber, { signal? })`
- `getReceipts({ limit?, offset?, signal? })`
- `getReceipt(receiptIdOrInvoiceNumber, { signal? })`
- `getReceiptPdf(receiptIdOrInvoiceNumber, { signal? })`
- `getPublicReceipt(publicId, { signal? })`
- `getPublicReceiptPdf(publicId, { signal? })`
- `verifyWebhookSignature(input)`

The SDK forwards `Idempotency-Key` for orders, payment links, credit top-ups, subscriptions and manual renewals. Tariffia persists those idempotency decisions. AI usage uses its required `requestId` as the idempotency key; retry the same logical usage with the same request ID and payload.

`TariffiaApiError` exposes `statusCode`, `code`, `message`, and the parsed `responseBody`. Network failures and aborts are returned as the underlying Fetch errors. The response interfaces follow the current API; optional fields mirror fields that are optional in the API response.

### Pagination

Every paginated list method accepts `{ limit?, offset? }` and returns the resource array plus a `pagination` object `{ limit, offset, count, hasMore }`, matching the server contract (default `limit` 50, maximum 100; invalid values produce an `invalid_pagination` error from the API, surfaced as `TariffiaApiError`).

```ts
const page = await tariffia.getCustomers({ limit: 25, offset: 50 });
console.log(page.customers.length, page.pagination.hasMore);
```

### Customers, orders, transactions and links

```ts
await tariffia.createCustomer({ email: 'buyer@example.com', name: 'Buyer', metadata: { tier: 'gold' } });
const { customers } = await tariffia.getCustomers({ limit: 10 });
const { orders } = await tariffia.getOrders({ status: 'PENDING' });
const { transactions } = await tariffia.getTransactions({ network: 'base' });
const details = await tariffia.getPaymentDetails(transactions[0]!.paymentId);
await tariffia.updatePaymentLink(details.payment.id, { enabled: false });
```

### API keys

`createApiKey` returns the plaintext secret exactly once (in `secret`) and never stores it on the client. Persist it in a server-side secret store and never log or bundle it:

```ts
const created = await tariffia.createApiKey({ name: 'CI', scopes: ['payments:write'] });
// created.secret is shown once; store it securely.
await tariffia.revokeApiKey(created.apiKey.id);
```

The SDK does not expose admin-only endpoints (`/v1/admin/*`). Those remain operator-only.

## Browser-Safe Checkout

Browser code must not use the server SDK or contain a merchant API key. Import only the credential-free `@tariffia/pay/browser` entry for navigation to the existing hosted checkout:

```ts
import { openCheckout } from '@tariffia/pay/browser';

// checkoutUrl was rendered by your backend from createPaymentLink's response.
openCheckout(checkoutUrl);
```

The browser entry exports `checkoutUrlForPayment(paymentId, publicBaseUrl)` and `openCheckout(checkoutUrl)`. Checkout navigation does not verify payment or determine payment status; Tariffia's existing payment API remains authoritative.

## REST Example

The server SDK maps directly to these existing endpoints. Idempotency keys are generated and retained by your server for retries:

```sh
curl -X POST "$TARIFFIA_BASE_URL/v1/payment-links" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: checkout-1234-0001' \
  -d '{"description":"Digital item","amount":"12.50","currency":"USDC"}'

curl "$TARIFFIA_BASE_URL/v1/payments/PAYMENT_UUID" \
  -H "authorization: Bearer $TARIFFIA_API_KEY"

curl -X POST "$TARIFFIA_BASE_URL/v1/payments/PAYMENT_UUID/verify" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"transactionHash":"0xTRANSACTION_HASH"}'
```

Additional REST flows for credits, webhooks, and AI usage are in [`examples/rest.sh`](examples/rest.sh).

## Checkout Integration

Create the payment link on your server and send the returned URL to the browser or redirect the browser to it. Never send `TARIFFIA_API_KEY` to the browser:

```ts
const link = await tariffia.createPaymentLink(
  { description: 'Order 1234', amount: '12.50', currency: 'USDC' },
  { idempotencyKey: 'order-1234-payment-link-001' },
);

// In a server response handler:
response.writeHead(303, { location: link.checkoutUrl });
response.end();
```

An optional standalone browser page is in [`examples/checkout.html`](examples/checkout.html). It accepts only the public checkout URL produced by the server.

## Webhook Handler

Read and verify the exact raw request body before parsing JSON. Keep the webhook signing secret in server-side configuration, apply a timestamp tolerance, and deduplicate event IDs in durable storage:

```ts
import { verifyWebhookSignature } from '@tariffia/pay/server';

const verified = verifyWebhookSignature({
  secret: process.env.TARIFFIA_WEBHOOK_SECRET!,
  rawBody,
  signatureHeader: request.headers['x-tariffia-signature'],
  timestampHeader: request.headers['x-tariffia-timestamp'],
  toleranceSeconds: 300,
});
if (!verified.valid) throw new Error(verified.reason);
const event = JSON.parse(rawBody);
```

See [`examples/webhook.mjs`](examples/webhook.mjs) for a runnable Node HTTP handler.

## AI Usage and Billing

Call your existing AI provider integration from trusted backend code, then report its measured token counts. This SDK does not call AI providers. Tariffia calculates the configured customer price and atomically deducts credits:

```ts
const models = await tariffia.getAiModels();
const model = models.models.find((item) => item.provider === 'example-ai' && item.model === 'text-small');
if (!model) throw new Error('Model is not enabled');

// Substitute token counts returned by your existing provider integration.
const usage = await tariffia.recordAiUsage({
  requestId: 'ai-request-1234',
  customerId: 'CUSTOMER_UUID',
  provider: model.provider,
  model: model.model,
  inputTokens: 1200,
  outputTokens: 450,
  metadata: { traceId: 'trace-1234' },
});
console.log(usage.usage.customerPriceUsd, usage.usage.creditsDeducted);
```

Merchant responses expose the configured customer charge, not provider cost or platform profit. For setup and top-up examples, see [`examples/node.mjs`](examples/node.mjs).

## API Compatibility

The SDK uses the current `/v1` endpoints and adds no server routes or payment logic. It covers merchant-facing functionality only (customers, orders, payments, transactions, payment links, revenue, usage, settings, notifications, API keys, webhooks, audit log and the merchant dashboard); admin-only endpoints under `/v1/admin/*` are intentionally excluded. It does not change API-key authentication or scopes, payment adapters, order/payment records, credit balances, ledger entries, or pricing behavior. New payment methods and provider integrations are not included.
