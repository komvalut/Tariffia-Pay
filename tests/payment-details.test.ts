import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnits } from 'viem';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import type { AdapterPaymentDetails, PaymentAdapter, PaymentVerificationInput } from '../src/payment-adapter.js';
import { PaymentAdapterRegistry } from '../src/payment-adapters/registry.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const usdcAddress = '0x833589fCD6eDb6E08f4c7C32d4f71b54bdA02913';

function pgAdapterPool(memory: ReturnType<typeof newDb>): Pool {
  const adapter = memory.adapters.createPg();
  return new adapter.Pool() as Pool;
}

async function createDatabase(): Promise<Database> {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const pool = pgAdapterPool(memory);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  let phaseOne = await readFile(path.join(migrationsDir, '0001_phase1.sql'), 'utf8');
  phaseOne = phaseOne.split('CREATE OR REPLACE FUNCTION reject_ledger_mutation()')[0] ?? phaseOne;
  await pool.query(phaseOne);
  const phaseTwo = await readFile(path.join(migrationsDir, '0002_usdc_base.sql'), 'utf8');
  const backfillStart = phaseTwo.indexOf('UPDATE payments\n   SET adapter_data = jsonb_build_object');
  if (backfillStart >= 0) {
    const backfillEnd = phaseTwo.indexOf(';', backfillStart);
    await pool.query(phaseTwo.slice(0, backfillStart) + phaseTwo.slice(backfillEnd + 1));
  } else {
    await pool.query(phaseTwo);
  }
  let webhookMigration = await readFile(path.join(migrationsDir, '0003_webhooks.sql'), 'utf8');
  webhookMigration = webhookMigration.replace(
    /event_type text NOT NULL CHECK \(event_type IN \([\s\S]*?\)\),/,
    'event_type text NOT NULL,',
  );
  await pool.query(webhookMigration);
  for (const migration of ['0004_credit_engine.sql', '0005_ai_pricing.sql', '0006_invoices_receipts.sql',
    '0007_subscriptions.sql', '0008_ai_provider_integration.sql', '0009_sms_otp.sql',
    '0010_sms_provider_hardening.sql', '0011_merchant_usage_limits.sql', '0012_payment_links.sql']) {
    await pool.query(await readFile(path.join(migrationsDir, migration), 'utf8'));
  }
  return {
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
}

function stubAdapter(options: { verify: boolean }): PaymentAdapter {
  return {
    id: 'usdc',
    manifest: {
      id: 'usdc', name: 'Base USDC', version: 'test', description: 'Test Base USDC adapter',
      capabilities: {
        paymentRequests: true, transactionVerification: true, statusPolling: false, recurringPayments: false,
        automaticDetection: true, refunds: false, paymentRequestFormat: 'wallet',
        currencies: ['USDC'], networks: ['base'],
      },
      idempotency: { paymentCreation: 'stable-key-required', transactionVerification: 'network-and-transaction-id' },
    },
    initialize: async () => {},
    shutdown: async () => {},
    health: async () => ({ status: 'healthy', message: 'Test adapter is ready' }),
    normalizeTransactionId: (transactionId) => transactionId.toLowerCase(),
    createRequest: vi.fn(async (input): Promise<AdapterPaymentDetails> => ({
      adapter: 'usdc', network: 'base', currency: 'USDC',
      recipientAddress: input.recipient.toLowerCase(), tokenAddress: usdcAddress.toLowerCase(),
      amountBaseUnits: parseUnits(input.amount, 6).toString(), adapterData: { chainId: 8453, decimals: 6 },
    })),
    verifyTransaction: async (input: PaymentVerificationInput) => {
      if (!options.verify) return { state: 'not_found' };
      return {
        state: 'verified',
        receipt: {
          transactionId: input.transactionId, network: input.network, state: 'confirmed',
          amount: input.amount, currency: input.currency, recipient: input.recipientAddress,
          confirmations: 12, blockNumber: '123456',
        },
      };
    },
  };
}

describe('merchant payment details', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let apiKey: string;

  async function createMerchant(name: string, email: string, wallet: string) {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().apiKey as string;
  }

  async function createPayment(key: string, description: string, idempotencyKey: string, reference?: string) {
    const order = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey },
      payload: { description, amount: '7.50', currency: 'USDC', ...(reference ? { reference } : {}) },
    });
    expect(order.statusCode, order.body).toBe(201);
    return order.json().payment.id as string;
  }

  const details = (key: string, id: string) => app.inject({
    method: 'GET', url: `/v1/payments/${id}/details`, headers: { authorization: `Bearer ${key}` },
  });
  const confirm = (key: string, id: string, transactionHash: string) => app.inject({
    method: 'POST', url: `/v1/payments/${id}/verify`,
    headers: { authorization: `Bearer ${key}` }, payload: { transactionHash },
  });

  async function buildAppWithVerification(verify: boolean) {
    const registry = new PaymentAdapterRegistry();
    registry.register(stubAdapter({ verify }), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    return buildApp({ db, adapterRegistry: registry });
  }

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('returns payment and order details with no invoice before confirmation', async () => {
    db = await createDatabase();
    app = await buildAppWithVerification(false);
    apiKey = await createMerchant('Details Store', 'details@example.com', '0x6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a');
    const paymentId = await createPayment(apiKey, 'Unconfirmed', 'details-order-0001', 'ref-d1');

    const response = await details(apiKey, paymentId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      payment: { id: paymentId, amount: '7.5', currency: 'USDC', status: 'PENDING', network: 'base', transactionHash: null, confirmedAt: null, paymentMethod: { id: 'usdc', name: 'Base USDC' } },
      order: { reference: 'ref-d1', description: 'Unconfirmed', amount: '7.5', currency: 'USDC', status: 'PENDING' },
      invoice: null,
      receipt: null,
    });
    expect(response.json().order.id).toBeTruthy();
    expect(response.json().order.updatedAt).toBeTruthy();
    expect(response.body).not.toContain('privateKey');
  });

  it('connects a confirmed payment to its existing invoice and receipt', async () => {
    db = await createDatabase();
    app = await buildAppWithVerification(true);
    apiKey = await createMerchant('Confirmed Store', 'confirmed@example.com', '0x6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b');
    const paymentId = await createPayment(apiKey, 'Confirmed', 'details-order-0002');
    const transactionHash = `0x${'d'.repeat(64)}`;
    expect((await confirm(apiKey, paymentId, transactionHash)).statusCode).toBe(200);

    const response = await details(apiKey, paymentId);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.payment).toMatchObject({ status: 'CONFIRMED', transactionId: transactionHash.toLowerCase(), transactionHash: transactionHash.toLowerCase() });
    expect(body.payment.confirmedAt).toBeTruthy();
    expect(body.invoice).toMatchObject({ paymentId, orderId: body.order.id, amount: '7.5', currency: 'USDC', paymentStatus: 'CONFIRMED' });
    expect(body.invoice.invoiceNumber).toBeTruthy();
    expect(body.receipt.id).toBeTruthy();
    expect(body.receipt.publicId).toBeTruthy();
    expect(body.receipt.publicUrl).toContain(`/r/${body.receipt.publicId}`);

    // The invoice number matches the existing merchant invoice listing.
    const invoices = await app.inject({ method: 'GET', url: '/v1/invoices', headers: { authorization: `Bearer ${apiKey}` } });
    expect(invoices.json().invoices[0].invoiceNumber).toBe(body.invoice.invoiceNumber);
    // The receipt's public URL resolves through the existing public receipt endpoint.
    const publicReceipt = await app.inject({ method: 'GET', url: `/v1/public/receipts/${body.receipt.publicId}` });
    expect(publicReceipt.statusCode).toBe(200);
    expect(publicReceipt.body).not.toContain('wallet_address');
  });

  it('keeps payment details isolated between merchants', async () => {
    db = await createDatabase();
    app = await buildAppWithVerification(false);
    apiKey = await createMerchant('Owner Store', 'owner@example.com', '0x6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c');
    const other = await createMerchant('Snoop Store', 'snoop@example.com', '0x6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d');
    const paymentId = await createPayment(apiKey, 'Private', 'details-order-0003');

    expect((await details(other, paymentId)).statusCode).toBe(404);
    expect((await details(apiKey, paymentId)).json().payment.id).toBe(paymentId);
  });

  it('rejects unauthenticated requests and missing payments', async () => {
    db = await createDatabase();
    app = await buildAppWithVerification(false);
    apiKey = await createMerchant('Guard Store', 'guard@example.com', '0x6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e');
    const paymentId = await createPayment(apiKey, 'Guarded', 'details-order-0004');
    expect((await app.inject({ method: 'GET', url: `/v1/payments/${paymentId}/details` })).statusCode).toBe(401);
    expect((await details(apiKey, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).statusCode).toBe(404);
  });
});
