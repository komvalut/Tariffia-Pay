import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { SmsProviderError } from '../src/sms-provider.js';
import { SmsProviderRegistry } from '../src/sms-providers/registry.js';
import { MockSmsProvider } from './fixtures/mock-sms-provider.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const providerSecret = 'sms-live-must-never-appear-in-any-response-9876543210';

function pgAdapterPool(memory: ReturnType<typeof newDb>): Pool {
  const adapter = memory.adapters.createPg();
  return new adapter.Pool() as Pool;
}

async function createDatabase(): Promise<Database> {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const pool = new pgAdapterPool(memory);
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
    '0010_sms_provider_hardening.sql']) {
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

describe('SMS provider hardening, selection and fallback', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let primary: MockSmsProvider;
  let fallback: MockSmsProvider;
  let apiKey: string;
  let merchantId: string;
  let customerId: string;
  let primaryProviderId: string;
  let fallbackProviderId: string;
  let smsServiceId: string;

  async function configureService(overrides: Record<string, unknown> = {}) {
    const primaryProvider = await app.inject({
      method: 'POST', url: '/v1/admin/sms/providers', headers: adminHeaders,
      payload: { slug: 'mock-sms', name: 'Primary Mock' },
    });
    primaryProviderId = primaryProvider.json().provider.id as string;
    const fallbackProvider = await app.inject({
      method: 'POST', url: '/v1/admin/sms/providers', headers: adminHeaders,
      payload: { slug: 'mock-sms-backup', name: 'Backup Mock' },
    });
    fallbackProviderId = fallbackProvider.json().provider.id as string;
    const serviceResponse = await app.inject({
      method: 'POST', url: `/v1/admin/sms/providers/${primaryProviderId}/services`, headers: adminHeaders,
      payload: {
        slug: 'otp_sms', name: 'OTP SMS', type: 'otp_sms', enabled: true,
        providerCostPerSmsUsd: '0.00400000', customerPricePerSmsUsd: '0.00500000',
        markupBps: 0, otpLength: 6, otpExpirySeconds: 300, maxMessageLength: 480,
        fallbackProviderId, ...overrides,
      },
    });
    expect(serviceResponse.statusCode, serviceResponse.body).toBe(201);
    smsServiceId = serviceResponse.json().service.id as string;
  }

  async function creditBalance(customer: string) {
    const balance = await db.query<{ balance_units: string }>(
      'SELECT balance_units::text AS balance_units FROM credit_accounts WHERE customer_id = $1', [customer],
    );
    return balance.rows[0]?.balance_units ?? null;
  }

  const smsPayload = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'sms-request-0001', service: 'otp_sms', to: '+381601234567',
    message: 'Your package has shipped', customerId, ...overrides,
  });

  const otpPayload = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'otp-request-0001', service: 'otp_sms', to: '+381601234567', customerId, ...overrides,
  });

  beforeEach(async () => {
    db = await createDatabase();
    primary = new MockSmsProvider('mock-sms', 'Primary Mock');
    fallback = new MockSmsProvider('mock-sms-backup', 'Backup Mock');
    const registry = new SmsProviderRegistry();
    registry.register(primary, { enabled: true, settings: { apiKey: providerSecret } });
    registry.register(fallback, { enabled: true, settings: { apiKey: providerSecret } });
    await registry.initialize();
    app = await buildApp({ db, smsProviderRegistry: registry });
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name: 'Fallback Store', email: 'fallback@example.com', walletAddress: '0x7777777777777777777777777777777777777777' },
    });
    apiKey = merchant.json().apiKey as string;
    merchantId = merchant.json().merchant.id as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'fallback-customer' },
    });
    customerId = customer.json().customer.id as string;
    await configureService();
    await db.query(
      `INSERT INTO credit_accounts (id, merchant_id, customer_id, balance_units)
       VALUES ($1, $2, $3, $4)`,
      ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', merchantId, customerId, parseUnits('100', 6).toString()],
    );
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('delivers through the healthy primary provider without touching the fallback', async () => {
    primary.options = { segments: 1, providerCostUsd: '0.00400000' };
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({
      provider: 'mock-sms', fallbackUsed: false, status: 'sent',
    });
    expect(primary.smsCalls).toHaveLength(1);
    expect(fallback.smsCalls).toHaveLength(0);
    const request = await db.query<{ provider: string; status: string; attempts: unknown[] }>(
      `SELECT p.slug AS provider, r.status, r.attempts FROM sms_provider_requests r
         JOIN sms_providers p ON p.id = r.provider_id`,
    );
    expect(request.rows[0]).toMatchObject({ provider: 'mock-sms', status: 'COMPLETED' });
    expect(request.rows[0].attempts).toEqual([]);
  });

  it('falls back to the explicitly configured provider when the primary is unhealthy', async () => {
    primary.options = { health: { status: 'unavailable', message: 'upstream is down' } };
    fallback.options = { segments: 1, providerCostUsd: '0.00500000' };
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({
      provider: 'mock-sms-backup', fallbackUsed: true, status: 'sent',
    });
    expect(primary.smsCalls).toHaveLength(0);
    expect(fallback.smsCalls).toHaveLength(1);

    // Exactly one charge, one usage record and one ledger entry; the accepting provider is recorded.
    expect(await creditBalance(customerId)).toBe(parseUnits('99.5', 6).toString());
    const usage = await db.query<{ provider: string; units: string; provider_cost_usd: string }>(
      `SELECT p.slug AS provider, units::text AS units, provider_cost_usd::text AS provider_cost_usd
         FROM sms_usage_records u JOIN sms_providers p ON p.id = u.provider_id`,
    );
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ provider: 'mock-sms-backup', units: '1' });
    expect(Number(usage.rows[0].provider_cost_usd)).toBeCloseTo(0.005, 8);
    const ledger = await db.query<{ entry_type: string }>(
      'SELECT entry_type FROM ledger_entries',
    );
    expect(ledger.rows.filter((entry) => entry.entry_type === 'CREDIT_DEDUCTION')).toHaveLength(1);

    const request = await db.query<{ provider: string; status: string; attempts: Array<Record<string, unknown>> }>(
      `SELECT p.slug AS provider, r.status, r.attempts FROM sms_provider_requests r
         JOIN sms_providers p ON p.id = r.provider_id`,
    );
    expect(request.rows[0]).toMatchObject({ provider: 'mock-sms-backup', status: 'COMPLETED' });
    expect(request.rows[0].attempts).toEqual([expect.objectContaining({
      provider: 'mock-sms', outcome: 'skipped_unhealthy', failureKind: 'unhealthy_unavailable',
    })]);
    // The unhealthy check result is visible to administrators without secrets.
    const providers = await app.inject({ method: 'GET', url: '/v1/admin/sms/providers', headers: adminHeaders });
    expect(providers.json().providers.find((provider: { slug: string }) => provider.slug === 'mock-sms'))
      .toMatchObject({ lastStatus: 'unavailable' });
    expect(providers.body).not.toContain(providerSecret);
  });

  it('falls back when the primary is unconfigured or temporarily unavailable', async () => {
    primary.options = { configured: false };
    const unconfigured = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-unconfigured' }),
    });
    expect(unconfigured.statusCode).toBe(201);
    expect(unconfigured.json().request).toMatchObject({ provider: 'mock-sms-backup', fallbackUsed: true });
    expect(fallback.smsCalls).toHaveLength(1);

    primary.options = {
      failure: new SmsProviderError('unavailable', 'mock-sms', 'The SMS provider is temporarily unavailable', true, 503),
    };
    const unavailable = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-unavailable' }),
    });
    expect(unavailable.statusCode).toBe(201);
    expect(unavailable.json().request).toMatchObject({ provider: 'mock-sms-backup', fallbackUsed: true });
    expect(primary.smsCalls).toHaveLength(1);
    expect(fallback.smsCalls).toHaveLength(2);
    const request = await db.query<{ status: string; attempts: Array<Record<string, unknown>> }>(
      `SELECT status, attempts FROM sms_provider_requests WHERE request_id = 'sms-request-unavailable'`,
    );
    expect(request.rows[0].attempts).toEqual([expect.objectContaining({
      provider: 'mock-sms', outcome: 'failed', failureKind: 'unavailable',
    })]);
    expect(await creditBalance(customerId)).toBe(parseUnits('99', 6).toString());
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(2);
  });

  it('falls back on rate limiting while preserving the retry-after hint', async () => {
    primary.options = {
      failure: new SmsProviderError(
        'rate_limited', 'mock-sms', 'The SMS provider is rate limiting this deployment', true, 503,
        { retryAfterMs: 30_000 },
      ),
    };
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({ provider: 'mock-sms-backup', fallbackUsed: true });
    const request = await db.query<{ attempts: Array<Record<string, unknown>> }>(
      'SELECT attempts FROM sms_provider_requests',
    );
    expect(request.rows[0].attempts).toEqual([expect.objectContaining({
      provider: 'mock-sms', outcome: 'failed', failureKind: 'rate_limited', retryAfterMs: 30_000,
    })]);
  });

  it('never falls back from a timeout unless the provider guarantees idempotent retries', async () => {
    primary.options = {
      failure: new SmsProviderError('timeout', 'mock-sms', 'The SMS provider request timed out', true, 504),
    };
    const ambiguous = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(ambiguous.statusCode).toBe(504);
    expect(ambiguous.json()).toEqual({ error: 'sms_provider_timeout', message: 'The SMS provider request timed out' });
    expect(fallback.smsCalls).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(0);
    const failed = await db.query<{ status: string; failure_kind: string; attempts: Array<Record<string, unknown>> }>(
      'SELECT status, failure_kind, attempts FROM sms_provider_requests',
    );
    expect(failed.rows[0]).toMatchObject({ status: 'FAILED', failure_kind: 'timeout' });
    expect(failed.rows[0].attempts).toEqual([expect.objectContaining({ provider: 'mock-sms', outcome: 'failed' })]);

    // With the provider's idempotent-retry capability declared, the timeout becomes safe to retry.
    primary.options = {
      idempotentRetries: true,
      failure: new SmsProviderError('timeout', 'mock-sms', 'The SMS provider request timed out', true, 504),
    };
    const registry = new SmsProviderRegistry();
    registry.register(primary, { enabled: true, settings: { apiKey: providerSecret } });
    registry.register(fallback, { enabled: true, settings: { apiKey: providerSecret } });
    await registry.initialize();
    app = await buildApp({ db, smsProviderRegistry: registry });
    const safe = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-timeout-safe' }),
    });
    expect(safe.statusCode).toBe(201);
    expect(safe.json().request).toMatchObject({ provider: 'mock-sms-backup', fallbackUsed: true });
  });

  it('never falls back from non-retryable provider failures', async () => {
    for (const [kind, statusCode] of [
      ['invalid_request', 400], ['unauthorized', 502], ['invalid_response', 502], ['not_found', 422],
    ] as const) {
      primary.options = {
        failure: new SmsProviderError(kind, 'mock-sms', `detail ${kind}`, false, statusCode),
      };
      const response = await app.inject({
        method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
        payload: smsPayload({ requestId: `sms-request-${kind}` }),
      });
      expect(response.statusCode, kind).toBe(statusCode);
      expect(response.body, kind).not.toContain('detail');
      expect(fallback.smsCalls, kind).toHaveLength(0);
    }
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(0);
    const failed = await db.query<{ status: string }>('SELECT status FROM sms_provider_requests');
    expect(failed.rows).toHaveLength(4);
    expect(failed.rows.every((row) => row.status === 'FAILED')).toBe(true);
  });

  it('fails safely before sending when no provider is available', async () => {
    primary.options = { health: { status: 'unavailable', message: 'down' } };
    fallback.options = { health: { status: 'degraded', message: 'degraded' } };
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'sms_provider_unavailable', message: 'The SMS provider is temporarily unavailable',
    });
    expect(primary.smsCalls).toHaveLength(0);
    expect(fallback.smsCalls).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(0);
    const failed = await db.query<{ status: string; failure_kind: string; attempts: unknown[] }>(
      'SELECT status, failure_kind, attempts FROM sms_provider_requests',
    );
    expect(failed.rows[0]).toMatchObject({ status: 'FAILED', failure_kind: 'unavailable' });
    expect(failed.rows[0].attempts).toHaveLength(2);
    const webhook = await db.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM webhook_events WHERE event_type = 'sms.request.failed'`,
    );
    expect(webhook.rows[0].payload).not.toContain('Your package has shipped');
  });

  it('does not attempt an unconfigured fallback or a fallback disabled in the database', async () => {
    primary.options = { health: { status: 'unavailable', message: 'down' } };
    fallback.options = { configured: false };
    const unconfigured = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(unconfigured.statusCode).toBe(503);
    expect(fallback.smsCalls).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());

    fallback.options = {};
    await app.inject({
      method: 'PUT', url: `/v1/admin/sms/providers/${fallbackProviderId}`, headers: adminHeaders,
      payload: { enabled: false },
    });
    const disabled = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-disabled-fallback' }),
    });
    expect(disabled.statusCode).toBe(503);
    expect(fallback.smsCalls).toHaveLength(0);
    expect(fallback.healthChecks).toBe(0);
    const failed = await db.query<{ status: string; attempts: unknown[] }>(
      'SELECT status, attempts FROM sms_provider_requests',
    );
    expect(failed.rows).toHaveLength(2);
    expect(failed.rows.every((row) => row.status === 'FAILED')).toBe(true);
    expect(failed.rows[1].attempts).toHaveLength(1);
  });

  it('never calls any provider without sufficient credits and keeps duplicate requests single-charge', async () => {
    await db.query('UPDATE credit_accounts SET balance_units = 1 WHERE customer_id = $1', [customerId]);
    const insufficient = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(insufficient.statusCode).toBe(409);
    expect(primary.healthChecks).toBe(0);
    expect(fallback.healthChecks).toBe(0);
    expect(primary.smsCalls).toHaveLength(0);

    await db.query('UPDATE credit_accounts SET balance_units = $1 WHERE customer_id = $2',
      [parseUnits('100', 6).toString(), customerId]);
    const first = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(first.statusCode).toBe(201);
    const duplicate = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe('sms_request_conflict');
    expect(primary.smsCalls).toHaveLength(1);
    expect(fallback.smsCalls).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe(parseUnits('99.5', 6).toString());
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(1);
  });

  it('uses one stable idempotency key across the primary and fallback attempts', async () => {
    primary.options = {
      failure: new SmsProviderError('unavailable', 'mock-sms', 'The SMS provider is temporarily unavailable', true, 503),
    };
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(primary.smsCalls[0]).toMatchObject({
      requestId: 'sms-request-0001', idempotencyKey: 'sms-request-0001',
    });
    expect(fallback.smsCalls[0]).toMatchObject({
      requestId: 'sms-request-0001', idempotencyKey: 'sms-request-0001',
    });
    expect(primary.smsCalls[0].idempotencyKey).toBe(fallback.smsCalls[0].idempotencyKey);
  });

  it('keeps OTP codes and message content out of fallback attempts, webhooks and admin views', async () => {
    primary.options = { health: { status: 'unavailable', message: 'down' } };
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/otp', headers: { authorization: `Bearer ${apiKey}` }, payload: otpPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({ provider: 'mock-sms-backup', fallbackUsed: true, kind: 'OTP' });
    // The fallback provider received a rendered six-digit code; nothing else keeps it.
    expect(fallback.smsCalls).toHaveLength(1);
    const message = fallback.smsCalls[0].message;
    expect(message).toMatch(/^Your verification code is \d{6}$/);
    const code = message.slice(-6);

    const request = await db.query<{ attempts: string; failure_message: string | null }>(
      'SELECT attempts::text AS attempts, failure_message FROM sms_provider_requests',
    );
    for (const row of request.rows) {
      expect(row.attempts).not.toContain(code);
      expect(row.attempts).not.toContain(message);
    }
    const events = await db.query<{ payload: string }>('SELECT payload::text AS payload FROM webhook_events');
    for (const event of events.rows) {
      expect(event.payload).not.toContain(code);
      expect(event.payload).not.toContain(message);
    }
    for (const surface of ['/v1/admin/sms/requests', '/v1/admin/sms/usage', '/v1/admin/sms/providers']) {
      const admin = await app.inject({ method: 'GET', url: surface, headers: adminHeaders });
      expect(admin.statusCode, surface).toBe(200);
      expect(admin.body, surface).not.toContain(code);
      expect(admin.body, surface).not.toContain(message);
      expect(admin.body, surface).not.toContain(providerSecret);
    }
  });

  it('validates fallback configuration through the admin API', async () => {
    const sameAsPrimary = await app.inject({
      method: 'POST', url: `/v1/admin/sms/providers/${primaryProviderId}/services`, headers: adminHeaders,
      payload: {
        slug: 'broken-otp', name: 'Broken OTP', type: 'otp_sms', enabled: true,
        providerCostPerSmsUsd: '0.00400000', customerPricePerSmsUsd: '0.00500000',
        fallbackProviderId: primaryProviderId,
      },
    });
    expect(sameAsPrimary.statusCode).toBe(400);
    expect(sameAsPrimary.json().error).toBe('invalid_fallback_provider');

    const missing = await app.inject({
      method: 'POST', url: `/v1/admin/sms/providers/${primaryProviderId}/services`, headers: adminHeaders,
      payload: {
        slug: 'broken-otp', name: 'Broken OTP', type: 'otp_sms', enabled: true,
        providerCostPerSmsUsd: '0.00400000', customerPricePerSmsUsd: '0.00500000',
        fallbackProviderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    });
    expect(missing.statusCode).toBe(404);

    await app.inject({
      method: 'PUT', url: `/v1/admin/sms/providers/${fallbackProviderId}`, headers: adminHeaders,
      payload: { enabled: false },
    });
    const disabledFallback = await app.inject({
      method: 'POST', url: `/v1/admin/sms/providers/${primaryProviderId}/services`, headers: adminHeaders,
      payload: {
        slug: 'broken-otp', name: 'Broken OTP', type: 'otp_sms', enabled: true,
        providerCostPerSmsUsd: '0.00400000', customerPricePerSmsUsd: '0.00500000',
        fallbackProviderId: fallbackProviderId,
      },
    });
    expect(disabledFallback.statusCode).toBe(400);
    await app.inject({
      method: 'PUT', url: `/v1/admin/sms/providers/${fallbackProviderId}`, headers: adminHeaders,
      payload: { enabled: true },
    });

    const services = await app.inject({ method: 'GET', url: '/v1/admin/sms/services', headers: adminHeaders });
    expect(services.statusCode).toBe(200);
    const service = services.json().services.find((entry: { id: string }) => entry.id === smsServiceId);
    expect(service).toMatchObject({
      providerSlug: 'mock-sms', fallbackProviderSlug: 'mock-sms-backup', fallbackProviderEnabled: true,
    });
    expect(services.body).not.toContain(providerSecret);
  });

  it('reports per-provider request statistics without secrets to administrators', async () => {
    await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    primary.options = { health: { status: 'unavailable', message: 'down' } };
    await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-fallback' }),
    });
    const providers = await app.inject({ method: 'GET', url: '/v1/admin/sms/providers', headers: adminHeaders });
    expect(providers.statusCode).toBe(200);
    const bySlug = new Map(providers.json().providers.map((provider: { slug: string }) => [provider.slug, provider]));
    // Each request is attributed to the provider that actually accepted it.
    expect(bySlug.get('mock-sms')).toMatchObject({ requestCount: 1, completedCount: 1, failedCount: 0 });
    expect(bySlug.get('mock-sms-backup')).toMatchObject({ requestCount: 1, completedCount: 1, failedCount: 0 });
    expect(providers.body).not.toContain(providerSecret);
    expect(providers.body).not.toContain('Your package has shipped');

    const requests = await app.inject({ method: 'GET', url: '/v1/admin/sms/requests', headers: adminHeaders });
    const fallbackRequest = requests.json().requests.find(
      (entry: { requestId: string }) => entry.requestId === 'sms-request-fallback',
    );
    expect(fallbackRequest).toMatchObject({ provider: 'mock-sms-backup', status: 'COMPLETED' });
    expect(fallbackRequest.attempts).toEqual([expect.objectContaining({
      provider: 'mock-sms', outcome: 'skipped_unhealthy',
    })]);
    expect(requests.body).not.toContain('Your package has shipped');
  });

  it('preserves merchant isolation on the hardened endpoints', async () => {
    const anonymous = await app.inject({ method: 'POST', url: '/v1/sms/send', payload: smsPayload() });
    expect(anonymous.statusCode).toBe(401);
    const foreignCustomer = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-foreign', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    });
    expect(foreignCustomer.statusCode).toBe(404);
    const noAdmin = await app.inject({ method: 'GET', url: '/v1/admin/sms/requests' });
    expect(noAdmin.statusCode).toBe(401);
    expect(primary.smsCalls).toHaveLength(0);
    expect(fallback.smsCalls).toHaveLength(0);
    void merchantId;
  });
});
