import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { parseUnits } from 'viem';
import type { AdapterPaymentDetails, PaymentAdapter, PaymentVerificationResult } from '../src/payment-adapter.js';
import { PaymentVerificationService } from '../src/services/payment-verification-service.js';
import { UsdcPaymentDetector } from '../src/services/usdc-payment-detector.js';
import { WebhookDeliveryWorker } from '../src/services/webhook-delivery-worker.js';
import { checkoutUrlForPayment } from '../src/checkout-links.js';
import { verifyWebhookSignature } from '../src/webhooks/signature.js';

const usdcAddress = '0x833589fCD6eDb6E08f4c7C32d4F71b54bdA02913';

describe('Tariffia merchant and payment API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: Database;
  let pool: Pool;
  let verificationResult: PaymentVerificationResult;
  let paymentAdapter: PaymentAdapter;

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
      createRequest: async (input): Promise<AdapterPaymentDetails> => ({
        adapter: 'usdc',
        network: 'base',
        currency: 'USDC',
        recipientAddress: input.recipient.toLowerCase(),
        tokenAddress: usdcAddress.toLowerCase(),
        adapterData: { chainId: 8453, decimals: 6, amountBaseUnits: parseUnits(input.amount, 6).toString() },
      }),
      verifyTransaction: async () => verificationResult,
    };
    const verification = new PaymentVerificationService(db, [paymentAdapter]);
    app = await buildApp({ db, paymentAdapter, verification });
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
    expect(created.checkoutUrl).toBe(checkoutUrlForPayment(created.payment.id));
    expect(created.qrUrl).toContain(`/p/${created.payment.id}/qr.png`);

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
    const created = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'paid-store-order-001' },
      payload: { description: 'Invoice 1', amount: '12.34' },
    });
    const { order, payment } = created.json();
    const transactionHash = `0x${'a'.repeat(64)}`;
    verificationResult = { state: 'verified', confirmations: 12, blockNumber: 123456n };

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
        name: 'Test receiver', url: 'http://127.0.0.1:4556/events',
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

  function verificationServiceForTest(): PaymentVerificationService {
    return new PaymentVerificationService(db, [paymentAdapter]);
  }
});
