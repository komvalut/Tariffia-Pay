#!/usr/bin/env node
// Tariffia Pay operator demo (read/write against a running local API).
//
// Small, dependency-free: uses the built-in `fetch` only. It walks the merchant
// flow with EXISTING Tariffia endpoints:
//   admin: create merchant  ->  merchant: create customer -> create order
//   -> read payment status -> fetch the hosted checkout page -> read revenue,
//   usage and the audit log.
//
// Safety:
//   - Requires an explicit BASE_URL that must NOT look like production.
//   - Reads ADMIN_API_KEY (and optional merchant key) from the environment
//     only; never from the command line and never printed.
//   - Never prints the database URL, passwords, or any API key.
//
// Limitation (documented in docs/QUICKSTART.md): a live server uses the real
// Base USDC adapter, so there is no HTTP endpoint that fakes payment
// confirmation. This demo therefore reports the payment as PENDING and does not
// reach CONFIRMED. Use `npm test -- tests/production-smoke.test.ts` for the
// complete flow with the mock adapter.

const BASE_URL = (process.env.BASE_URL ?? '').trim().replace(/\/+$/, '');
const ADMIN_API_KEY = (process.env.ADMIN_API_KEY ?? '').trim();
const MERCHANT_API_KEY = (process.env.MERCHANT_API_KEY ?? '').trim();

const PRODUCTION_HINTS = ['pay.example.com', 'tariffia.io', 'tariffia.com', 'api.tariffia'];

// Validates configuration and returns a normalized base URL, or throws an Error
// with a safe (secret-free) message. Exported so it can be unit-tested.
export function validateConfig({ baseUrl = BASE_URL, adminApiKey = ADMIN_API_KEY } = {}) {
  if (!baseUrl) throw new Error('set BASE_URL to a local non-production origin, e.g. http://localhost:8080');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('BASE_URL is not a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('BASE_URL must be an HTTP(S) origin without embedded credentials');
  }
  const host = url.hostname.toLowerCase();
  const looksProduction = PRODUCTION_HINTS.some((hint) => host === hint || host.endsWith(`.${hint}`));
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.local');
  if (looksProduction || !isLocal) {
    throw new Error(`refusing to run against "${host}"; use a local base URL (localhost/127.0.0.1) and never production`);
  }
  if (!adminApiKey) throw new Error('ADMIN_API_KEY is required (set it in the environment)');
  return url.toString().replace(/\/+$/, '');
}

function fail(message) {
  process.stderr.write(`smoke-demo: ${message}\n`);
  process.exit(1);
}

function assertSafeConfig() {
  try {
    validateConfig();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function call(path, { method = 'GET', token, body, admin } = {}) {
  const headers = { accept: 'application/json' };
  if (admin) headers['x-admin-api-key'] = ADMIN_API_KEY;
  else if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && typeof parsed.message === 'string'
      ? parsed.message
      : `request failed with status ${response.status}`;
    throw new Error(`${method} ${path}: ${message}`);
  }
  return parsed;
}

function remark(label, value) {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

async function waitForReady() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const ready = await call('/ready');
      if (ready && ready.status === 'ready') return ready;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('the API did not become ready; start the server and confirm /ready returns 200');
}

async function main() {
  assertSafeConfig();
  process.stdout.write(`Tariffia Pay local demo against ${BASE_URL}\n\n`);

  // Health / readiness (public).
  const health = await call('/health');
  remark('liveness', health.status);
  const ready = await waitForReady();
  remark('readiness', `${ready.status} (database: ${ready.checks?.database ?? 'n/a'})`);

  // 1. Create a merchant (admin). The API key is returned once; never printed.
  const suffix = Date.now().toString(36);
  const merchant = await call('/v1/admin/merchants', {
    method: 'POST', admin: true,
    body: {
      name: `Demo Store ${suffix}`,
      email: `demo-${suffix}@example.com`,
      walletAddress: '0x1111111111111111111111111111111111111111',
    },
  });
  const merchantApiKey = MERCHANT_API_KEY || merchant.apiKey;
  if (!merchantApiKey) throw new Error('the merchant response did not include an API key');
  remark('merchant created', merchant.merchant.id);

  // 2. Create a customer (merchant).
  const customer = await call('/v1/customers', {
    method: 'POST', token: merchantApiKey,
    body: { externalId: `demo-customer-${suffix}`, email: `buyer-${suffix}@example.com`, name: 'Demo Buyer' },
  });
  remark('customer created', customer.customer.id);

  // 3. Create an order + payment (merchant). Idempotency-Key is required.
  const order = await call('/v1/orders', {
    method: 'POST', token: merchantApiKey,
    body: { customerId: customer.customer.id, description: 'Demo item', amount: '4.50', currency: 'USDC' },
  });
  const paymentId = order.payment.id;
  remark('order created', order.order.id);
  remark('payment status', order.payment.status);
  remark('checkout url', order.checkoutUrl ?? '(none)');

  // 4. Fetch the public hosted checkout page (proves the route is served).
  const checkout = await fetch(`${BASE_URL}/p/${paymentId}`);
  const contentType = checkout.headers.get('content-type') ?? '';
  const checkoutBody = contentType.includes('text/html') ? await checkout.text() : '';
  remark('checkout page', `${checkout.status} ${contentType.split(';')[0]} (${checkoutBody.length} bytes html)`);

  // 5. Read merchant-side payment status.
  const status = await call(`/v1/payments/${paymentId}`, { token: merchantApiKey });
  remark('payment status (merchant)', status.payment.status);

  // 6. Revenue, usage and audit log.
  const revenue = await call('/v1/revenue/summary', { token: merchantApiKey });
  remark('revenue totalConfirmed', `${revenue.revenue.totalConfirmed} ${revenue.revenue.currency ?? ''}`.trim());
  const usage = await call('/v1/usage', { token: merchantApiKey });
  remark('general requests used', usage.usage.general.used);
  const audit = await call('/v1/audit-log', { token: merchantApiKey });
  remark('audit entries', audit.entries.length);

  // 7. Note the confirmation limitation without pretending it succeeded.
  process.stdout.write('\nDone. The payment is PENDING.\n');
  process.stdout.write('This live server uses the real Base USDC adapter, so there is no endpoint to\n');
  process.stdout.write('fake a confirmation. For the full CONFIRMED flow with the mock adapter (no\n');
  process.stdout.write('funds, no chain), run: npm test -- tests/production-smoke.test.ts\n');
}

// Run only when invoked directly, so tests can import validateConfig.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1]) && import.meta.url === new URL(`file://${process.argv[1]}`).href;
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`smoke-demo: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
