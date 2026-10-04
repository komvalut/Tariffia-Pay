// Tariffia Pay — minimal merchant integration example.
//
// Reads configuration from the environment (never from the command line) and
// walks the existing merchant flow with the official SDK:
//   1. create (or reuse) a customer
//   2. create an order + payment with a stable idempotency key
//   3. print the hosted checkout URL
//   4. show how to verify a webhook signature
//
// It performs NO payment confirmation and NO blockchain calls. Payment
// verification is server-authoritative (see ../docs/INTEGRATION.md).
//
// Usage (server-side only, never in a browser):
//   TARIFFIA_API_KEY=tf_live_... \
//   TARIFFIA_BASE_URL=http://localhost:8080 \
//   node sdk/examples/merchant-flow.mjs
//
// Optional webhook demo (verifies a signature you already received):
//   TARIFFIA_WEBHOOK_SECRET=... \
//   TARIFFIA_WEBHOOK_BODY='{"id":"evt_1","type":"payment.confirmed"}' \
//   TARIFFIA_WEBHOOK_SIGNATURE='t=1700000000,v1=...' \
//   node sdk/examples/merchant-flow.mjs

import { randomUUID } from 'node:crypto';
import { TariffiaApiError, TariffiaClient, verifyWebhookSignature } from '@tariffia/pay/server';

const apiKey = process.env.TARIFFIA_API_KEY;
const baseUrl = process.env.TARIFFIA_BASE_URL ?? 'http://localhost:8080';

if (!apiKey) {
  console.error('Set TARIFFIA_API_KEY to a merchant API key (server-side only).');
  process.exit(1);
}

function maybeVerifyWebhook() {
  const secret = process.env.TARIFFIA_WEBHOOK_SECRET;
  const rawBody = process.env.TARIFFIA_WEBHOOK_BODY;
  const signatureHeader = process.env.TARIFFIA_WEBHOOK_SIGNATURE;
  if (!secret || !rawBody || !signatureHeader) return;
  const result = verifyWebhookSignature({
    secret,
    rawBody,
    signatureHeader,
    timestampHeader: process.env.TARIFFIA_WEBHOOK_TIMESTAMP,
    toleranceSeconds: 300,
  });
  console.log('Webhook signature valid:', result.valid, result.valid ? '' : `(${result.reason})`);
}

async function main() {
  const tariffia = new TariffiaClient({ apiKey, baseUrl });
  console.log(`Tariffia merchant flow against ${baseUrl}\n`);

  // 1. Create (or reuse) a customer. Idempotent by email/externalId.
  const email = `buyer-${Date.now().toString(36)}@example.com`;
  const { customer } = await tariffia.createCustomer({ email, name: 'Example Buyer' });
  console.log('Customer:', customer.id);

  // 2. Create an order + payment with a stable idempotency key.
  const result = await tariffia.createOrder(
    { customerId: customer.id, description: 'Example item', amount: '4.50', currency: 'USDC' },
    { idempotencyKey: `order-${randomUUID()}` },
  );
  console.log('Order:      ', result.order.id, `(${result.order.status})`);
  console.log('Payment:    ', result.payment.id, `(${result.payment.status})`);
  console.log('Checkout:   ', result.checkoutUrl);
  console.log('QR:         ', result.qrUrl);

  // 3. Read the current (server-authoritative) status.
  const status = await tariffia.getPaymentStatus(result.payment.id);
  console.log('Status now: ', status.payment.status);

  // 4. Optional: verify a webhook signature you received.
  maybeVerifyWebhook();

  console.log('\nDone. The payment is PENDING until an on-chain transfer is verified.');
  console.log('See ../docs/INTEGRATION.md for verification and webhook handling.');
}

main().catch((error) => {
  if (error instanceof TariffiaApiError) {
    console.error('Tariffia rejected the request:', error.statusCode, error.code, error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
