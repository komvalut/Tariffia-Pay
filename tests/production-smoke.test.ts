import { randomUUID } from 'node:crypto';
import { parseUnits } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import type {
  AdapterPaymentDetails,
  PaymentAdapter,
  PaymentVerificationInput,
  PaymentVerificationResult,
} from '../src/payment-adapter.js';
import { PaymentAdapterRegistry } from '../src/payment-adapters/registry.js';
import { PaymentVerificationService } from '../src/services/payment-verification-service.js';
import { createMigratedDatabase } from './fixtures/pg-mem-database.js';

// Production-style smoke test. It runs the real HTTP routes through Fastify against an
// in-memory PostgreSQL and a deterministic mock payment adapter: no real funds, no network
// RPC and no provider credentials are involved. Each test builds and tears down its own
// database and app instance, so all data is cleaned up automatically.

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const usdcAddress = '0x833589fCD6eDb6E08f4c7C32d4F71b54bdA02913';

type FixtureVerificationResult =
  | { state: 'not_found' }
  | { state: 'verified'; confirmations: number; blockNumber: bigint };

async function createDatabase(): Promise<Database> {
  return createMigratedDatabase();
}

function standardFixtureVerification(input: PaymentVerificationInput, result: FixtureVerificationResult): PaymentVerificationResult {
  if (result.state === 'not_found') return result;
  return {
    state: 'verified',
    confirmations: result.confirmations,
    blockNumber: result.blockNumber,
    receipt: {
      transactionId: input.transactionId,
      network: input.network,
      state: 'confirmed',
      amount: input.amount,
      currency: input.currency,
      recipient: input.recipientAddress,
      confirmations: result.confirmations,
      blockNumber: result.blockNumber.toString(),
    },
  } as PaymentVerificationResult;
}

function mockUsdcAdapter(getVerification: () => FixtureVerificationResult): PaymentAdapter {
  return {
    id: 'usdc',
    manifest: {
      id: 'usdc', name: 'Base USDC', version: 'smoke', description: 'Deterministic smoke-test USDC adapter',
      capabilities: {
        paymentRequests: true, transactionVerification: true, statusPolling: false, recurringPayments: false,
        automaticDetection: true, refunds: false, paymentRequestFormat: 'wallet',
        currencies: ['USDC'], networks: ['base'],
      },
      idempotency: { paymentCreation: 'stable-key-required', transactionVerification: 'network-and-transaction-id' },
    },
    initialize: async () => {},
    shutdown: async () => {},
    health: async () => ({ status: 'healthy', message: 'Smoke adapter ready' }),
    normalizeTransactionId: (transactionId) => transactionId.toLowerCase(),
    createRequest: async (input): Promise<AdapterPaymentDetails> => ({
      adapter: 'usdc',
      network: 'base',
      currency: 'USDC',
      recipientAddress: input.recipient.toLowerCase(),
      tokenAddress: usdcAddress.toLowerCase(),
      amountBaseUnits: parseUnits(input.amount, 6).toString(),
      adapterData: { chainId: 8453, decimals: 6 },
    }),
    verifyTransaction: async (input) => standardFixtureVerification(input, getVerification()),
  };
}

type Merchant = { apiKey: string; merchantId: string; name: string };

describe('production end-to-end smoke flow', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let verificationResult: FixtureVerificationResult;
  let alice: Merchant;
  let bob: Merchant;

  async function createMerchant(name: string, email: string, wallet: string): Promise<Merchant> {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return { apiKey: response.json().apiKey as string, merchantId: response.json().merchant.id as string, name };
  }

  beforeEach(async () => {
    verificationResult = { state: 'not_found' };
    db = await createDatabase();
    const registry = new PaymentAdapterRegistry();
    registry.register(mockUsdcAdapter(() => verificationResult), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    const verification = new PaymentVerificationService(db, registry);
    app = await buildApp({ db, adapterRegistry: registry, verification });
    alice = await createMerchant('Alice Coffee', 'alice@example.com', '0x1111111111111111111111111111111111111111');
    bob = await createMerchant('Bob Books', 'bob@example.com', '0x2222222222222222222222222222222222222222');
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });

  it('exposes unauthenticated health, readiness and OpenAPI probes', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', service: 'tariffia-pay-api' });

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', checks: { database: 'healthy', paymentAdapters: 'healthy' } });

    const openapi = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(openapi.statusCode).toBe(200);
    const document = openapi.json();
    expect(document.openapi).toMatch(/^3\./);
    expect(Object.keys(document.paths).length).toBeGreaterThan(40);
    for (const route of ['/v1/orders', '/v1/payments/{paymentId}', '/v1/revenue/summary']) {
      expect(document.paths[route], route).toBeDefined();
    }
    // Probe responses never include credentials.
    expect(openapi.body).not.toContain(alice.apiKey);
  });

  it('runs the full merchant flow with mock infrastructure and enforces tenant isolation', async () => {
    // 2. Create a merchant-scoped API key (the plaintext secret is returned exactly once).
    const createdKey = await app.inject({
      method: 'POST', url: '/v1/api-keys', headers: auth(alice.apiKey), payload: { name: 'Smoke key' },
    });
    expect(createdKey.statusCode, createdKey.body).toBe(201);
    const apiKeySecret = createdKey.json().secret as string;
    expect(apiKeySecret).toMatch(/^tf_live_/);
    const keyId = createdKey.json().apiKey.id as string;

    // 3. Create a customer.
    const createdCustomer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: auth(alice.apiKey),
      payload: { externalId: 'smoke-customer-1', email: 'buyer@example.com', name: 'Smoke Buyer' },
    });
    expect(createdCustomer.statusCode, createdCustomer.body).toBe(201);
    const customerId = createdCustomer.json().customer.id as string;
    expect(createdCustomer.json().customer.email).toBe('buyer@example.com');

    // 4. Create an order and its payment (stubbed on-chain request, no real funds).
    const createdOrder = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { ...auth(alice.apiKey), 'idempotency-key': randomUUID() },
      payload: { customerId, reference: 'smoke-001', description: 'Smoke coffee', amount: '4.50', currency: 'USDC' },
    });
    expect(createdOrder.statusCode, createdOrder.body).toBe(201);
    const paymentId = createdOrder.json().payment.id as string;
    const orderId = createdOrder.json().order.id as string;
    expect(createdOrder.json().payment.status).toBe('PENDING');
    expect(createdOrder.body).not.toContain('adapterData');

    // 5. Create a hosted payment link.
    const createdLink = await app.inject({
      method: 'POST', url: '/v1/payment-links',
      headers: { ...auth(alice.apiKey), 'idempotency-key': randomUUID() },
      payload: { description: 'Smoke link', amount: '7.25', currency: 'USDC' },
    });
    expect(createdLink.statusCode, createdLink.body).toBe(201);
    expect(createdLink.json().checkoutUrl).toContain(`/p/${createdLink.json().payment.id}`);

    // 6. Read the payment status and order detail.
    const payment = await app.inject({ method: 'GET', url: `/v1/payments/${paymentId}`, headers: auth(alice.apiKey) });
    expect(payment.statusCode).toBe(200);
    expect(payment.json().payment).toMatchObject({ id: paymentId, status: 'PENDING', currency: 'USDC' });
    const order = await app.inject({ method: 'GET', url: `/v1/orders/${orderId}`, headers: auth(alice.apiKey) });
    expect(order.statusCode).toBe(200);
    expect(order.json().order).toMatchObject({ id: orderId, paymentId, paymentStatus: 'PENDING' });

    // Confirm the payment through the existing verification route using the mock adapter
    // (a deterministic fixture, never a real transaction).
    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 800n };
    const confirmation = await app.inject({
      method: 'POST', url: `/v1/payments/${paymentId}/verify`,
      headers: auth(alice.apiKey), payload: { transactionId: `0x${'c'.repeat(64)}` },
    });
    expect(confirmation.statusCode, confirmation.body).toBe(200);
    expect(confirmation.json().payment.status).toBe('CONFIRMED');
    expect((await app.inject({ method: 'GET', url: `/v1/payments/${paymentId}`, headers: auth(alice.apiKey) })).json().payment.status).toBe('CONFIRMED');

    // 7. Merchant isolation: Bob cannot see or read Alice's records.
    expect((await app.inject({ method: 'GET', url: `/v1/payments/${paymentId}`, headers: auth(bob.apiKey) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/customers/${customerId}`, headers: auth(bob.apiKey) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/orders/${orderId}`, headers: auth(bob.apiKey) })).statusCode).toBe(404);
    const bobOrders = await app.inject({ method: 'GET', url: '/v1/orders', headers: auth(bob.apiKey) });
    expect(bobOrders.json().orders).toEqual([]);
    const bobCustomers = await app.inject({ method: 'GET', url: '/v1/customers', headers: auth(bob.apiKey) });
    expect(bobCustomers.json().customers).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/orders', headers: auth('tf_live_invalid') })).statusCode).toBe(401);

    // 8. Revenue reflects the confirmed payment.
    const revenue = await app.inject({ method: 'GET', url: '/v1/revenue/summary', headers: auth(alice.apiKey) });
    expect(revenue.statusCode, revenue.body).toBe(200);
    expect(revenue.json().revenue).toMatchObject({
      currency: 'USDC', totalConfirmed: '4.500000', confirmedPaymentCount: 1, pendingPaymentCount: 1,
    });
    const bobRevenue = await app.inject({ method: 'GET', url: '/v1/revenue/summary', headers: auth(bob.apiKey) });
    expect(bobRevenue.json().revenue).toMatchObject({ totalConfirmed: '0.000000', confirmedPaymentCount: 0 });

    // 9. Usage counters are readable for the merchant.
    const usage = await app.inject({ method: 'GET', url: '/v1/usage', headers: auth(alice.apiKey) });
    expect(usage.statusCode, usage.body).toBe(200);
    for (const category of ['general', 'ai', 'sms']) {
      expect(usage.json().usage[category]).toMatchObject({ used: expect.any(Number) });
    }
    expect(usage.body).not.toContain(apiKeySecret);

    // 10. Audit log records the important action and stays tenant-scoped.
    const audit = await app.inject({ method: 'GET', url: '/v1/audit-log', headers: auth(alice.apiKey) });
    expect(audit.statusCode, audit.body).toBe(200);
    const actions = audit.json().entries.map((entry: { action: string }) => entry.action);
    expect(actions).toContain('api_key.create');
    for (const entry of audit.json().entries) expect(entry.actorId).toBe(alice.merchantId);
    expect(audit.body).not.toContain(apiKeySecret);
    expect((await app.inject({ method: 'GET', url: '/v1/audit-log', headers: auth(bob.apiKey) })).json().entries).toEqual([]);

    // The API key can be revoked at the end of the flow; revocation is also audited.
    expect((await app.inject({ method: 'DELETE', url: `/v1/api-keys/${keyId}`, headers: auth(alice.apiKey) })).statusCode).toBe(204);
    const afterRevoke = await app.inject({ method: 'GET', url: '/v1/audit-log', headers: auth(alice.apiKey) });
    expect(afterRevoke.json().entries.map((entry: { action: string }) => entry.action)).toEqual(
      expect.arrayContaining(['api_key.create', 'api_key.revoke']));
  });
});
