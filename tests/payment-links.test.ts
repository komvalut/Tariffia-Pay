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
    '0010_sms_provider_hardening.sql', '0011_merchant_usage_limits.sql', '0012_payment_links.sql',
    '0015_audit_log.sql']) {
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

function stubAdapter(): PaymentAdapter {
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
    verifyTransaction: async () => ({ state: 'not_found' }),
  };
}

describe('merchant payment link management', () => {
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

  const createLink = (key: string, description: string, key4: string) => app.inject({
    method: 'POST', url: '/v1/payment-links',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': key4 },
    payload: { description, amount: '12.50', currency: 'USDC' },
  });
  const list = (key: string) => app.inject({ method: 'GET', url: '/v1/payment-links', headers: { authorization: `Bearer ${key}` } });
  const detail = (key: string, id: string) => app.inject({ method: 'GET', url: `/v1/payment-links/${id}`, headers: { authorization: `Bearer ${key}` } });
  const patch = (key: string, id: string, payload: Record<string, unknown>) => app.inject({
    method: 'PATCH', url: `/v1/payment-links/${id}`, headers: { authorization: `Bearer ${key}` }, payload,
  });
  const remove = (key: string, id: string) => app.inject({ method: 'DELETE', url: `/v1/payment-links/${id}`, headers: { authorization: `Bearer ${key}` } });
  const publicView = (id: string) => app.inject({ method: 'GET', url: `/v1/public/payments/${id}` });

  beforeEach(async () => {
    db = await createDatabase();
    const registry = new PaymentAdapterRegistry();
    registry.register(stubAdapter(), { enabled: true, settings: {}, isDefault: true });
    await registry.initialize();
    app = await buildApp({ db, adapterRegistry: registry });
    apiKey = await createMerchant('Link Store', 'links@example.com', '0x1212121212121212121212121212121212121212');
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('creates a link and lists and reads its details', async () => {
    const created = await createLink(apiKey, 'Invoice 42', 'link-create-0001');
    expect(created.statusCode, created.body).toBe(201);
    const paymentId = created.json().payment.id as string;
    expect(created.json()).toMatchObject({ checkoutUrl: expect.stringContaining(`/p/${paymentId}`), qrUrl: expect.stringContaining(`/p/${paymentId}/qr.png`) });

    const listed = await list(apiKey);
    expect(listed.statusCode).toBe(200);
    const link = listed.json().paymentLinks.find((entry: { id: string }) => entry.id === paymentId);
    expect(link).toMatchObject({ description: 'Invoice 42', amount: '12.5', currency: 'USDC', enabled: true });
    expect(link.checkoutUrl).toContain(`/p/${paymentId}`);

    const one = await detail(apiKey, paymentId);
    expect(one.statusCode).toBe(200);
    expect(one.json().paymentLink).toMatchObject({ id: paymentId, description: 'Invoice 42', enabled: true });
    expect(one.body).not.toContain('privateKey');
  });

  it('disables and re-enables a link and gates its public checkout', async () => {
    const created = await createLink(apiKey, 'Pausable', 'link-create-0002');
    const paymentId = created.json().payment.id as string;
    expect((await publicView(paymentId)).statusCode).toBe(200);

    const disabled = await patch(apiKey, paymentId, { enabled: false });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().paymentLink).toMatchObject({ enabled: false });
    expect(disabled.json().paymentLink.disabledAt).toBeTruthy();
    // The paused link's public checkout and QR stop working.
    expect((await publicView(paymentId)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/p/${paymentId}/qr.png` })).statusCode).toBe(404);
    expect((await list(apiKey)).json().paymentLinks[0].enabled).toBe(false);

    const enabled = await patch(apiKey, paymentId, { enabled: true });
    expect(enabled.json().paymentLink).toMatchObject({ enabled: true, disabledAt: null });
    expect((await publicView(paymentId)).statusCode).toBe(200);
  });

  it('deletes a link, hides it and stops its checkout', async () => {
    const created = await createLink(apiKey, 'Deletable', 'link-create-0003');
    const paymentId = created.json().payment.id as string;

    const deleted = await remove(apiKey, paymentId);
    expect(deleted.statusCode).toBe(204);
    expect((await list(apiKey)).json().paymentLinks).toHaveLength(0);
    expect((await detail(apiKey, paymentId)).statusCode).toBe(404);
    expect((await publicView(paymentId)).statusCode).toBe(404);
    expect((await remove(apiKey, paymentId)).statusCode).toBe(404);
    expect((await patch(apiKey, paymentId, { enabled: true })).statusCode).toBe(404);
  });

  it('keeps payment links isolated between merchants', async () => {
    const other = await createMerchant('Other Links', 'other-links@example.com', '0x3434343434343434343434343434343434343434');
    const created = await createLink(apiKey, 'Mine', 'link-create-0004');
    const paymentId = created.json().payment.id as string;

    expect((await detail(other, paymentId)).statusCode).toBe(404);
    expect((await patch(other, paymentId, { enabled: false })).statusCode).toBe(404);
    expect((await remove(other, paymentId)).statusCode).toBe(404);
    expect((await list(other)).json().paymentLinks).toHaveLength(0);

    // The owner's link is unaffected.
    expect((await detail(apiKey, paymentId)).json().paymentLink).toMatchObject({ enabled: true });
  });

  it('rejects unauthenticated requests and invalid input', async () => {
    const created = await createLink(apiKey, 'Validate', 'link-create-0005');
    const paymentId = created.json().payment.id as string;
    for (const request of [
      { method: 'GET', url: '/v1/payment-links' },
      { method: 'GET', url: `/v1/payment-links/${paymentId}` },
      { method: 'PATCH', url: `/v1/payment-links/${paymentId}`, payload: { enabled: false } },
      { method: 'DELETE', url: `/v1/payment-links/${paymentId}` },
    ]) {
      const anonymous = await app.inject(request as never);
      expect(anonymous.statusCode).toBe(401);
    }
    const unknown = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect((await detail(apiKey, unknown)).statusCode).toBe(404);
    expect((await patch(apiKey, unknown, { enabled: false })).statusCode).toBe(404);
    expect((await remove(apiKey, unknown)).statusCode).toBe(404);
    const invalid = await patch(apiKey, paymentId, { enabled: 'yes' });
    expect(invalid.statusCode).toBe(400);
    const missing = await patch(apiKey, paymentId, {});
    expect(missing.statusCode).toBe(400);
  });

  it('leaves payments with no management row untouched', async () => {
    // A payment created through the orders API is not a managed link and stays fully active.
    const order = await app.inject({
      method: 'POST', url: '/v1/orders',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'plain-order-0001' },
      payload: { description: 'Plain order', amount: '3.00', currency: 'USDC' },
    });
    expect(order.statusCode).toBe(201);
    const paymentId = order.json().payment.id as string;
    expect((await publicView(paymentId)).statusCode).toBe(200);
    // It is still manageable as a link, and disabling it gates its checkout.
    expect((await patch(apiKey, paymentId, { enabled: false })).statusCode).toBe(200);
    expect((await publicView(paymentId)).statusCode).toBe(404);
  });
});
