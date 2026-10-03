import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };

const allEnabled = {
  paymentConfirmed: true,
  paymentFailed: true,
  paymentExpired: true,
  creditTopup: true,
  aiRequestFailed: true,
  smsRequestFailed: true,
  webhookFailed: true,
};

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
    '0013_merchant_settings.sql', '0014_notification_preferences.sql', '0015_audit_log.sql']) {
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

describe('merchant notification preferences', () => {
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

  const get = (key: string) => app.inject({
    method: 'GET', url: '/v1/notification-preferences', headers: { authorization: `Bearer ${key}` },
  });
  const put = (key: string, payload: Record<string, unknown>) => app.inject({
    method: 'PUT', url: '/v1/notification-preferences', headers: { authorization: `Bearer ${key}` }, payload,
  });

  beforeEach(async () => {
    db = await createDatabase();
    app = await buildApp({ db });
    apiKey = await createMerchant('Notify Store', 'notify@example.com', '0x3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c');
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('defaults every preference to enabled', async () => {
    const response = await get(apiKey);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().preferences).toMatchObject({ ...allEnabled, updatedAt: null });
    expect(response.body).not.toContain('secret');
  });

  it('updates and persists selected preferences', async () => {
    const updated = await put(apiKey, { ...allEnabled, paymentExpired: false, aiRequestFailed: false, webhookFailed: false });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().preferences).toMatchObject({
      paymentConfirmed: true, paymentFailed: true, paymentExpired: false, creditTopup: true,
      aiRequestFailed: false, smsRequestFailed: true, webhookFailed: false,
    });
    expect(updated.json().preferences.updatedAt).toBeTruthy();

    // Persisted across reads.
    const reread = await get(apiKey);
    expect(reread.json().preferences).toMatchObject({
      paymentExpired: false, aiRequestFailed: false, webhookFailed: false, smsRequestFailed: true,
    });
    // All disabled is a valid state.
    const allOff = await put(apiKey, {
      paymentConfirmed: false, paymentFailed: false, paymentExpired: false, creditTopup: false,
      aiRequestFailed: false, smsRequestFailed: false, webhookFailed: false,
    });
    expect(allOff.statusCode).toBe(200);
    expect((await get(apiKey)).json().preferences).toMatchObject({
      paymentConfirmed: false, creditTopup: false, smsRequestFailed: false,
    });
  });

  it('keeps preferences isolated between merchants', async () => {
    const other = await createMerchant('Other Notify', 'other-notify@example.com', '0x4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d');
    await put(apiKey, { ...allEnabled, paymentConfirmed: false });
    await put(other, { ...allEnabled, smsRequestFailed: false });

    expect((await get(apiKey)).json().preferences).toMatchObject({ paymentConfirmed: false, smsRequestFailed: true });
    expect((await get(other)).json().preferences).toMatchObject({ paymentConfirmed: true, smsRequestFailed: false });
  });

  it('rejects unknown or invalid fields', async () => {
    const { smsRequestFailed: _missing, ...missingOne } = allEnabled;
    expect((await put(apiKey, missingOne)).statusCode).toBe(400);
    expect((await put(apiKey, { ...allEnabled, emailEnabled: true })).statusCode).toBe(400);
    expect((await put(apiKey, { ...allEnabled, apiKey: 'tf_live_secret' })).statusCode).toBe(400);
    expect((await put(apiKey, { ...allEnabled, paymentConfirmed: 'yes' })).statusCode).toBe(400);
    // Rejected writes changed nothing.
    expect((await get(apiKey)).json().preferences).toMatchObject(allEnabled);
  });

  it('rejects unauthenticated requests', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/notification-preferences' })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'PUT', url: '/v1/notification-preferences', payload: allEnabled,
    })).statusCode).toBe(401);
  });
});
