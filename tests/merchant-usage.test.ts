import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { MerchantUsageService } from '../src/services/merchant-usage-service.js';

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
    '0010_sms_provider_hardening.sql', '0011_merchant_usage_limits.sql',
    '0012_payment_links.sql']) {
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

const WINDOW_MS = 6_000;

/**
 * Requests must land in the same fixed window for the limit assertions to be
 * deterministic, so counting tests wait out the tail of the current window. The reset
 * test instead shifts the counted row into a past window, which is exactly what a real
 * window rollover produces.
 */
async function alignWindow(): Promise<void> {
  const remaining = WINDOW_MS - (Date.now() % WINDOW_MS);
  if (remaining < WINDOW_MS / 2) await new Promise((resolve) => setTimeout(resolve, remaining + 100));
}

describe('per-merchant usage counters and rate limits', () => {
  // Window alignment plus per-test setup can be slow when the whole suite runs in parallel.
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
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

  async function setLimits(id: string, input: Record<string, number | null>) {
    const response = await app.inject({
      method: 'PUT', url: `/v1/admin/usage/merchants/${id}`, headers: adminHeaders,
      payload: {
        generalRequestsPerMinute: input.generalRequestsPerMinute ?? null,
        aiRequestsPerMinute: input.aiRequestsPerMinute ?? null,
        smsRequestsPerMinute: input.smsRequestsPerMinute ?? null,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response;
  }

  const general = (key: string) => app.inject({
    method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${key}` },
    payload: { externalId: `customer-${Math.random().toString(36).slice(2)}` },
  });
  const ai = (key: string) => app.inject({
    method: 'GET', url: '/v1/ai/models', headers: { authorization: `Bearer ${key}` },
  });
  const sms = (key: string) => app.inject({
    method: 'GET', url: '/v1/sms/services', headers: { authorization: `Bearer ${key}` },
  });

  beforeEach(async () => {
    db = await createDatabase();
    app = await buildApp({ db, merchantUsage: new MerchantUsageService(db, { windowMs: WINDOW_MS }) });
    const merchant = await createMerchant('Usage Store', 'usage@example.com', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    apiKey = merchant.apiKey;
    merchantId = merchant.merchantId;
    await alignWindow();
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('enforces an AI limit with a clear 429 and resets after the window', async () => {
    await setLimits(merchantId, { aiRequestsPerMinute: 2 });
    expect((await ai(apiKey)).statusCode).toBe(200);
    expect((await ai(apiKey)).statusCode).toBe(200);
    const limited = await ai(apiKey);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: 'merchant_rate_limited',
      message: 'Merchant ai request rate limit exceeded; retry later',
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(Math.ceil(WINDOW_MS / 1000) + 1);

    // Other categories are independent of the exhausted AI limit.
    expect((await sms(apiKey)).statusCode).toBe(200);
    expect((await general(apiKey)).statusCode).toBe(201);

    // Moving the counted window into the past is what a window rollover produces: the
    // current window is empty again and the merchant is allowed.
    await db.query(
      `UPDATE merchant_request_counters SET window_start = window_start - interval '10 minutes'`,
    );
    expect((await ai(apiKey)).statusCode).toBe(200);
  });

  it('enforces a SMS limit without affecting other categories', async () => {
    await setLimits(merchantId, { smsRequestsPerMinute: 1 });
    expect((await sms(apiKey)).statusCode).toBe(200);
    const limited = await sms(apiKey);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().message).toContain('sms');
    expect((await ai(apiKey)).statusCode).toBe(200);
    expect((await general(apiKey)).statusCode).toBe(201);
  });

  it('enforces a general API limit across ordinary merchant routes', async () => {
    await setLimits(merchantId, { generalRequestsPerMinute: 2 });
    expect((await general(apiKey)).statusCode).toBe(201);
    expect((await general(apiKey)).statusCode).toBe(201);
    const limited = await general(apiKey);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().message).toContain('general');
    // AI and SMS categories are unaffected.
    expect((await ai(apiKey)).statusCode).toBe(200);
    expect((await sms(apiKey)).statusCode).toBe(200);
  });

  it('keeps counters and limits isolated per merchant', async () => {
    const second = await createMerchant('Second Store', 'second@example.com', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    await setLimits(merchantId, { aiRequestsPerMinute: 1 });
    expect((await ai(apiKey)).statusCode).toBe(200);
    expect((await ai(apiKey)).statusCode).toBe(429);

    // The other merchant has its own window, counters and default limit.
    expect((await ai(second.apiKey)).statusCode).toBe(200);
    expect((await ai(second.apiKey)).statusCode).toBe(200);
    const detail = await app.inject({
      method: 'GET', url: `/v1/admin/usage/merchants/${second.merchantId}`, headers: adminHeaders,
    });
    expect(detail.json().counts.ai).toBe(2);
    expect(detail.json().limits.ai).toMatchObject({ limit: 60, source: 'default' });
  });

  it('applies configured defaults and lets an override disable or tighten a limit', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/admin/usage/merchants', headers: adminHeaders });
    const entry = list.json().usage.find((item: { merchantId: string }) => item.merchantId === merchantId);
    expect(entry.limits).toMatchObject({
      general: { limit: 300, source: 'default', unlimited: false },
      ai: { limit: 60, source: 'default', unlimited: false },
      sms: { limit: 60, source: 'default', unlimited: false },
    });
    expect(entry.counts).toEqual({ general: 0, ai: 0, sms: 0 });
    expect(entry.windowResetAt).toBeTruthy();

    await setLimits(merchantId, { aiRequestsPerMinute: 1 });
    expect((await ai(apiKey)).statusCode).toBe(200);
    expect((await ai(apiKey)).statusCode).toBe(429);

    // 0 means unlimited and takes effect immediately, even inside an exhausted window.
    const updated = await setLimits(merchantId, { aiRequestsPerMinute: 0 });
    expect(updated.json().limits.ai).toMatchObject({ unlimited: true, source: 'override' });
    expect((await ai(apiKey)).statusCode).toBe(200);
    expect((await ai(apiKey)).statusCode).toBe(200);
    const detail = await app.inject({
      method: 'GET', url: `/v1/admin/usage/merchants/${merchantId}`, headers: adminHeaders,
    });
    expect(detail.json().limits.ai.unlimited).toBe(true);
    expect(detail.json().counts.ai).toBe(3);
  });

  it('does not count admin, public, unauthenticated or invalid-key requests', async () => {
    await setLimits(merchantId, { generalRequestsPerMinute: 1 });
    // Admin and public requests, and requests without a valid merchant key, are not usage.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/usage/merchants', headers: adminHeaders })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET', url: '/v1/public/payment-methods', headers: { authorization: `Bearer ${apiKey}` },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET', url: '/v1/ai/models', headers: { authorization: 'Bearer not-a-real-key' },
    })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/ai/models' })).statusCode).toBe(401);

    expect((await general(apiKey)).statusCode).toBe(201);
    expect((await general(apiKey)).statusCode).toBe(429);
    const detail = await app.inject({
      method: 'GET', url: `/v1/admin/usage/merchants/${merchantId}`, headers: adminHeaders,
    });
    // Only the single real merchant general request was counted.
    expect(detail.json().counts.general).toBe(1);
  });

  it('requires the admin key for usage visibility and updates', async () => {
    for (const request of [
      { method: 'GET', url: '/v1/admin/usage/merchants' },
      { method: 'GET', url: `/v1/admin/usage/merchants/${merchantId}` },
      { method: 'PUT', url: `/v1/admin/usage/merchants/${merchantId}`, payload: { generalRequestsPerMinute: 5, aiRequestsPerMinute: 5, smsRequestsPerMinute: 5 } },
    ]) {
      const anonymous = await app.inject(request as never);
      expect(anonymous.statusCode).toBe(401);
    }
    const merchantScoped = await app.inject({
      method: 'GET', url: '/v1/admin/usage/merchants', headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(merchantScoped.statusCode).toBe(401);

    const missing = await app.inject({
      method: 'GET', url: '/v1/admin/usage/merchants/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', headers: adminHeaders,
    });
    expect(missing.statusCode).toBe(404);
    const cannotUpdate = await app.inject({
      method: 'PUT', url: '/v1/admin/usage/merchants/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', headers: adminHeaders,
      payload: { generalRequestsPerMinute: 1, aiRequestsPerMinute: 1, smsRequestsPerMinute: 1 },
    });
    expect(cannotUpdate.statusCode).toBe(404);
    const invalid = await app.inject({
      method: 'PUT', url: `/v1/admin/usage/merchants/${merchantId}`, headers: adminHeaders,
      payload: { generalRequestsPerMinute: 1 },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('serializes concurrent requests so a limit is never overshot', async () => {
    await setLimits(merchantId, { aiRequestsPerMinute: 3 });
    const responses = await Promise.all(Array.from({ length: 8 }, () => ai(apiKey)));
    const allowed = responses.filter((response) => response.statusCode === 200);
    const limited = responses.filter((response) => response.statusCode === 429);
    expect(allowed).toHaveLength(3);
    expect(limited).toHaveLength(5);
    const detail = await app.inject({
      method: 'GET', url: `/v1/admin/usage/merchants/${merchantId}`, headers: adminHeaders,
    });
    expect(detail.json().counts.ai).toBe(3);
  });

  it('lets a merchant read its own usage with correct per-category values', async () => {
    await setLimits(merchantId, { aiRequestsPerMinute: 5 });
    expect((await general(apiKey)).statusCode).toBe(201);
    expect((await ai(apiKey)).statusCode).toBe(200);
    expect((await sms(apiKey)).statusCode).toBe(200);

    const response = await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.statusCode).toBe(200);
    const usage = response.json().usage;
    // The usage request itself is a general merchant request and is counted before the handler.
    expect(usage.general).toMatchObject({ used: 2, limit: 300, unlimited: false, remaining: 298 });
    expect(usage.ai).toMatchObject({ used: 1, limit: 5, unlimited: false, remaining: 4 });
    expect(usage.sms).toMatchObject({ used: 1, limit: 60, unlimited: false, remaining: 59 });
    expect(response.body).not.toContain(apiKey);
    // Admin-only internals (the default/override source) are not exposed to merchants.
    expect(usage.ai).not.toHaveProperty('source');
  });

  it('reports unlimited and effective override limits for a merchant', async () => {
    const unlimitedOverride = await setLimits(merchantId, { aiRequestsPerMinute: 0 });
    expect(unlimitedOverride.json().limits.ai).toMatchObject({ unlimited: true });
    const response = await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${apiKey}` } });
    const usage = response.json().usage;
    expect(usage.ai).toMatchObject({ limit: null, unlimited: true, remaining: null });
    expect(usage.ai.used).toBeGreaterThanOrEqual(0);
    // Untouched categories keep the configured defaults.
    expect(usage.sms).toMatchObject({ limit: 60, unlimited: false });
  });

  it('returns window and reset information and rejects unauthenticated access', async () => {
    const before = Date.now();
    const authorized = await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${apiKey}` } });
    const usage = authorized.json().usage;
    const resetAt = new Date(usage.general.windowResetAt).getTime();
    const windowStart = new Date(usage.general.windowStart).getTime();
    expect(resetAt).toBeGreaterThan(before - 1000);
    expect(resetAt - windowStart).toBe(WINDOW_MS);
    expect(windowStart).toBeLessThanOrEqual(before + 1000);

    const anonymous = await app.inject({ method: 'GET', url: '/v1/usage' });
    expect(anonymous.statusCode).toBe(401);
    const invalidKey = await app.inject({
      method: 'GET', url: '/v1/usage', headers: { authorization: 'Bearer not-a-real-key' },
    });
    expect(invalidKey.statusCode).toBe(401);
  });

  it('never exposes another merchant usage to a merchant session', async () => {
    const other = await createMerchant('Other Store', 'other@example.com', '0xcccccccccccccccccccccccccccccccccccccccc');
    await setLimits(other.merchantId, { aiRequestsPerMinute: 7 });
    // The other merchant uses its own counter and override.
    expect((await ai(other.apiKey)).statusCode).toBe(200);

    const myUsage = await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${apiKey}` } });
    expect(myUsage.json().usage.ai).toMatchObject({ used: 0, limit: 60, remaining: 60 });
    expect(myUsage.body).not.toContain(other.merchantId);
    expect(myUsage.body).not.toContain('other@example.com');

    // A merchant key cannot reach the admin usage endpoints.
    const adminEndpoint = await app.inject({
      method: 'GET', url: `/v1/admin/usage/merchants/${other.merchantId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(adminEndpoint.statusCode).toBe(401);
  });
});
