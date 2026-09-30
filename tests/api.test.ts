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
    expect(ledger.json().entries).toHaveLength(2);
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

  function verificationServiceForTest(): PaymentVerificationService {
    return new PaymentVerificationService(db, [paymentAdapter]);
  }
});
