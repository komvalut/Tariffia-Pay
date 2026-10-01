import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { parseUnits } from 'viem';
import type {
  AdapterPaymentDetails,
  PaymentAdapter,
  PaymentVerificationInput,
  PaymentVerificationResult,
} from '../src/payment-adapter.js';
import { PaymentAdapterRegistry } from '../src/payment-adapters/registry.js';
import { LightningAdapter } from '../src/adapters/lightning-adapter.js';
import type { LightningAdapterSettings } from '../src/adapters/lightning-adapter.js';
import { MockLightningProvider } from './fixtures/mock-lightning-provider.js';
import { PaymentVerificationService } from '../src/services/payment-verification-service.js';
import { PaymentCoreService } from '../src/services/payment-core-service.js';
import { SubscriptionService } from '../src/services/subscription-service.js';
import { addBillingInterval } from '../src/services/billing-interval.js';
import { UsdcPaymentDetector } from '../src/services/usdc-payment-detector.js';
import { WebhookDeliveryWorker } from '../src/services/webhook-delivery-worker.js';
import { checkoutUrlForPayment } from '../src/checkout-links.js';
import { checkoutQrContent } from '../src/modules/checkout.js';
import { verifyWebhookSignature } from '../src/webhooks/signature.js';

const usdcAddress = '0x833589fCD6eDb6E08f4c7C32d4F71b54bdA02913';

type FixtureVerificationResult =
  | { state: 'not_found' }
  | { state: 'pending'; detected: boolean; confirmations: number; blockNumber?: bigint }
  | { state: 'rejected'; reason: string }
  | { state: 'failed'; reason: string; blockNumber: bigint }
  | { state: 'verified'; confirmations: number; blockNumber: bigint };

function standardFixtureVerification(input: PaymentVerificationInput, result: FixtureVerificationResult): PaymentVerificationResult {
  if (result.state === 'not_found' || result.state === 'rejected') return result;
  const state = result.state === 'verified' ? 'confirmed' : result.state;
  return {
    ...result,
    receipt: {
      transactionId: input.transactionId,
      network: input.network,
      state,
      amount: input.amount,
      currency: input.currency,
      recipient: input.recipientAddress,
      confirmations: result.confirmations ?? 0,
      blockNumber: 'blockNumber' in result ? result.blockNumber.toString() : null,
    },
  } as PaymentVerificationResult;
}

describe('Tariffia merchant and payment API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: Database;
  let pool: Pool;
  let verificationResult: FixtureVerificationResult;
  let paymentAdapter: PaymentAdapter;
  let adapters: PaymentAdapterRegistry;

  beforeEach(async () => {
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    const pgAdapter = memory.adapters.createPg();
    pool = new pgAdapter.Pool() as Pool;
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
    let phaseOneMigration = await readFile(path.join(migrationsDir, '0001_phase1.sql'), 'utf8');
    phaseOneMigration = phaseOneMigration.split('CREATE OR REPLACE FUNCTION reject_ledger_mutation()')[0] ?? phaseOneMigration;
    await pool.query(phaseOneMigration);
    const phaseTwoMigration = await readFile(path.join(migrationsDir, '0002_usdc_base.sql'), 'utf8');
    // The fixture is empty; pg-mem lacks jsonb_build_object used only for legacy-row backfill.
    const adapterDataBackfillStart = phaseTwoMigration.indexOf('UPDATE payments\n   SET adapter_data = jsonb_build_object');
    if (adapterDataBackfillStart >= 0) {
      const adapterDataBackfillEnd = phaseTwoMigration.indexOf(';', adapterDataBackfillStart);
      await pool.query(phaseTwoMigration.slice(0, adapterDataBackfillStart) + phaseTwoMigration.slice(adapterDataBackfillEnd + 1));
    } else {
      await pool.query(phaseTwoMigration);
    }
    let webhookMigration = await readFile(path.join(migrationsDir, '0003_webhooks.sql'), 'utf8');
    // pg-mem autogenerates a different inline check name, so let migration 0004 replace the event whitelist.
    webhookMigration = webhookMigration.replace(
      /event_type text NOT NULL CHECK \(event_type IN \([\s\S]*?\)\),/,
      'event_type text NOT NULL,',
    );
    await pool.query(webhookMigration);
    await pool.query(await readFile(path.join(migrationsDir, '0004_credit_engine.sql'), 'utf8'));
    await pool.query(await readFile(path.join(migrationsDir, '0005_ai_pricing.sql'), 'utf8'));
    await pool.query(await readFile(path.join(migrationsDir, '0006_invoices_receipts.sql'), 'utf8'));
    await pool.query(await readFile(path.join(migrationsDir, '0007_subscriptions.sql'), 'utf8'));
    await pool.query(await readFile(path.join(migrationsDir, '0008_ai_provider_integration.sql'), 'utf8'));
    await pool.query(await readFile(path.join(migrationsDir, '0009_sms_otp.sql'), 'utf8'));
    await pool.query(await readFile(path.join(migrationsDir, '0010_sms_provider_hardening.sql'), 'utf8'));

    db = {
      query: (text, values = []) => pool.query(text, values),
      transaction: async (run) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await run(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    } as Database;
    verificationResult = { state: 'not_found' };
    paymentAdapter = {
      id: 'usdc',
      manifest: {
        id: 'usdc', name: 'Base USDC', version: 'test', description: 'Test Base USDC adapter',
        capabilities: {
          paymentRequests: true, transactionVerification: true, statusPolling: false, recurringPayments: false,
          automaticDetection: true,
          refunds: false, paymentRequestFormat: 'wallet',
          currencies: ['USDC'], networks: ['base'],
        },
        idempotency: { paymentCreation: 'stable-key-required', transactionVerification: 'network-and-transaction-id' },
      },
      initialize: async () => {},
      shutdown: async () => {},
      health: async () => ({ status: 'healthy', message: 'Test adapter is ready' }),
      normalizeTransactionId: (transactionId) => transactionId.toLowerCase(),
      createRequest: vi.fn(async (input): Promise<AdapterPaymentDetails> => ({
        adapter: 'usdc',
        network: 'base',
        currency: 'USDC',
        recipientAddress: input.recipient.toLowerCase(),
        tokenAddress: usdcAddress.toLowerCase(),
        amountBaseUnits: parseUnits(input.amount, 6).toString(),
        adapterData: { chainId: 8453, decimals: 6 },
      })),
      verifyTransaction: async (input) => standardFixtureVerification(input, verificationResult as FixtureVerificationResult),
    };
    adapters = new PaymentAdapterRegistry();
    adapters.register(paymentAdapter, { enabled: true, settings: {}, isDefault: true });
    await adapters.initialize();
    const verification = new PaymentVerificationService(db, adapters);
    app = await buildApp({ db, adapterRegistry: adapters, verification });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('creates merchant credentials, a customer, and an idempotent order/payment/ledger record', async () => {
    const merchantResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: {
        name: 'Example Store',
        email: 'OWNER@example.com',
        walletAddress: '0x1111111111111111111111111111111111111111',
      },
    });
    expect(merchantResponse.statusCode).toBe(201);
    const { merchant, apiKey } = merchantResponse.json();
    expect(apiKey).toMatch(/^tf_live_/);

    const customerResponse = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'customer-1', email: 'buyer@example.com' },
    });
    expect(customerResponse.statusCode).toBe(201);
    const customerId = customerResponse.json().customer.id as string;

    const payload = {
      customerId,
      reference: 'receipt-001',
      description: 'Coffee',
      amount: '4.50',
      currency: 'USDC',
    };
    const orderResponse = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'checkout-order-0001' },
      payload,
    });
    expect(orderResponse.statusCode).toBe(201);
    expect(orderResponse.headers['idempotency-replayed']).toBe('false');
    const created = orderResponse.json();
    expect(Number(created.order.amount)).toBe(4.5);
    expect(created.order.status).toBe('PENDING');
    expect(created.payment.status).toBe('PENDING');
    expect(created.payment.adapterData).toBeUndefined();
    expect(paymentAdapter.createRequest).toHaveBeenCalledTimes(1);
    expect(paymentAdapter.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.any(String),
    }));
    expect(created.checkoutUrl).toBe(checkoutUrlForPayment(created.payment.id));
    expect(created.qrUrl).toContain(`/p/${created.payment.id}/qr.png`);
    expect(checkoutQrContent(created.payment.id, 'usdc', created.payment.recipientAddress, adapters))
      .toBe(created.checkoutUrl);
    const paymentView = await app.inject({
      method: 'GET', url: `/v1/payments/${created.payment.id}`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(paymentView.json().payment.adapterData).toBeUndefined();

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'checkout-order-0001' },
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().order.id).toBe(created.order.id);
    expect(replay.json().payment.id).toBe(created.payment.id);
    expect(paymentAdapter.createRequest).toHaveBeenCalledTimes(1);

    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'checkout-order-0001' },
      payload: { ...payload, amount: '5.00' },
    });
    expect(conflict.statusCode).toBe(409);

    const ledger = await app.inject({
      method: 'GET',
      url: '/v1/ledger',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().entries).toHaveLength(1);
    expect(ledger.json().entries[0].entryType).toBe('PAYMENT_CREATED');
    expect(Number(ledger.json().entries[0].amount)).toBe(4.5);

    expect(merchant.id).toBeTruthy();
  });

  it('does not permit merchant creation without the admin secret', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/admin/merchants', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('reports adapter status to admins, blocks new payments when disabled, and preserves existing payments', async () => {
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Adapter Store', email: 'adapter-store@example.com', walletAddress: '0x1212121212121212121212121212121212121212' },
    });
    const apiKey = merchant.json().apiKey as string;
    const created = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'adapter-enabled-order' },
      payload: { description: 'Before disable', amount: '2.50', adapter: 'usdc' },
    });
    expect(created.statusCode).toBe(201);
    const payment = created.json().payment;
    const transactionHash = `0x${'c'.repeat(64)}`;
    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 800n };
    const confirmation = await app.inject({
      method: 'POST', url: `/v1/payments/${payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionId: transactionHash },
    });
    expect(confirmation.statusCode).toBe(200);

    await app.close();
    const disabledAdapters = new PaymentAdapterRegistry();
    disabledAdapters.register(paymentAdapter, { enabled: false, settings: {}, isDefault: true });
    await disabledAdapters.initialize();
    app = await buildApp({ db, adapterRegistry: disabledAdapters });

    const details = await app.inject({
      method: 'GET', url: `/v1/payments/${payment.id}`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(details.statusCode).toBe(200);
    expect(details.json().payment.status).toBe('CONFIRMED');
    const confirmedRetry = await app.inject({
      method: 'POST', url: `/v1/payments/${payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionId: transactionHash },
    });
    expect(confirmedRetry.statusCode).toBe(200);
    expect(confirmedRetry.json().payment.alreadyConfirmed).toBe(true);

    const newPayment = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'adapter-disabled-order' },
      payload: { description: 'After disable', amount: '2.50', adapter: 'usdc' },
    });
    expect(newPayment.statusCode).toBe(503);
    expect(newPayment.json().error).toBe('adapter_unavailable');
    expect(paymentAdapter.createRequest).toHaveBeenCalledTimes(1);

    const unauthorized = await app.inject({ method: 'GET', url: '/v1/admin/payment-adapters' });
    expect(unauthorized.statusCode).toBe(401);
    const adapters = await app.inject({
      method: 'GET', url: '/v1/admin/payment-adapters',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
    });
    expect(adapters.statusCode).toBe(200);
    expect(adapters.json().adapters).toMatchObject([{ id: 'usdc', status: 'disabled' }]);
    expect(adapters.body).not.toContain('adapterData');
  });

  it('creates a Lightning invoice and confirms provider settlement through Payment Core, Ledger, and Webhooks', async () => {
    const provider = new MockLightningProvider();
    const registry = new PaymentAdapterRegistry();
    registry.register(paymentAdapter, { enabled: true, settings: {}, isDefault: true });
    const lightningSettings: LightningAdapterSettings = {
      network: 'mainnet', minimumAmountSats: 1, maximumAmountSats: 100_000,
      invoiceExpirySeconds: 3600,
    };
    registry.register(new LightningAdapter(provider), { enabled: true, settings: lightningSettings });
    await registry.initialize();
    await app.close();
    app = await buildApp({ db, adapterRegistry: registry });

    provider.available = false;
    const unavailableMethods = await app.inject({ method: 'GET', url: '/v1/public/payment-methods' });
    expect(unavailableMethods.json().methods.map((method: { id: string }) => method.id)).toEqual(['usdc']);
    provider.available = true;
    const availableMethods = await app.inject({ method: 'GET', url: '/v1/public/payment-methods' });
    expect(availableMethods.json().methods.map((method: { id: string }) => method.id)).toEqual(['usdc', 'lightning']);
    const selectedLightning = availableMethods.json().methods.find((method: { id: string }) => method.id === 'lightning');

    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Lightning Store', email: 'lightning-store@example.com', walletAddress: '0x3434343434343434343434343434343434343434' },
    });
    const apiKey = merchant.json().apiKey as string;
    const created = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'lightning-invoice-order-1' },
      payload: { description: 'Lightning order', amount: '25', currency: 'SAT', adapter: selectedLightning.id },
    });
    expect(created.statusCode).toBe(201);
    const payment = created.json().payment;
    expect(payment).toMatchObject({
      adapter: 'lightning', network: 'lightning-mainnet', currency: 'SAT',
      amountBaseUnits: '25000', recipientAddress: expect.stringMatching(/^lnmock_mainnet_/),
    });
    expect(payment.adapterData).toBeUndefined();
    const invoice = [...provider.invoicesCreated.values()][0]!;

    expect(payment.paymentMethod).toMatchObject({ id: 'lightning', name: 'Bitcoin Lightning', paymentRequestFormat: 'invoice' });
    expect(payment.paymentRequest).toBe(invoice.paymentRequest);
    expect(checkoutQrContent(payment.id, 'lightning', invoice.paymentRequest, registry)).toBe(invoice.paymentRequest);
    const qr = await app.inject({ method: 'GET', url: `/p/${payment.id}/qr.png` });
    expect(qr.statusCode).toBe(200);
    expect(qr.headers['content-type']).toBe('image/png');

    const pending = await app.inject({ method: 'GET', url: `/v1/public/payments/${payment.id}` });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().payment.status).toBe('PENDING');

    provider.setState(invoice.paymentHash, 'settled');
    const confirmed = await app.inject({ method: 'GET', url: `/v1/public/payments/${payment.id}` });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().payment).toMatchObject({
      status: 'CONFIRMED', orderStatus: 'PAID', transactionId: invoice.paymentHash,
      paymentMethod: { id: 'lightning', paymentRequestFormat: 'invoice' },
    });
    const confirmedRetry = await app.inject({ method: 'GET', url: `/v1/public/payments/${payment.id}` });
    expect(confirmedRetry.json().payment.status).toBe('CONFIRMED');
    const order = await app.inject({ method: 'GET', url: `/v1/orders/${created.json().order.id}`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(order.json().order.status).toBe('PAID');

    const ledger = await app.inject({ method: 'GET', url: '/v1/ledger', headers: { authorization: `Bearer ${apiKey}` } });
    expect(ledger.json().entries.map((entry: { entryType: string }) => entry.entryType)).toEqual(expect.arrayContaining([
      'PAYMENT_CONFIRMED', 'PAYMENT_DETECTED', 'PAYMENT_CREATED',
    ]));
    expect(ledger.json().entries).toHaveLength(3);
    const webhookEvents = await db.query<{ event_type: string; payload: { data: { adapter?: string; transactionId?: string } } }>(
      'SELECT event_type, payload FROM webhook_events WHERE merchant_id = $1 ORDER BY created_at ASC', [merchant.json().merchant.id],
    );
    expect(webhookEvents.rows.map((event) => event.event_type)).toContain('payment.confirmed');
    expect(webhookEvents.rows.filter((event) => event.event_type === 'payment.confirmed')).toHaveLength(1);
    expect(webhookEvents.rows.find((event) => event.event_type === 'payment.confirmed')?.payload.data)
      .toMatchObject({ adapter: 'lightning', transactionId: invoice.paymentHash });
    expect(webhookEvents.rows.map((event) => event.event_type)).toEqual(expect.arrayContaining(['invoice.issued', 'receipt.issued']));
    const lightningInvoices = await app.inject({ method: 'GET', url: '/v1/invoices', headers: { authorization: `Bearer ${apiKey}` } });
    expect(lightningInvoices.json().invoices).toHaveLength(1);
    expect(lightningInvoices.json().invoices[0]).toMatchObject({
      paymentMethod: { id: 'lightning', name: 'Bitcoin Lightning' }, amount: '25', currency: 'SAT',
      paymentStatus: 'CONFIRMED', transactionId: invoice.paymentHash,
    });
    const lightningReceipts = await app.inject({ method: 'GET', url: '/v1/receipts', headers: { authorization: `Bearer ${apiKey}` } });
    expect(lightningReceipts.json().receipts).toHaveLength(1);
    const lightningReceipt = lightningReceipts.json().receipts[0];
    expect(lightningReceipt.publicId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const publicLightningReceipt = await app.inject({ method: 'GET', url: `/v1/public/receipts/${lightningReceipt.publicId}` });
    expect(publicLightningReceipt.json().receipt).toMatchObject({
      paymentMethod: 'Bitcoin Lightning', amount: '25', currency: 'SAT', paymentStatus: 'CONFIRMED',
    });

    await app.close();
    const disabledRegistry = new PaymentAdapterRegistry();
    disabledRegistry.register(paymentAdapter, { enabled: true, settings: {}, isDefault: true });
    disabledRegistry.register(new LightningAdapter(provider), { enabled: false, settings: lightningSettings });
    await disabledRegistry.initialize();
    app = await buildApp({ db, adapterRegistry: disabledRegistry });
    const existing = await app.inject({
      method: 'GET', url: `/v1/payments/${payment.id}`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(existing.statusCode).toBe(200);
    expect(existing.json().payment.status).toBe('CONFIRMED');

    const rejected = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'lightning-disabled-order' },
      payload: { description: 'Disabled Lightning order', amount: '25', currency: 'SAT', adapter: 'lightning' },
    });
    expect(rejected.statusCode).toBe(503);
    expect(provider.createCalls).toHaveLength(1);
    const disabledMethods = await app.inject({ method: 'GET', url: '/v1/public/payment-methods' });
    expect(disabledMethods.json().methods.map((method: { id: string }) => method.id)).toEqual(['usdc']);
    const adminAdapters = await app.inject({
      method: 'GET', url: '/v1/admin/payment-adapters',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
    });
    expect(adminAdapters.json().adapters).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lightning', status: 'disabled', capabilities: expect.objectContaining({ currencies: ['SAT'] }) }),
    ]));
    expect(adminAdapters.body).not.toContain('privateKey');
  });

  it('lists API key metadata without exposing hashes and supports revocation', async () => {
    const merchant = await app.inject({
      method: 'POST',
      url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Key Store', email: 'keys@example.com', walletAddress: '0x3333333333333333333333333333333333333333' },
    });
    const firstKey = merchant.json().apiKey as string;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${firstKey}` },
      payload: { name: 'CI deploy' },
    });
    expect(created.statusCode).toBe(201);
    const secondKey = created.json().secret as string;
    const keyId = created.json().apiKey.id as string;
    const list = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: { authorization: `Bearer ${firstKey}` } });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(secondKey);
    expect(JSON.stringify(list.json())).not.toContain('key_hash');

    const revoked = await app.inject({ method: 'DELETE', url: `/v1/api-keys/${keyId}`, headers: { authorization: `Bearer ${firstKey}` } });
    expect(revoked.statusCode).toBe(204);
    const rejected = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: { authorization: `Bearer ${secondKey}` } });
    expect(rejected.statusCode).toBe(401);
  });

  it('does not expose customers to a different merchant', async () => {
    const createMerchant = async (email: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/admin/merchants',
        headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
        payload: { name: 'Store', email, walletAddress: '0x2222222222222222222222222222222222222222' },
      });
      return response.json().apiKey as string;
    };
    const firstKey = await createMerchant('first@example.com');
    const secondKey = await createMerchant('second@example.com');
    const customer = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${firstKey}` },
      payload: { externalId: 'private-customer' },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customer.json().customer.id}`,
      headers: { authorization: `Bearer ${secondKey}` },
    });
    expect(response.statusCode).toBe(404);

    const order = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${firstKey}`, 'idempotency-key': 'first-store-order-01' },
      payload: { description: 'Private order', amount: '1.00' },
    });
    const otherMerchantOrder = await app.inject({
      method: 'GET',
      url: `/v1/orders/${order.json().order.id}`,
      headers: { authorization: `Bearer ${secondKey}` },
    });
    expect(otherMerchantOrder.statusCode).toBe(404);
  });

  it('atomically confirms a verified transfer once across payment, order, and ledger', async () => {
    const merchant = await app.inject({
      method: 'POST',
      url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Paid Store', email: 'paid@example.com', walletAddress: '0x4444444444444444444444444444444444444444' },
    });
    const apiKey = merchant.json().apiKey as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Receipt Customer', email: 'receipt-customer@example.com' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'paid-store-order-001' },
      payload: { customerId: customer.json().customer.id, description: 'Invoice 1', amount: '12.34' },
    });
    const { order, payment } = created.json();
    const transactionHash = `0x${'a'.repeat(64)}`;
    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 123456n };

    const pendingInvoices = await app.inject({ method: 'GET', url: '/v1/invoices', headers: { authorization: `Bearer ${apiKey}` } });
    expect(pendingInvoices.statusCode).toBe(200);
    expect(pendingInvoices.json().invoices).toHaveLength(0);

    const first = await app.inject({
      method: 'POST',
      url: `/v1/payments/${payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { transactionHash },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().payment.status).toBe('CONFIRMED');

    const paidOrder = await app.inject({
      method: 'GET',
      url: `/v1/orders/${order.id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(paidOrder.json().order.status).toBe('PAID');
    expect(paidOrder.json().order.paymentStatus).toBe('CONFIRMED');

    const retry = await app.inject({
      method: 'POST',
      url: `/v1/payments/${payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { transactionHash },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().payment.alreadyConfirmed).toBe(true);

    const ledger = await app.inject({ method: 'GET', url: '/v1/ledger', headers: { authorization: `Bearer ${apiKey}` } });
    expect(ledger.json().entries).toHaveLength(3);
    expect(ledger.json().entries.map((entry: { entryType: string }) => entry.entryType)).toContain('PAYMENT_DETECTED');
    const confirmation = ledger.json().entries.find((entry: { entryType: string }) => entry.entryType === 'PAYMENT_CONFIRMED');
    expect(confirmation.reference).toBe(transactionHash);

    const invoices = await app.inject({ method: 'GET', url: '/v1/invoices', headers: { authorization: `Bearer ${apiKey}` } });
    expect(invoices.json().invoices).toHaveLength(1);
    const invoice = invoices.json().invoices[0];
    expect(invoice).toMatchObject({
      invoiceNumber: expect.stringMatching(/^INV-\d{4}-[A-F0-9]{32}$/),
      paymentId: payment.id, orderId: order.id, paymentStatus: 'CONFIRMED',
      amount: '12.34', currency: 'USDC', paymentMethod: { id: 'usdc', name: 'Base USDC' },
      transactionId: transactionHash, merchant: { name: 'Paid Store' },
      customer: { id: customer.json().customer.id, name: 'Receipt Customer', email: 'receipt-customer@example.com' },
    });
    expect(invoice.receipt.publicId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invoice.receipt.publicId).not.toBe(invoice.id);

    const receipts = await app.inject({ method: 'GET', url: '/v1/receipts', headers: { authorization: `Bearer ${apiKey}` } });
    expect(receipts.json().receipts).toHaveLength(1);
    const receipt = receipts.json().receipts[0];
    expect(receipt).toMatchObject({
      invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, paymentId: payment.id,
      paymentStatus: 'CONFIRMED', transactionId: transactionHash,
    });

    const publicReceipt = await app.inject({ method: 'GET', url: `/v1/public/receipts/${receipt.publicId}` });
    expect(publicReceipt.statusCode).toBe(200);
    expect(publicReceipt.json().receipt).toMatchObject({
      invoiceNumber: invoice.invoiceNumber, merchantName: 'Paid Store',
      amount: '12.34', currency: 'USDC', paymentMethod: 'Base USDC', paymentStatus: 'CONFIRMED',
    });
    expect(publicReceipt.body).not.toContain('receipt-customer@example.com');
    expect(publicReceipt.body).not.toContain('paid@example.com');
    const documentEvents = await db.query<{ event_type: string; payload: { data: { invoiceNumber?: string; receiptUrl?: string } } }>(
      `SELECT event_type, payload FROM webhook_events
        WHERE event_type IN ('invoice.issued', 'receipt.issued')`,
    );
    expect(documentEvents.rows.map((event) => event.event_type)).toEqual(expect.arrayContaining(['invoice.issued', 'receipt.issued']));
    expect(documentEvents.rows.find((event) => event.event_type === 'invoice.issued')?.payload.data)
      .toMatchObject({ invoiceNumber: invoice.invoiceNumber, receiptUrl: invoice.receipt.publicUrl });
    const publicReceiptPage = await app.inject({ method: 'GET', url: `/r/${receipt.publicId}` });
    expect(publicReceiptPage.statusCode).toBe(200);
    expect(publicReceiptPage.body).toContain('Download PDF receipt');

    const firstPdf = await app.inject({ method: 'GET', url: `/v1/public/receipts/${receipt.publicId}.pdf` });
    const repeatedPdf = await app.inject({ method: 'GET', url: `/v1/public/receipts/${receipt.publicId}.pdf` });
    expect(firstPdf.statusCode).toBe(200);
    expect(firstPdf.headers['content-type']).toContain('application/pdf');
    expect(firstPdf.rawPayload.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
    expect(firstPdf.rawPayload).toEqual(repeatedPdf.rawPayload);
    const invoicePdf = await app.inject({
      method: 'GET', url: `/v1/invoices/${invoice.id}.pdf`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(invoicePdf.statusCode).toBe(200);
    expect(invoicePdf.rawPayload.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
    expect((await app.inject({
      method: 'GET', url: `/v1/invoices/${invoice.id}`, headers: { authorization: `Bearer ${apiKey}` },
    })).json().invoice.invoiceNumber).toBe(invoice.invoiceNumber);
    expect((await app.inject({
      method: 'GET', url: `/v1/receipts/${receipt.id}`, headers: { authorization: `Bearer ${apiKey}` },
    })).json().receipt.invoiceNumber).toBe(invoice.invoiceNumber);
    const merchantReceiptPdf = await app.inject({
      method: 'GET', url: `/v1/receipts/${receipt.id}.pdf`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(merchantReceiptPdf.statusCode).toBe(200);
    expect(merchantReceiptPdf.rawPayload.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');

    const unauthorized = await app.inject({ method: 'GET', url: '/v1/invoices' });
    expect(unauthorized.statusCode).toBe(401);
    const otherMerchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Other Receipt Store', email: 'other-receipt@example.com', walletAddress: '0x4545454545454545454545454545454545454545' },
    });
    const otherInvoice = await app.inject({
      method: 'GET', url: `/v1/invoices/${invoice.id}`, headers: { authorization: `Bearer ${otherMerchant.json().apiKey}` },
    });
    expect(otherInvoice.statusCode).toBe(404);
    const otherReceipt = await app.inject({
      method: 'GET', url: `/v1/receipts/${receipt.id}`, headers: { authorization: `Bearer ${otherMerchant.json().apiKey}` },
    });
    expect(otherReceipt.statusCode).toBe(404);
    const adminInvoices = await app.inject({ method: 'GET', url: '/v1/admin/invoices', headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' } });
    const adminReceipts = await app.inject({ method: 'GET', url: '/v1/admin/receipts', headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' } });
    expect(adminInvoices.json().invoices).toHaveLength(1);
    expect(adminReceipts.json().receipts).toHaveLength(1);

    const secondOrder = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'paid-store-order-002' },
      payload: { description: 'Invoice 2', amount: '2.00' },
    });
    const secondPayment = secondOrder.json().payment;
    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 123457n };
    const secondConfirmation = await app.inject({
      method: 'POST', url: `/v1/payments/${secondPayment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash: `0x${'b'.repeat(64)}` },
    });
    expect(secondConfirmation.statusCode).toBe(200);
    const allInvoices = await app.inject({ method: 'GET', url: '/v1/invoices', headers: { authorization: `Bearer ${apiKey}` } });
    const allReceipts = await app.inject({ method: 'GET', url: '/v1/receipts', headers: { authorization: `Bearer ${apiKey}` } });
    expect(allInvoices.json().invoices).toHaveLength(2);
    expect(new Set(allInvoices.json().invoices.map((item: { invoiceNumber: string }) => item.invoiceNumber)).size).toBe(2);
    expect(allReceipts.json().receipts).toHaveLength(2);
  });

  it('creates plans and manual subscriptions with trials, capability checks, and lifecycle controls', async () => {
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Plan Store', email: 'plan-store@example.com', walletAddress: '0x5656565656565656565656565656565656565656' },
    });
    const apiKey = merchant.json().apiKey as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Plan Customer', email: 'plan-customer@example.com' },
    });
    const badPlan = await app.inject({
      method: 'POST', url: '/v1/subscription-plans', headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Invalid', amount: '0', interval: 'MONTH', intervalCount: 0 },
    });
    expect(badPlan.statusCode).toBe(400);
    const planResponse = await app.inject({
      method: 'POST', url: '/v1/subscription-plans', headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Monthly', description: 'Monthly service', amount: '12.50', interval: 'MONTH', intervalCount: 1 },
    });
    expect(planResponse.statusCode).toBe(201);
    const plan = planResponse.json().plan;
    expect(plan).toMatchObject({ amount: '12.5', currency: 'USDC', interval: 'MONTH', intervalCount: 1, trialDays: 0 });

    const unsupportedAuto = await app.inject({
      method: 'POST', url: '/v1/subscriptions',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'subscription-auto-not-supported' },
      payload: { planId: plan.id, customerId: customer.json().customer.id, adapter: 'usdc', billingMode: 'AUTOMATIC' },
    });
    expect(unsupportedAuto.statusCode).toBe(422);
    expect(unsupportedAuto.json().error).toBe('recurring_unavailable');

    const subscriptionInput = { planId: plan.id, customerId: customer.json().customer.id, adapter: 'usdc', billingMode: 'MANUAL' };
    const created = await app.inject({
      method: 'POST', url: '/v1/subscriptions',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'subscription-manual-create-001' },
      payload: subscriptionInput,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().subscription).toMatchObject({ status: 'PAST_DUE', billingMode: 'MANUAL', paymentMethod: { id: 'usdc' } });
    expect(created.json().payment.status).toBe('PENDING');
    expect(created.json().billingCycles).toMatchObject([{ cycleNumber: 1, status: 'PENDING', attempts: [{ status: 'PENDING' }] }]);
    expect(paymentAdapter.createRequest).toHaveBeenCalledTimes(1);

    const replay = await app.inject({
      method: 'POST', url: '/v1/subscriptions',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'subscription-manual-create-001' },
      payload: subscriptionInput,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().subscription.id).toBe(created.json().subscription.id);
    expect(replay.json().payment.id).toBe(created.json().payment.id);
    expect(paymentAdapter.createRequest).toHaveBeenCalledTimes(1);
    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 850n };
    const activated = await app.inject({
      method: 'POST', url: `/v1/payments/${created.json().payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash: `0x${'9'.repeat(64)}` },
    });
    expect(activated.statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET', url: `/v1/subscriptions/${created.json().subscription.id}`, headers: { authorization: `Bearer ${apiKey}` },
    })).json().subscription.status).toBe('ACTIVE');
    const earlyRenewal = await app.inject({
      method: 'POST', url: `/v1/subscriptions/${created.json().subscription.id}/renew`,
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'subscription-renew-too-early' }, payload: {},
    });
    expect(earlyRenewal.statusCode).toBe(409);

    const trialPlan = await app.inject({
      method: 'POST', url: '/v1/subscription-plans', headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Trial', amount: '5.00', interval: 'WEEK', intervalCount: 2, trialDays: 14 },
    });
    const trialSubscription = await app.inject({
      method: 'POST', url: '/v1/subscriptions',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'subscription-trial-create-001' },
      payload: { planId: trialPlan.json().plan.id, customerId: customer.json().customer.id },
    });
    expect(trialSubscription.statusCode).toBe(201);
    expect(trialSubscription.json()).toMatchObject({
      subscription: { status: 'ACTIVE', trialDays: 14 }, payment: null, order: null, billingCycles: [],
    });
    expect(Date.parse(trialSubscription.json().subscription.trialEndsAt)).toBeGreaterThan(Date.now());
    const trialSubscriptionId = trialSubscription.json().subscription.id as string;
    await db.query('UPDATE subscriptions SET ends_at = $2 WHERE id = $1', [trialSubscriptionId, new Date(Date.now() - 1000)]);
    const lifecycle = new SubscriptionService(db, new PaymentCoreService(db, adapters), adapters);
    await lifecycle.runAutomaticRenewals();
    expect((await app.inject({
      method: 'GET', url: `/v1/subscriptions/${trialSubscriptionId}`, headers: { authorization: `Bearer ${apiKey}` },
    })).json().subscription.status).toBe('EXPIRED');

    const subscriptionId = created.json().subscription.id as string;
    expect((await app.inject({
      method: 'GET', url: `/v1/customers/${customer.json().customer.id}/subscriptions`,
      headers: { authorization: `Bearer ${apiKey}` },
    })).json().subscriptions).toHaveLength(2);
    const otherMerchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Other Plan Store', email: 'other-plan@example.com', walletAddress: '0x6767676767676767676767676767676767676767' },
    });
    const crossTenant = await app.inject({
      method: 'GET', url: `/v1/subscriptions/${subscriptionId}`,
      headers: { authorization: `Bearer ${otherMerchant.json().apiKey}` },
    });
    expect(crossTenant.statusCode).toBe(404);

    expect((await app.inject({
      method: 'PATCH', url: `/v1/subscriptions/${subscriptionId}`, headers: { authorization: `Bearer ${apiKey}` },
      payload: { action: 'pause' },
    })).json().subscription.status).toBe('PAUSED');
    expect((await app.inject({
      method: 'PATCH', url: `/v1/subscriptions/${subscriptionId}`, headers: { authorization: `Bearer ${apiKey}` },
      payload: { action: 'resume' },
    })).json().subscription.status).toBe('ACTIVE');
    expect((await app.inject({
      method: 'PATCH', url: `/v1/subscriptions/${subscriptionId}`, headers: { authorization: `Bearer ${apiKey}` },
      payload: { action: 'cancel' },
    })).json().subscription.status).toBe('CANCELLED');
    const admin = await app.inject({
      method: 'GET', url: '/v1/admin/subscriptions',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
    });
    expect(admin.json().subscriptions).toHaveLength(2);
  });

  it('records failed and expired subscription attempts and requires a new idempotency key for retry', async () => {
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Past Due Store', email: 'past-due@example.com', walletAddress: '0x7878787878787878787878787878787878787878' },
    });
    const apiKey = merchant.json().apiKey as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'past-due-customer' },
    });
    const plan = await app.inject({
      method: 'POST', url: '/v1/subscription-plans', headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Past due plan', amount: '3.00', interval: 'MONTH' },
    });
    const created = await app.inject({
      method: 'POST', url: '/v1/subscriptions',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'past-due-subscription-001' },
      payload: { planId: plan.json().plan.id, customerId: customer.json().customer.id },
    });
    const subscriptionId = created.json().subscription.id as string;
    const firstPaymentId = created.json().payment.id as string;
    verificationResult = { state: 'failed', reason: 'matching USDC transfer reverted', blockNumber: 700n };
    const failed = await app.inject({
      method: 'POST', url: `/v1/payments/${firstPaymentId}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash: `0x${'d'.repeat(64)}` },
    });
    expect(failed.statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET', url: `/v1/subscriptions/${subscriptionId}`, headers: { authorization: `Bearer ${apiKey}` },
    })).json().subscription.status).toBe('PAST_DUE');

    const retry = await app.inject({
      method: 'POST', url: `/v1/subscriptions/${subscriptionId}/renew`,
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'past-due-retry-001' }, payload: {},
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().billingCycles).toHaveLength(1);
    expect(retry.json().billingCycles[0].attempts).toHaveLength(2);
    const repeat = await app.inject({
      method: 'POST', url: `/v1/subscriptions/${subscriptionId}/renew`,
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'past-due-retry-001' }, payload: {},
    });
    expect(repeat.json().payment.id).toBe(retry.json().payment.id);
    expect(retry.json().billingCycles[0].attempts.map((attempt: { attemptNumber: number }) => attempt.attemptNumber))
      .toEqual([2, 1]);

    await db.query('UPDATE payments SET expires_at = $2 WHERE id = $1', [retry.json().payment.id, new Date(Date.now() - 60_000)]);
    const lifecycle = new SubscriptionService(db, new PaymentCoreService(db, adapters), adapters);
    const expirationWorker = new WebhookDeliveryWorker(db, fetch, [lifecycle]);
    await expirationWorker.runOnce();
    const history = await app.inject({
      method: 'GET', url: `/v1/subscriptions/${subscriptionId}/billing-cycles`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(history.json().billingCycles[0]).toMatchObject({ status: 'EXPIRED', attempts: [{ status: 'EXPIRED' }, { status: 'FAILED' }] });
    expect((await app.inject({
      method: 'GET', url: `/v1/subscriptions/${subscriptionId}`, headers: { authorization: `Bearer ${apiKey}` },
    })).json().subscription.status).toBe('PAST_DUE');
    expect(paymentAdapter.createRequest).toHaveBeenCalledTimes(2);
  });

  it('runs automatic cycle creation only for adapters declaring recurring support and does not duplicate a cycle', async () => {
    Object.defineProperty(paymentAdapter, 'manifest', {
      value: {
        ...paymentAdapter.manifest,
        capabilities: { ...paymentAdapter.manifest.capabilities, recurringPayments: true },
      },
    });
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Auto Store', email: 'auto-store@example.com', walletAddress: '0x8989898989898989898989898989898989898989' },
    });
    const apiKey = merchant.json().apiKey as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'auto-customer' },
    });
    const plan = await app.inject({
      method: 'POST', url: '/v1/subscription-plans', headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Auto plan', amount: '1.00', interval: 'MONTH' },
    });
    const created = await app.inject({
      method: 'POST', url: '/v1/subscriptions',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'auto-subscription-create-001' },
      payload: { planId: plan.json().plan.id, customerId: customer.json().customer.id, adapter: 'usdc', billingMode: 'AUTOMATIC' },
    });
    expect(created.statusCode).toBe(201);
    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 901n };
    const payment = created.json().payment;
    const confirmed = await app.inject({
      method: 'POST', url: `/v1/payments/${payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash: `0x${'e'.repeat(64)}` },
    });
    expect(confirmed.statusCode).toBe(200);
    const subscriptionId = created.json().subscription.id as string;
    await db.query('UPDATE subscriptions SET next_billing_at = $2 WHERE id = $1', [subscriptionId, new Date(Date.now() - 1000)]);

    const billing = new SubscriptionService(db, new PaymentCoreService(db, adapters), adapters);
    await expect(billing.runAutomaticRenewals()).resolves.toMatchObject({ due: 1, started: 1 });
    expect(paymentAdapter.createRequest).toHaveBeenCalledTimes(2);
    await expect(billing.runAutomaticRenewals()).resolves.toMatchObject({ due: 1, started: 1 });
    expect(paymentAdapter.createRequest).toHaveBeenCalledTimes(2);
    const cycles = await app.inject({
      method: 'GET', url: `/v1/subscriptions/${subscriptionId}/billing-cycles`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(cycles.json().billingCycles).toHaveLength(2);
    expect(cycles.json().billingCycles[0].status).toBe('PENDING');
    expect(cycles.json().billingCycles[1].status).toBe('PAID');
  });

  it('does not confirm mismatched on-chain transfers', async () => {
    const merchant = await app.inject({
      method: 'POST',
      url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Reject Store', email: 'reject@example.com', walletAddress: '0x5555555555555555555555555555555555555555' },
    });
    const apiKey = merchant.json().apiKey as string;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'reject-store-order-01' },
      payload: { description: 'Invoice 2', amount: '2.00' },
    });
    verificationResult = { state: 'rejected', reason: 'wrong recipient' };
    const response = await app.inject({
      method: 'POST',
      url: `/v1/payments/${created.json().payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { transactionHash: `0x${'b'.repeat(64)}` },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('transaction_verification_failed');
    const payment = await app.inject({
      method: 'GET',
      url: `/v1/payments/${created.json().payment.id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(payment.json().payment.status).toBe('PENDING');
    expect(payment.json().payment.txHash).toBeNull();
  });

  it('prevents one transaction hash from confirming two payments', async () => {
    const merchant = await app.inject({
      method: 'POST',
      url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Unique TX Store', email: 'unique-tx@example.com', walletAddress: '0x7777777777777777777777777777777777777777' },
    });
    const apiKey = merchant.json().apiKey as string;
    const createOrder = async (idempotencyKey: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': idempotencyKey },
        payload: { description: 'Unique transaction test', amount: '1.00' },
      });
      return response.json();
    };
    const first = await createOrder('unique-tx-order-001');
    const second = await createOrder('unique-tx-order-002');
    const transactionHash = `0x${'e'.repeat(64)}`;
    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 222n };

    const firstResult = await app.inject({
      method: 'POST', url: `/v1/payments/${first.payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash },
    });
    expect(firstResult.statusCode).toBe(200);
    const duplicate = await app.inject({
      method: 'POST', url: `/v1/payments/${second.payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash },
    });
    expect(duplicate.statusCode).toBe(409);
    const secondPayment = await app.inject({
      method: 'GET', url: `/v1/payments/${second.payment.id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(secondPayment.json().payment.status).toBe('PENDING');
    const ledger = await app.inject({ method: 'GET', url: '/v1/ledger', headers: { authorization: `Bearer ${apiKey}` } });
    expect(ledger.json().entries.filter((entry: { entryType: string }) => entry.entryType === 'PAYMENT_CONFIRMED')).toHaveLength(1);
  });

  it('stores detected transfers as pending until the adapter sees enough confirmations', async () => {
    const merchant = await app.inject({
      method: 'POST',
      url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Confirmations Store', email: 'confirmations@example.com', walletAddress: '0x8888888888888888888888888888888888888888' },
    });
    const apiKey = merchant.json().apiKey as string;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'confirmations-order-01' },
      payload: { description: 'Wait for confirmations', amount: '5.00' },
    });
    const paymentId = created.json().payment.id as string;
    const transactionHash = `0x${'f'.repeat(64)}`;
    verificationResult = { state: 'pending', detected: true, confirmations: 3, blockNumber: 500n };
    const detected = await app.inject({
      method: 'POST', url: `/v1/payments/${paymentId}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash },
    });
    expect(detected.statusCode).toBe(202);
    expect(detected.json().payment.status).toBe('DETECTED');

    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 500n };
    const confirmed = await app.inject({
      method: 'POST', url: `/v1/payments/${paymentId}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().payment.status).toBe('CONFIRMED');
  });

  it('records an unmined transaction hint and rejects a second payment attempt for the same request', async () => {
    const merchant = await app.inject({
      method: 'POST',
      url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Pending Hash Store', email: 'pending-hash@example.com', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    const apiKey = merchant.json().apiKey as string;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'pending-hash-link-01' },
      payload: { description: 'Pending chain payment', amount: '6.00' },
    });
    const paymentId = created.json().payment.id as string;
    const submittedHash = `0x${'2'.repeat(64)}`;
    verificationResult = { state: 'not_found' };

    const firstSubmission = await app.inject({
      method: 'POST',
      url: `/v1/public/payments/${paymentId}/verify`,
      payload: { transactionHash: submittedHash },
    });
    expect(firstSubmission.statusCode).toBe(202);
    const otherHash = await app.inject({
      method: 'POST',
      url: `/v1/public/payments/${paymentId}/verify`,
      payload: { transactionHash: `0x${'3'.repeat(64)}` },
    });
    expect(otherHash.statusCode).toBe(409);

    const payment = await app.inject({
      method: 'GET', url: `/v1/payments/${paymentId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(payment.json().payment.status).toBe('PENDING');
    expect(payment.json().payment.txHash).toBe(submittedHash);
  });

  it('detects a matching USDC transfer and routes it through the same confirmation ledger', async () => {
    const merchant = await app.inject({
      method: 'POST',
      url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Detected Store', email: 'detected@example.com', walletAddress: '0x6666666666666666666666666666666666666666' },
    });
    const apiKey = merchant.json().apiKey as string;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'detected-order-0001' },
      payload: { description: 'Detected payment', amount: '3.25' },
    });
    const transactionHash = `0x${'c'.repeat(64)}`;
    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 99n };
    let head = 100n;
    const detector = new UsdcPaymentDetector(db, {
      id: 'usdc',
      network: 'base',
      getBlockNumber: async () => head,
      scanTransfers: async () => [{
        transactionHash,
        recipientAddress: '0x6666666666666666666666666666666666666666',
        amountBaseUnits: 3_250_000n,
        blockNumber: 99n,
      }],
    }, verificationServiceForTest());

    await detector.pollOnce();
    head = 101n;
    await detector.pollOnce();

    const payment = await app.inject({
      method: 'GET',
      url: `/v1/payments/${created.json().payment.id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(payment.json().payment.status).toBe('CONFIRMED');
    expect(payment.json().payment.txHash).toBe(transactionHash);
    const ledger = await app.inject({ method: 'GET', url: '/v1/ledger', headers: { authorization: `Bearer ${apiKey}` } });
    expect(ledger.json().entries.filter((entry: { entryType: string }) => entry.entryType === 'PAYMENT_CONFIRMED')).toHaveLength(1);
  });

  it('serves the hosted payment link, same-request QR, public details, and customer verification', async () => {
    const merchant = await app.inject({
      method: 'POST',
      url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Checkout Shop', email: 'checkout@example.com', walletAddress: '0x9999999999999999999999999999999999999999' },
    });
    const apiKey = merchant.json().apiKey as string;
    const linkResponse = await app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'checkout-link-order-001' },
      payload: { description: 'Mobile checkout order', amount: '8.75', currency: 'USDC' },
    });
    expect(linkResponse.statusCode).toBe(201);
    const created = linkResponse.json();
    expect(created.checkoutUrl).toBe(checkoutUrlForPayment(created.payment.id));

    const page = await app.inject({ method: 'GET', url: `/p/${created.payment.id}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Pay USDC from wallet');
    expect(page.body).toContain('eth_sendTransaction');

    const qr = await app.inject({ method: 'GET', url: created.qrUrl.replace('http://localhost:8080', '') });
    expect(qr.statusCode).toBe(200);
    expect(qr.headers['content-type']).toContain('image/png');
    expect(qr.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const publicDetails = await app.inject({ method: 'GET', url: `/v1/public/payments/${created.payment.id}` });
    expect(publicDetails.statusCode).toBe(200);
    expect(publicDetails.json().payment).toMatchObject({
      merchant: 'Checkout Shop',
      orderId: created.order.id.slice(0, 8),
      description: 'Mobile checkout order',
      currency: 'USDC',
      network: 'base',
      recipientAddress: '0x9999999999999999999999999999999999999999',
    });
    expect(Number(publicDetails.json().payment.amount)).toBe(8.75);
    expect(publicDetails.body).not.toContain('checkout@example.com');

    const transactionHash = `0x${'1'.repeat(64)}`;
    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 987654n };
    const customerVerify = await app.inject({
      method: 'POST',
      url: `/v1/public/payments/${created.payment.id}/verify`,
      payload: { transactionHash },
    });
    expect(customerVerify.statusCode).toBe(200);
    expect(customerVerify.json().payment.status).toBe('CONFIRMED');
    const updatedDetails = await app.inject({ method: 'GET', url: `/v1/public/payments/${created.payment.id}` });
    expect(updatedDetails.json().payment.status).toBe('CONFIRMED');
  });

  it('manages webhook endpoints without ever returning the signing secret', async () => {
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Hooks Store', email: 'hooks@example.com', walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    const apiKey = merchant.json().apiKey as string;
    const secret = 'merchant-owned-webhook-secret-keep-this-private-001';
    const created = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Orders API', url: 'http://127.0.0.1:4555/events', events: ['payment.created', 'order.paid'], secret },
    });
    expect(created.statusCode).toBe(201);
    const endpointId = created.json().endpoint.id as string;
    expect(created.body).not.toContain(secret);
    expect(created.body).not.toContain('secret_ciphertext');

    const stored = await db.query<{ secret_ciphertext: string }>(
      'SELECT secret_ciphertext FROM webhook_endpoints WHERE id = $1', [endpointId],
    );
    expect(stored.rows[0].secret_ciphertext).not.toContain(secret);

    const rotated = 'rotated-merchant-webhook-secret-private-002';
    const updated = await app.inject({
      method: 'PATCH', url: `/v1/webhooks/${endpointId}`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Updated endpoint', secret: rotated, enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain(secret);
    expect(updated.body).not.toContain(rotated);
    expect(updated.json().endpoint.enabled).toBe(false);

    const listed = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: { authorization: `Bearer ${apiKey}` } });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(secret);
    expect(listed.body).not.toContain(rotated);

    const deleted = await app.inject({ method: 'DELETE', url: `/v1/webhooks/${endpointId}`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(deleted.statusCode).toBe(204);
    const afterDelete = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: { authorization: `Bearer ${apiKey}` } });
    expect(afterDelete.json().endpoints).toHaveLength(0);
  });

  it('delivers signed webhooks, retries failures, stores attempt logs, and records payment/order events', async () => {
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Delivery Store', email: 'delivery@example.com', walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc' },
    });
    const apiKey = merchant.json().apiKey as string;
    const secret = 'delivery-test-webhook-secret-do-not-return-003';
    const endpoint = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        name: 'Test receiver', url: 'http://127.0.0.1:4556/events?token=delivery-url-secret',
        events: ['payment.created', 'payment.confirmed', 'order.paid'], secret,
      },
    });
    const endpointId = endpoint.json().endpoint.id as string;
    const created = await app.inject({
      method: 'POST', url: '/v1/payment-links',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'webhook-order-0001' },
      payload: { description: 'Webhook order', amount: '9.00' },
    });
    const paymentId = created.json().payment.id as string;
    const receivedEvents: string[] = [];
    let failFirst = true;
    const worker = new WebhookDeliveryWorker(db, async (_url, init) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? '');
      const event = JSON.parse(body) as { id: string; type: string };
      receivedEvents.push(event.type);
      const timestamp = Number(headers.get('x-tariffia-timestamp'));
      expect(headers.get('x-tariffia-event-id')).toBe(event.id);
      expect(verifyWebhookSignature({
        secret, rawBody: body, signatureHeader: headers.get('x-tariffia-signature') ?? '',
        timestampHeader: headers.get('x-tariffia-timestamp') ?? undefined, nowSeconds: timestamp,
      }).valid).toBe(true);
      if (failFirst) {
        failFirst = false;
        return new Response('temporary error', { status: 503 });
      }
      return new Response(null, { status: 204 });
    });

    await worker.runOnce();
    const firstList = await app.inject({
      method: 'GET', url: `/v1/webhooks/${endpointId}/deliveries`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(firstList.json().deliveries).toHaveLength(1);
    const firstDelivery = firstList.json().deliveries[0];
    expect(firstDelivery.status).toBe('RETRYING');
    expect(firstDelivery.attempts).toBe(1);
    const adminRetryLog = await app.inject({
      method: 'GET', url: '/v1/admin/webhook-deliveries?status=RETRYING',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
    });
    expect(adminRetryLog.statusCode).toBe(200);
    expect(adminRetryLog.json().deliveries[0].lastHttpStatus).toBe(503);
    expect(adminRetryLog.json().deliveries[0].lastError).toContain('HTTP 503');
    expect(adminRetryLog.json().deliveries[0].url).toBe('http://127.0.0.1:4556');
    expect(adminRetryLog.body).not.toContain('delivery-url-secret');
    await db.query('UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = $1', [firstDelivery.id]);

    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 765432n };
    const confirmed = await app.inject({
      method: 'POST', url: `/v1/payments/${paymentId}/verify`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { transactionHash: `0x${'4'.repeat(64)}` },
    });
    expect(confirmed.statusCode).toBe(200);
    await worker.runOnce();

    const deliveries = await app.inject({
      method: 'GET', url: `/v1/webhooks/${endpointId}/deliveries`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(deliveries.statusCode).toBe(200);
    expect(deliveries.json().deliveries).toHaveLength(3);
    expect(deliveries.json().deliveries.every((delivery: { status: string }) => delivery.status === 'SUCCEEDED')).toBe(true);
    expect(receivedEvents).toContain('payment.created');
    expect(receivedEvents).toContain('payment.confirmed');
    expect(receivedEvents).toContain('order.paid');

    const attempts = await app.inject({
      method: 'GET', url: `/v1/webhooks/${endpointId}/deliveries/${firstDelivery.id}/attempts`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(attempts.json().attempts).toHaveLength(2);
    expect(attempts.json().attempts.map((attempt: { httpStatus: number }) => attempt.httpStatus)).toEqual([503, 204]);

    const adminLog = await app.inject({
      method: 'GET', url: '/v1/admin/webhook-deliveries?status=SUCCEEDED',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
    });
    expect(adminLog.statusCode).toBe(200);
    expect(adminLog.json().deliveries).toHaveLength(3);
    expect(adminLog.body).not.toContain(secret);
    expect(adminLog.body).not.toContain('delivery-url-secret');
  });

  it('emits detected, failed, and expired payment webhooks from ledger-backed transitions', async () => {
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Lifecycle Store', email: 'lifecycle@example.com', walletAddress: '0xdddddddddddddddddddddddddddddddddddddddd' },
    });
    const apiKey = merchant.json().apiKey as string;
    const webhook = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        name: 'Lifecycle events', url: 'http://127.0.0.1:4557/events',
        events: ['payment.created', 'payment.detected', 'payment.confirmed', 'payment.failed', 'payment.expired', 'order.paid'],
        secret: 'lifecycle-webhook-secret-that-is-long-enough-004',
      },
    });
    expect(webhook.statusCode).toBe(201);

    const createPayment = async (key: string) => {
      const response = await app.inject({
        method: 'POST', url: '/v1/payment-links',
        headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': key },
        payload: { description: key, amount: '2.00' },
      });
      return response.json();
    };
    const detected = await createPayment('lifecycle-detected-001');
    const failed = await createPayment('lifecycle-failed-001');
    const expired = await createPayment('lifecycle-expired-001');

    verificationResult = { state: 'pending', detected: true, confirmations: 2, blockNumber: 700n };
    const detectedResult = await app.inject({
      method: 'POST', url: `/v1/payments/${detected.payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash: `0x${'5'.repeat(64)}` },
    });
    expect(detectedResult.json().payment.status).toBe('DETECTED');

    verificationResult = { state: 'failed', reason: 'USDC transfer transaction reverted', blockNumber: 701n };
    const failedResult = await app.inject({
      method: 'POST', url: `/v1/payments/${failed.payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash: `0x${'6'.repeat(64)}` },
    });
    expect(failedResult.statusCode).toBe(200);
    expect(failedResult.json().payment.status).toBe('FAILED');

    await db.query('UPDATE payments SET expires_at = $2 WHERE id = $1', [expired.payment.id, new Date(Date.now() - 60_000)]);
    const dueBeforeWorker = await db.query(
      `SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.id = $1 AND p.status = 'PENDING' AND p.tx_hash IS NULL
          AND p.expires_at <= now() AND o.status = 'PENDING'`,
      [expired.payment.id],
    );
    expect(dueBeforeWorker.rows).toHaveLength(1);
    const worker = new WebhookDeliveryWorker(db, async () => new Response(null, { status: 204 }));
    const workerResult = await worker.runOnce();
    expect(workerResult.duePayments).toBe(1);
    expect(workerResult.expiredPayments).toBe(1);
    const expiryState = await db.query(
      `SELECT p.status AS "paymentStatus", o.status AS "orderStatus", p.tx_hash AS "txHash", p.expires_at AS "expiresAt"
         FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1`,
      [expired.payment.id],
    );
    expect(expiryState.rows[0]).toMatchObject({ paymentStatus: 'EXPIRED', orderStatus: 'EXPIRED' });

    const expiredPayment = await app.inject({
      method: 'GET', url: `/v1/payments/${expired.payment.id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(expiredPayment.json().payment.status).toBe('EXPIRED');

    const events = await db.query<{ event_type: string; id: string }>(
      `SELECT event_type, id FROM webhook_events WHERE merchant_id = $1`, [merchant.json().merchant.id],
    );
    const eventTypes = events.rows.map((row) => row.event_type);
    expect(eventTypes).toContain('payment.created');
    expect(eventTypes).toContain('payment.detected');
    expect(eventTypes).toContain('payment.failed');
    expect(eventTypes).toContain('payment.expired');
    expect(new Set(events.rows.map((row) => row.id)).size).toBe(events.rows.length);

    const ledger = await app.inject({ method: 'GET', url: '/v1/ledger', headers: { authorization: `Bearer ${apiKey}` } });
    const entryTypes = ledger.json().entries.map((entry: { entryType: string }) => entry.entryType);
    expect(entryTypes).toContain('PAYMENT_DETECTED');
    expect(entryTypes).toContain('PAYMENT_FAILED');
    expect(entryTypes).toContain('PAYMENT_EXPIRED');
  });

  it('converts a confirmed USDC top-up into separate credit and main-ledger records', async () => {
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Credit Store', email: 'credit@example.com', walletAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    });
    const apiKey = merchant.json().apiKey as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'credit-customer-1', email: 'credit-customer@example.com' },
    });
    const customerId = customer.json().customer.id as string;
    const balanceBefore = await app.inject({
      method: 'GET', url: `/v1/credits/${customerId}/balance`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(balanceBefore.json().balance).toBe('0');

    const topup = await app.inject({
      method: 'POST', url: '/v1/credits/topups',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'credit-topup-order-001' },
      payload: { customerId, amount: '1.50' },
    });
    expect(topup.statusCode).toBe(201);
    expect(topup.json().creditTopup).toMatchObject({ amountUsdc: '1.50', creditAmount: '150', status: 'PENDING' });
    const replay = await app.inject({
      method: 'POST', url: '/v1/credits/topups',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'credit-topup-order-001' },
      payload: { customerId, amount: '1.50' },
    });
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().payment.id).toBe(topup.json().payment.id);

    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 1234567n };
    const paymentConfirmation = await app.inject({
      method: 'POST', url: `/v1/payments/${topup.json().payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { transactionHash: `0x${'7'.repeat(64)}` },
    });
    expect(paymentConfirmation.statusCode).toBe(200);

    const balanceAfter = await app.inject({
      method: 'GET', url: `/v1/credits/${customerId}/balance`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(Number(balanceAfter.json().balance)).toBe(150);
    const topups = await app.inject({
      method: 'GET', url: `/v1/credits/${customerId}/topups`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(topups.json().topups).toHaveLength(1);
    expect(topups.json().topups[0].status).toBe('CREDITED');

    const ledger = await app.inject({ method: 'GET', url: '/v1/ledger', headers: { authorization: `Bearer ${apiKey}` } });
    expect(ledger.json().entries.find((entry: { entryType: string }) => entry.entryType === 'PAYMENT_CONFIRMED')?.currency).toBe('USDC');
    const creditLedger = ledger.json().entries.find((entry: { entryType: string }) => entry.entryType === 'CREDIT_TOPUP');
    expect(creditLedger.currency).toBe('CREDITS');
    expect(Number(creditLedger.amount)).toBe(150);

    const adminAccounts = await app.inject({
      method: 'GET', url: '/v1/admin/credits/accounts',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
    });
    expect(adminAccounts.statusCode).toBe(200);
    expect(Number(adminAccounts.json().accounts[0].balance)).toBe(150);
    const adminTransactions = await app.inject({
      method: 'GET', url: '/v1/admin/credits/transactions?type=TOPUP',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
    });
    expect(adminTransactions.json().transactions).toHaveLength(1);
    expect(adminTransactions.json().transactions[0].currency).toBe('CREDITS');
    const webhookEvents = await db.query<{ event_type: string }>(
      'SELECT event_type FROM webhook_events WHERE merchant_id = $1', [merchant.json().merchant.id],
    );
    expect(webhookEvents.rows.map((event) => event.event_type)).toContain('credit.topup');
  });

  it('deducts credits atomically under concurrent requests and never allows a negative balance', async () => {
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Atomic Credit Store', email: 'atomic-credit@example.com', walletAddress: '0xffffffffffffffffffffffffffffffffffffffff' },
    });
    const apiKey = merchant.json().apiKey as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'atomic-credit-customer' },
    });
    const customerId = customer.json().customer.id as string;
    const topup = await app.inject({
      method: 'POST', url: '/v1/credits/topups',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'atomic-credit-topup-01' },
      payload: { customerId, amount: '1.00' },
    });
    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 1234568n };
    await app.inject({
      method: 'POST', url: `/v1/payments/${topup.json().payment.id}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash: `0x${'8'.repeat(64)}` },
    });

    const deduct = (key: string) => app.inject({
      method: 'POST', url: '/v1/credits/deductions',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': key },
      payload: { customerId, amount: '70.00', reference: key, metadata: { purpose: 'concurrent-test' } },
    });
    const results = await Promise.all([
      deduct('credit-deduction-001').then((response) => ({ key: 'credit-deduction-001', response })),
      deduct('credit-deduction-002').then((response) => ({ key: 'credit-deduction-002', response })),
    ]);
    expect(results.map(({ response }) => response.statusCode).sort()).toEqual([201, 409]);
    const winner = results.find(({ response }) => response.statusCode === 201)!;
    const replay = await deduct(winner.key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');

    const balance = await app.inject({
      method: 'GET', url: `/v1/credits/${customerId}/balance`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(Number(balance.json().balance)).toBe(30);
    const usage = await app.inject({
      method: 'GET', url: `/v1/credits/${customerId}/usage`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(usage.json().usage).toHaveLength(1);
    expect(Number(usage.json().usage[0].amount)).toBe(70);
    const ledger = await app.inject({ method: 'GET', url: '/v1/ledger', headers: { authorization: `Bearer ${apiKey}` } });
    const deductionLedger = ledger.json().entries.find((entry: { entryType: string }) => entry.entryType === 'CREDIT_DEDUCTION');
    expect(deductionLedger.currency).toBe('CREDITS');
    expect(Number(deductionLedger.amount)).toBe(70);
    const webhookEvents = await db.query<{ event_type: string }>(
      'SELECT event_type FROM webhook_events WHERE merchant_id = $1', [merchant.json().merchant.id],
    );
    expect(webhookEvents.rows.map((event) => event.event_type)).toContain('credit.deducted');
  });

  it('exposes and updates credit conversion and top-up settings through the admin API', async () => {
    const initial = await app.inject({
      method: 'GET', url: '/v1/admin/credits/settings',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
    });
    expect(initial.json().settings.creditsPerUsdcRate).toBe(100);
    expect(Number(initial.json().settings.minimumTopupUsdc)).toBe(1);
    expect(Number(initial.json().settings.maximumTopupUsdc)).toBe(1000);
    const updated = await app.inject({
      method: 'PUT', url: '/v1/admin/credits/settings',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { creditsPerUsdcRate: 250, minimumTopupUsdc: '2.00', maximumTopupUsdc: '500.00' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings.creditsPerUsdcRate).toBe(250);
    expect(Number(updated.json().settings.minimumTopupUsdc)).toBe(2);
    expect(Number(updated.json().settings.maximumTopupUsdc)).toBe(500);
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Configured Credit Store', email: 'configured-credit@example.com', walletAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    });
    const apiKey = merchant.json().apiKey as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'configured-credit-customer' },
    });
    const belowMin = await app.inject({
      method: 'POST', url: '/v1/credits/topups',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'configured-credit-topup-01' },
      payload: { customerId: customer.json().customer.id, amount: '1.00' },
    });
    expect(belowMin.statusCode).toBe(400);
    const aboveMax = await app.inject({
      method: 'POST', url: '/v1/credits/topups',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'configured-credit-topup-over-max' },
      payload: { customerId: customer.json().customer.id, amount: '500.01' },
    });
    expect(aboveMax.statusCode).toBe(400);
    const configuredTopup = await app.inject({
      method: 'POST', url: '/v1/credits/topups',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'configured-credit-topup-02' },
      payload: { customerId: customer.json().customer.id, amount: '2.00' },
    });
    expect(configuredTopup.statusCode).toBe(201);
    expect(configuredTopup.json().creditTopup.creditAmount).toBe('500');
    const invalid = await app.inject({
      method: 'PUT', url: '/v1/admin/credits/settings',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { creditsPerUsdcRate: 250, minimumTopupUsdc: '10.00', maximumTopupUsdc: '2.00' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('configures AI model pricing and records idempotent usage against the existing credit balance', async () => {
    const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
    const providerWithSecret = await app.inject({
      method: 'POST', url: '/v1/admin/ai/providers', headers: adminHeaders,
      payload: { slug: 'secret-provider', name: 'Secret Provider', apiKey: 'must-not-be-accepted' },
    });
    expect(providerWithSecret.statusCode).toBe(400);
    const providerResponse = await app.inject({
      method: 'POST', url: '/v1/admin/ai/providers', headers: adminHeaders,
      payload: { slug: 'example-ai', name: 'Example AI' },
    });
    expect(providerResponse.statusCode).toBe(201);
    const providerId = providerResponse.json().provider.id as string;
    const modelResponse = await app.inject({
      method: 'POST', url: `/v1/admin/ai/providers/${providerId}/models`, headers: adminHeaders,
      payload: {
        slug: 'text-small', name: 'Text Small', enabled: true, pricingMode: 'PER_1K_TOKENS',
        providerInputCostPer1kUsd: '0.01000000', providerOutputCostPer1kUsd: '0.02000000', markupBps: 1000,
      },
    });
    expect(modelResponse.statusCode).toBe(201);
    expect(modelResponse.json().model.customerInputPricePer1kUsd).toBeNull();
    const missingProvider = await app.inject({
      method: 'POST', url: '/v1/admin/ai/providers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/models', headers: adminHeaders,
      payload: { slug: 'orphan-model', name: 'Orphan Model', pricingMode: 'PER_REQUEST' },
    });
    expect(missingProvider.statusCode).toBe(404);

    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name: 'AI Store', email: 'ai@example.com', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    const apiKey = merchant.json().apiKey as string;
    const merchantId = merchant.json().merchant.id as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'ai-customer-1' },
    });
    const customerId = customer.json().customer.id as string;
    await db.query(
      `INSERT INTO credit_accounts (id, merchant_id, customer_id, balance_units)
       VALUES ($1, $2, $3, $4)`,
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', merchantId, customerId, '100000000'],
    );

    const models = await app.inject({ method: 'GET', url: '/v1/ai/models', headers: { authorization: `Bearer ${apiKey}` } });
    expect(models.statusCode).toBe(200);
    expect(models.json().models[0]).toMatchObject({
      provider: 'example-ai', model: 'text-small', pricePerRequestUsd: '0.00000000',
      inputPricePer1kUsd: '0.01100000', outputPricePer1kUsd: '0.02200000',
    });

    const payload = {
      requestId: 'usage-request-0001', customerId, provider: 'example-ai', model: 'text-small',
      inputTokens: 1000, outputTokens: 500, metadata: { trace: 'trace-1' },
    };
    const usage = await app.inject({
      method: 'POST', url: '/v1/ai/usage', headers: { authorization: `Bearer ${apiKey}` }, payload,
    });
    expect(usage.statusCode).toBe(201);
    expect(usage.json().usage).toMatchObject({
      customerPriceUsd: '0.02200000', creditsDeducted: '2.2', balanceAfter: '97.8',
    });
    expect(usage.json().usage).not.toHaveProperty('providerCostUsd');
    expect(usage.json().usage).not.toHaveProperty('profitUsd');
    const replay = await app.inject({
      method: 'POST', url: '/v1/ai/usage', headers: { authorization: `Bearer ${apiKey}` }, payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().usage.id).toBe(usage.json().usage.id);

    const conflict = await app.inject({
      method: 'POST', url: '/v1/ai/usage', headers: { authorization: `Bearer ${apiKey}` },
      payload: { ...payload, inputTokens: 2000 },
    });
    expect(conflict.statusCode).toBe(409);
    const emptyCustomer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'ai-customer-without-credits' },
    });
    const insufficient = await app.inject({
      method: 'POST', url: '/v1/ai/usage', headers: { authorization: `Bearer ${apiKey}` },
      payload: { ...payload, requestId: 'usage-request-no-credit', customerId: emptyCustomer.json().customer.id },
    });
    expect(insufficient.statusCode).toBe(409);

    const history = await app.inject({ method: 'GET', url: '/v1/ai/usage', headers: { authorization: `Bearer ${apiKey}` } });
    expect(history.json().usage).toHaveLength(1);
    expect(history.json().usage[0]).not.toHaveProperty('providerCostUsd');
    expect(history.json().usage[0]).not.toHaveProperty('profitUsd');
    const adminUsage = await app.inject({ method: 'GET', url: '/v1/admin/ai/usage', headers: adminHeaders });
    expect(adminUsage.statusCode).toBe(200);
    expect(adminUsage.json().usage).toHaveLength(1);
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM webhook_events WHERE merchant_id = $1', [merchantId],
    );
    expect(events.rows.map((event) => event.event_type)).toContain('ai.usage.recorded');
    const aiEvent = await db.query<{ payload: { data: Record<string, unknown> } }>(
      `SELECT payload FROM webhook_events WHERE merchant_id = $1 AND event_type = 'ai.usage.recorded'`, [merchantId],
    );
    expect(aiEvent.rows[0].payload.data).not.toHaveProperty('providerCostUsd');
    expect(aiEvent.rows[0].payload.data).not.toHaveProperty('profitUsd');

    const disabledModel = await app.inject({
      method: 'PUT', url: `/v1/admin/ai/models/${modelResponse.json().model.id}`, headers: adminHeaders,
      payload: {
        slug: 'text-small', name: 'Text Small', enabled: false, pricingMode: 'PER_1K_TOKENS',
        providerInputCostPer1kUsd: '0.01000000', customerInputPricePer1kUsd: null,
        providerOutputCostPer1kUsd: '0.02000000', customerOutputPricePer1kUsd: null, markupBps: 1000,
      },
    });
    expect(disabledModel.statusCode).toBe(200);
    const rejected = await app.inject({
      method: 'POST', url: '/v1/ai/usage', headers: { authorization: `Bearer ${apiKey}` },
      payload: { ...payload, requestId: 'usage-request-0002' },
    });
    expect(rejected.statusCode).toBe(404);
    const balance = await db.query<{ balance_units: string }>(
      'SELECT balance_units::text AS balance_units FROM credit_accounts WHERE customer_id = $1', [customerId],
    );
    expect(balance.rows[0].balance_units).toBe('97800000');
  });

  it('keeps USDC, Lightning, and subscription billing unchanged by the AI provider layer', async () => {
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Regression Store', email: 'regression@example.com', walletAddress: '0x4444444444444444444444444444444444444444' },
    });
    const apiKey = merchant.json().apiKey as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'regression-customer' },
    });
    const customerId = customer.json().customer.id as string;

    const order = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'regression-order-001' },
      payload: { customerId, description: 'Regression order', amount: '5.00', currency: 'USDC' },
    });
    expect(order.statusCode).toBe(201);
    expect(Number(order.json().order.amount)).toBe(5);
    expect(order.json().order.currency).toBe('USDC');
    expect(order.json().payment).toMatchObject({ adapter: 'usdc', currency: 'USDC' });
    expect(adapters.getManifest('usdc')?.capabilities.recurringPayments).toBe(false);

    const provider = await app.inject({
      method: 'POST', url: '/v1/admin/ai/providers', headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { slug: 'regression-ai', name: 'Regression AI' },
    });
    const aiProviderId = provider.json().provider.id as string;
    const aiModel = await app.inject({
      method: 'POST', url: `/v1/admin/ai/providers/${aiProviderId}/models`,
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: {
        slug: 'regression-model', name: 'Regression Model', enabled: true, pricingMode: 'PER_1K_TOKENS',
        providerInputCostPer1kUsd: '0.01000000', providerOutputCostPer1kUsd: '0.02000000', markupBps: 1000,
      },
    });
    expect(aiModel.statusCode).toBe(201);
    expect(aiModel.json().model).toMatchObject({ providerModel: null, maxOutputTokens: 512 });

    const aiProviderSlug = provider.json().provider.slug as string;
    const plan = await app.inject({
      method: 'POST', url: '/v1/subscription-plans', headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Regression Plan', amount: '7.00', interval: 'MONTH' },
    });
    const subscription = await app.inject({
      method: 'POST', url: '/v1/subscriptions',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'regression-subscription-001' },
      payload: { planId: plan.json().plan.id, customerId },
    });
    expect(subscription.statusCode).toBe(201);
    expect(subscription.json().subscription).toMatchObject({
      status: 'PAST_DUE', automaticRenewalAvailable: false,
    });
    expect(Number(subscription.json().subscription.amount)).toBe(7);
    const cycles = await app.inject({
      method: 'GET', url: `/v1/subscriptions/${subscription.json().subscription.id}/billing-cycles`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(cycles.json().billingCycles[0]).toMatchObject({ cycleNumber: 1, status: 'PENDING' });

    // The AI layer must not add ledger activity of its own: one order plus its subscription
    // payment request, and no AI or credit entries.
    const ledger = await db.query<{ entry_type: string }>(
      'SELECT entry_type FROM ledger_entries ORDER BY created_at ASC',
    );
    expect(ledger.rows.map((row) => row.entry_type)).toEqual(['PAYMENT_CREATED', 'PAYMENT_CREATED']);
    const aiLedger = await db.query(
      `SELECT id FROM ledger_entries WHERE entry_type IN ('CREDIT_DEDUCTION', 'CREDIT_TOPUP')`,
    );
    expect(aiLedger.rows).toHaveLength(0);
  });

  it('serves the dashboards with separate admin and merchant data boundaries', async () => {
    const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
    const adminPage = await app.inject({ method: 'GET', url: '/admin' });
    expect(adminPage.statusCode).toBe(200);
    expect(adminPage.headers['content-type']).toContain('text/html');
    expect(adminPage.body).toContain('data-dashboard="admin"');
    const merchantPage = await app.inject({ method: 'GET', url: '/merchant' });
    expect(merchantPage.statusCode).toBe(200);
    expect(merchantPage.body).toContain('data-dashboard="merchant"');
    const dashboardScript = await app.inject({ method: 'GET', url: '/assets/dashboard.js' });
    expect(dashboardScript.statusCode).toBe(200);
    expect(dashboardScript.headers['content-type']).toContain('javascript');

    const firstMerchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name: 'Dashboard One', email: 'dashboard-one@example.com', walletAddress: '0x1111111111111111111111111111111111111111' },
    });
    const secondMerchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name: 'Dashboard Two', email: 'dashboard-two@example.com', walletAddress: '0x2222222222222222222222222222222222222222' },
    });
    const firstKey = firstMerchant.json().apiKey as string;
    const secondKey = secondMerchant.json().apiKey as string;
    const firstMerchantId = firstMerchant.json().merchant.id as string;
    await app.inject({ method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${firstKey}` }, payload: { externalId: 'one-customer' } });
    await app.inject({ method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${secondKey}` }, payload: { externalId: 'two-customer' } });
    await db.query(
      `INSERT INTO webhook_endpoints (id, merchant_id, name, url, events, secret_ciphertext, secret_nonce, secret_auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', firstMerchantId, 'Private URL hook',
        'https://hooks.example.test/private/path?token=url-secret', ['payment.confirmed'], 'ciphertext-marker', 'nonce-marker', 'tag-marker'],
    );

    const noAdmin = await app.inject({ method: 'GET', url: '/v1/admin/dashboard/merchants' });
    expect(noAdmin.statusCode).toBe(401);
    const noMerchant = await app.inject({ method: 'GET', url: '/v1/dashboard/customers' });
    expect(noMerchant.statusCode).toBe(401);
    const firstCustomers = await app.inject({ method: 'GET', url: '/v1/dashboard/customers', headers: { authorization: `Bearer ${firstKey}` } });
    expect(firstCustomers.statusCode).toBe(200);
    expect(firstCustomers.json().items).toHaveLength(1);
    expect(firstCustomers.json().items[0].externalId).toBe('one-customer');
    const ownEndpoints = await app.inject({ method: 'GET', url: '/v1/dashboard/webhook-endpoints', headers: { authorization: `Bearer ${firstKey}` } });
    expect(ownEndpoints.statusCode).toBe(200);
    expect(ownEndpoints.body).not.toContain('url-secret');
    expect(ownEndpoints.body).not.toContain('ciphertext-marker');
    expect(ownEndpoints.json().items[0].url).toBe('https://hooks.example.test');
    const adminMerchants = await app.inject({ method: 'GET', url: '/v1/admin/dashboard/merchants', headers: adminHeaders });
    expect(adminMerchants.statusCode).toBe(200);
    expect(adminMerchants.json().items).toHaveLength(2);
    const allEndpoints = await app.inject({ method: 'GET', url: '/v1/admin/dashboard/webhook-endpoints', headers: adminHeaders });
    expect(allEndpoints.statusCode).toBe(200);
    expect(allEndpoints.body).not.toContain('private/path');
    expect(allEndpoints.body).not.toContain('url-secret');
    expect(allEndpoints.body).not.toContain('ciphertext-marker');
    const adminOverview = await app.inject({ method: 'GET', url: '/v1/admin/dashboard/overview', headers: adminHeaders });
    expect(adminOverview.statusCode).toBe(200);
    const merchantOverview = await app.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { authorization: `Bearer ${firstKey}` } });
    expect(merchantOverview.statusCode).toBe(200);
    for (const collection of [
      'customers', 'orders', 'payments', 'usdc-transactions', 'failed-payments', 'credit-accounts',
      'credit-transactions', 'ai-providers', 'ai-models', 'usage', 'webhook-endpoints', 'webhook-deliveries',
    ]) {
      const response = await app.inject({ method: 'GET', url: `/v1/admin/dashboard/${collection}`, headers: adminHeaders });
      expect(response.statusCode, `admin ${collection}: ${response.body}`).toBe(200);
    }
    for (const collection of [
      'customers', 'orders', 'payments', 'payment-links', 'credit-accounts', 'credit-transactions',
      'topups', 'usage', 'webhook-endpoints', 'webhook-deliveries',
    ]) {
      const response = await app.inject({ method: 'GET', url: `/v1/dashboard/${collection}`, headers: { authorization: `Bearer ${firstKey}` } });
      expect(response.statusCode, `merchant ${collection}: ${response.body}`).toBe(200);
    }
  });

  it('reports readiness from database availability without exposing database errors', async () => {
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', service: 'tariffia-pay-api' });

    const originalQuery = db.query;
    db.query = (async () => { throw new Error('private database connection detail'); }) as Database['query'];
    try {
      const unavailable = await app.inject({ method: 'GET', url: '/ready' });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({ status: 'not_ready', service: 'tariffia-pay-api' });
      expect(unavailable.body).not.toContain('private database connection detail');
    } finally {
      db.query = originalQuery;
    }
  });

  it('adds security headers and applies the configured global API rate limit', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('DENY');
    expect(health.headers['referrer-policy']).toBe('no-referrer');
    expect(health.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const crossOriginHealth = await app.inject({
      method: 'GET', url: '/health', headers: { origin: 'https://untrusted.example' },
    });
    expect(crossOriginHealth.headers['access-control-allow-origin']).toBeUndefined();
    const malformedJson = await app.inject({
      method: 'POST', url: '/v1/orders', headers: { 'content-type': 'application/json' }, payload: '{',
    });
    expect(malformedJson.statusCode).toBe(400);
    expect(malformedJson.json().error).toBe('bad_request');
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants',
      headers: { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' },
      payload: { name: 'Rate Limit Test', email: 'rate-limit-test@example.com', walletAddress: '0x1234567890123456789012345678901234567890' },
    });
    const unsupportedMedia = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${merchant.json().apiKey}`, 'content-type': 'application/x-unknown' },
      payload: 'unsupported body',
    });
    expect(unsupportedMedia.statusCode).toBe(415);
    expect(unsupportedMedia.json().error).toBe('bad_request');
    const oversized = await app.inject({
      method: 'POST', url: '/v1/orders', headers: { 'content-type': 'application/json' },
      payload: ' '.repeat(256 * 1024 + 1),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error).toBe('payload_too_large');

    let rateLimited = false;
    for (let request = 0; request < 305; request++) {
      const response = await app.inject({
        method: 'GET', url: '/health',
        headers: { 'x-forwarded-for': '198.51.100.1' },
      });
      expect(response.statusCode).toBeLessThan(500);
      if (response.statusCode === 429) {
        rateLimited = true;
        break;
      }
    }
    expect(rateLimited).toBe(true);
  }, 15_000);

  function verificationServiceForTest(): PaymentVerificationService {
    return new PaymentVerificationService(db, adapters);
  }
});
