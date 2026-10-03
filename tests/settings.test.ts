import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };

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
    '0013_merchant_settings.sql', '0015_audit_log.sql']) {
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

describe('merchant self-service settings', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let apiKey: string;
  let merchantId: string;

  async function createMerchant(name: string, email: string, wallet: string) {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return { apiKey: response.json().apiKey as string, merchantId: response.json().merchant.id as string };
  }

  const get = (key: string) => app.inject({ method: 'GET', url: '/v1/settings', headers: { authorization: `Bearer ${key}` } });
  const put = (key: string, payload: Record<string, unknown>) => app.inject({
    method: 'PUT', url: '/v1/settings', headers: { authorization: `Bearer ${key}` }, payload,
  });

  beforeEach(async () => {
    db = await createDatabase();
    app = await buildApp({ db });
    const merchant = await createMerchant('Settings Store', 'owner@example.com', '0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a');
    apiKey = merchant.apiKey;
    merchantId = merchant.merchantId;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('reads default settings and updates them', async () => {
    const initial = await get(apiKey);
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json().settings).toMatchObject({
      merchantId, displayName: 'Settings Store', supportEmail: 'owner@example.com',
      defaultCurrency: 'USDC', timezone: 'UTC', updatedAt: null,
    });

    const updated = await put(apiKey, {
      displayName: 'Acme Payments', supportEmail: 'help@acme.test', defaultCurrency: 'usdc', timezone: 'Europe/Belgrade',
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().settings).toMatchObject({
      displayName: 'Acme Payments', supportEmail: 'help@acme.test', defaultCurrency: 'USDC', timezone: 'Europe/Belgrade',
    });
    expect(updated.json().settings.updatedAt).toBeTruthy();

    const reread = await get(apiKey);
    expect(reread.json().settings).toMatchObject({
      displayName: 'Acme Payments', supportEmail: 'help@acme.test', defaultCurrency: 'USDC', timezone: 'Europe/Belgrade',
    });
  });

  it('clears overrides back to defaults when fields are null', async () => {
    await put(apiKey, { displayName: 'Custom', supportEmail: 'custom@acme.test', defaultCurrency: 'EUR', timezone: 'UTC' });
    const cleared = await put(apiKey, { displayName: null, supportEmail: null, defaultCurrency: null, timezone: null });
    expect(cleared.statusCode).toBe(200);
    // Display name and support email fall back to the merchant account; currency/timezone to defaults.
    expect(cleared.json().settings).toMatchObject({
      displayName: 'Settings Store', supportEmail: 'owner@example.com', defaultCurrency: 'USDC', timezone: 'UTC',
    });
  });

  it('validates settings and rejects malformed values', async () => {
    expect((await put(apiKey, { displayName: '', supportEmail: null, defaultCurrency: null, timezone: null })).statusCode).toBe(400);
    expect((await put(apiKey, { displayName: 'x', supportEmail: 'not-an-email', defaultCurrency: null, timezone: null })).statusCode).toBe(400);
    expect((await put(apiKey, { displayName: 'x', supportEmail: null, defaultCurrency: '1USDC', timezone: null })).statusCode).toBe(400);
    expect((await put(apiKey, { displayName: 'x', supportEmail: null, defaultCurrency: null, timezone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await put(apiKey, { displayName: 'x'.repeat(121), supportEmail: null, defaultCurrency: null, timezone: null })).statusCode).toBe(400);
    // Nothing was persisted by the rejected writes.
    expect((await get(apiKey)).json().settings).toMatchObject({ displayName: 'Settings Store' });
  });

  it('rejects and never exposes sensitive fields', async () => {
    for (const sensitive of [
      { apiKey: 'tf_live_secret' }, { walletAddress: '0xdeadbeef' }, { status: 'suspended' },
      { secret: 'whsec_secret' }, { privateKey: '0xprivate' }, { providerCredential: 'sk-123' },
    ]) {
      const rejected = await put(apiKey, { displayName: 'Acme', ...sensitive });
      expect(rejected.statusCode, JSON.stringify(sensitive)).toBe(400);
    }
    const read = await get(apiKey);
    expect(read.body).not.toContain('tf_live_secret');
    expect(read.json().settings).not.toHaveProperty('walletAddress');
    expect(read.json().settings).not.toHaveProperty('status');
    expect(read.json().settings).not.toHaveProperty('apiKey');
    // The merchant account row (wallet/status) is untouched by the rejected writes.
    const account = await db.query<{ wallet_address: string; status: string }>(
      'SELECT wallet_address, status FROM merchants WHERE id = $1', [merchantId],
    );
    expect(account.rows[0]).toMatchObject({
      wallet_address: '0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a', status: 'active',
    });
  });

  it('keeps settings isolated between merchants', async () => {
    const other = await createMerchant('Other Settings', 'other-settings@example.com', '0x2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b');
    await put(apiKey, { displayName: 'Mine', supportEmail: null, defaultCurrency: 'EUR', timezone: 'UTC' });
    await put(other.apiKey, { displayName: 'Theirs', supportEmail: null, defaultCurrency: 'GBP', timezone: 'UTC' });

    expect((await get(apiKey)).json().settings).toMatchObject({ displayName: 'Mine', defaultCurrency: 'EUR' });
    expect((await get(other.apiKey)).json().settings).toMatchObject({ displayName: 'Theirs', defaultCurrency: 'GBP' });
  });

  it('rejects unauthenticated requests', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/settings' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/v1/settings', payload: { displayName: 'X' } })).statusCode).toBe(401);
  });
});
