import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnits } from 'viem';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import type { AdapterPaymentDetails, PaymentAdapter } from '../src/payment-adapter.js';
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

type FixtureVerification =
  | { state: 'not_found' }
  | { state: 'verified'; confirmations: number; blockNumber: bigint };

function stubAdapter(verification: { current: FixtureVerification }): PaymentAdapter {
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
    verifyTransaction: async (input) => {
      if (verification.current.state === 'not_found') return { state: 'not_found' };
      return {
        state: 'verified',
        receipt: {
          transactionId: input.transactionId, network: input.network, state: 'confirmed',
          amount: input.amount, currency: input.currency, recipient: input.recipientAddress,
          confirmations: verification.current.confirmations, blockNumber: verification.current.blockNumber.toString(),
        },
      };
    },
  };
}

describe('merchant transaction visibility', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let apiKey: string;
  const verification: { current: FixtureVerification } = { current: { state: 'not_found' } };

  async function createMerchant(name: string, email: string, wallet: string) {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().apiKey as string;
  }

  async function createPayment(key: string, description: string, idempotencyKey: string) {
    const order = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey },
      payload: { description, amount: '4.25', currency: 'USDC' },
    });
    expect(order.statusCode, order.body).toBe(201);
    return order.json().payment.id as string;
  }

  const list = (key: string, query = '') => app.inject({ method: 'GET', url: `/v1/transactions${query}`, headers: { authorization: `Bearer ${key}` } });
  const detail = (key: string, id: string) => app.inject({ method: 'GET', url: `/v1/transactions/${id}`, headers: { authorization: `Bearer ${key}` } });

  beforeEach(async () => {
    db = await createDatabase();
    verification.current = { state: 'not_found' };
    const registry = new PaymentAdapterRegistry();
    registry.register(stubAdapter(verification), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    app = await buildApp({ db, adapterRegistry: registry });
    apiKey = await createMerchant('Tx Store', 'transactions@example.com', '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a');
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('lists and reads transaction details', async () => {
    const paymentId = await createPayment(apiKey, 'First payment', 'tx-order-0001');
    const listed = await list(apiKey);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().transactions).toHaveLength(1);
    expect(listed.json().transactions[0]).toMatchObject({
      paymentId, description: 'First payment', amount: '4.25', currency: 'USDC',
      status: 'PENDING', network: 'base', adapter: 'usdc', transactionHash: null, confirmedAt: null,
    });
    expect(listed.json().transactions[0].createdAt).toBeTruthy();
    expect(listed.json().transactions[0].orderId).toBeTruthy();

    const one = await detail(apiKey, paymentId);
    expect(one.statusCode).toBe(200);
    expect(one.json().transaction).toMatchObject({ paymentId, status: 'PENDING', amount: '4.25' });
    expect(one.body).not.toContain('privateKey');
    expect(one.body).not.toContain('secret');
  });

  it('confirms a payment and exposes its hash and confirmation time', async () => {
    const paymentId = await createPayment(apiKey, 'Confirmed payment', 'tx-order-0002');
    const transactionHash = `0x${'c'.repeat(64)}`;
    verification.current = { state: 'verified', confirmations: 12, blockNumber: 123456n };
    const verified = await app.inject({
      method: 'POST', url: `/v1/payments/${paymentId}/verify`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: { transactionHash },
    });
    expect(verified.statusCode).toBe(200);

    const one = await detail(apiKey, paymentId);
    expect(one.json().transaction).toMatchObject({
      status: 'CONFIRMED', transactionId: transactionHash.toLowerCase(), transactionHash: transactionHash.toLowerCase(),
    });
    expect(one.json().transaction.confirmedAt).toBeTruthy();
    expect((await list(apiKey, '?status=CONFIRMED')).json().transactions).toHaveLength(1);
  });

  it('supports status and network filters and rejects invalid filters', async () => {
    await createPayment(apiKey, 'Filter A', 'tx-order-0003');
    await createPayment(apiKey, 'Filter B', 'tx-order-0004');

    expect((await list(apiKey, '?status=PENDING')).json().transactions).toHaveLength(2);
    expect((await list(apiKey, '?status=CONFIRMED')).json().transactions).toHaveLength(0);
    expect((await list(apiKey, '?network=base')).json().transactions).toHaveLength(2);
    expect((await list(apiKey, '?network=lightning-mainnet')).json().transactions).toHaveLength(0);
    expect((await list(apiKey, '?status=PENDING&network=base')).json().transactions).toHaveLength(2);
    expect((await list(apiKey, '?limit=1')).json().transactions).toHaveLength(1);
    expect((await list(apiKey, '?status=NOPE')).statusCode).toBe(400);
    expect((await list(apiKey, `?network=${'x'.repeat(65)}`)).statusCode).toBe(400);
  });

  it('keeps transactions isolated between merchants', async () => {
    const other = await createMerchant('Other Tx', 'other-tx@example.com', '0x7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c');
    const paymentId = await createPayment(apiKey, 'Mine', 'tx-order-0005');
    await createPayment(other, 'Theirs', 'tx-order-0006');

    expect((await list(other)).json().transactions).toHaveLength(1);
    expect((await list(other)).json().transactions[0].description).toBe('Theirs');
    expect((await list(other)).body).not.toContain(paymentId);
    expect((await detail(other, paymentId)).statusCode).toBe(404);
    expect((await detail(apiKey, paymentId)).json().transaction.description).toBe('Mine');
  });

  it('rejects unauthenticated requests and missing transactions', async () => {
    const paymentId = await createPayment(apiKey, 'Guarded', 'tx-order-0007');
    expect((await app.inject({ method: 'GET', url: '/v1/transactions' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/v1/transactions/${paymentId}` })).statusCode).toBe(401);
    expect((await detail(apiKey, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).statusCode).toBe(404);
  });
});
