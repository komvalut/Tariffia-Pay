import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { SmsProviderRegistry } from '../src/sms-providers/registry.js';
import { TextBeeSmsProvider } from '../src/sms-providers/textbee-sms-provider.js';
import { MockSmsProvider } from './fixtures/mock-sms-provider.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const textbeeApiKey = 'textbee-live-must-never-appear-in-any-response-9876543210';
const smsBatchId = 'batch_5f8ac3d2e4b01a7c9d0e6f7a';

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
    '0010_sms_provider_hardening.sql',
    '0011_merchant_usage_limits.sql',
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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type TextBeeApi = {
  devices?: () => Response;
  send?: () => Response;
  calls: Array<{ url: string; method: string; body?: string }>;
};

function textbeeApi(api: TextBeeApi) {
  const device = { _id: 'device-abc123', enabled: true, isDefault: true };
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    api.calls.push({ url: target, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    if (target.endsWith('/gateway/devices')) {
      return api.devices ? api.devices() : jsonResponse({ data: [device] });
    }
    if (target.endsWith('/gateway/send-sms')) {
      return api.send ? api.send() : jsonResponse({
        data: { success: true, message: 'SMS added to queue for processing', smsBatchId, recipientCount: 1 },
      });
    }
    throw new Error(`unexpected TextBee endpoint: ${target}`);
  }) as unknown as typeof fetch;
}

describe('TextBee SMS provider gateway integration', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let api: TextBeeApi;
  let fallback: MockSmsProvider;
  let apiKey: string;
  let merchantId: string;
  let customerId: string;
  let textbeeProviderId: string;
  let fallbackProviderId: string;

  const smsPayload = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'sms-request-0001', service: 'otp_sms', to: '+381601234567',
    message: 'Your package has shipped', customerId, ...overrides,
  });

  const otpPayload = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'otp-request-0001', service: 'otp_sms', to: '+381601234567', customerId, ...overrides,
  });

  async function creditBalance(customer: string) {
    const balance = await db.query<{ balance_units: string }>(
      'SELECT balance_units::text AS balance_units FROM credit_accounts WHERE customer_id = $1', [customer],
    );
    return balance.rows[0]?.balance_units ?? null;
  }

  beforeEach(async () => {
    db = await createDatabase();
    api = { calls: [] };
    const textbee = new TextBeeSmsProvider(textbeeApi(api));
    await textbee.initialize({ apiKey: textbeeApiKey, baseUrl: 'https://api.textbee.dev/api/v1' });
    fallback = new MockSmsProvider('mock-sms-backup', 'Backup Mock');
    const registry = new SmsProviderRegistry();
    registry.register(textbee, { enabled: true, settings: { apiKey: textbeeApiKey } });
    registry.register(fallback, { enabled: true, settings: { apiKey: 'fallback-key' } });
    await registry.initialize();
    app = await buildApp({ db, smsProviderRegistry: registry });

    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name: 'TextBee Store', email: 'textbee@example.com', walletAddress: '0x8888888888888888888888888888888888888888' },
    });
    apiKey = merchant.json().apiKey as string;
    merchantId = merchant.json().merchant.id as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'textbee-customer' },
    });
    customerId = customer.json().customer.id as string;

    const textbeeRow = await app.inject({
      method: 'POST', url: '/v1/admin/sms/providers', headers: adminHeaders,
      payload: { slug: 'textbee', name: 'TextBee', integration: 'http-sms' },
    });
    textbeeProviderId = textbeeRow.json().provider.id as string;
    const fallbackRow = await app.inject({
      method: 'POST', url: '/v1/admin/sms/providers', headers: adminHeaders,
      payload: { slug: 'mock-sms-backup', name: 'Backup Mock' },
    });
    fallbackProviderId = fallbackRow.json().provider.id as string;
    const service = await app.inject({
      method: 'POST', url: `/v1/admin/sms/providers/${textbeeProviderId}/services`, headers: adminHeaders,
      payload: {
        slug: 'otp_sms', name: 'OTP SMS', type: 'otp_sms', enabled: true,
        providerCostPerSmsUsd: '0.00000000', customerPricePerSmsUsd: '0.00500000',
        markupBps: 0, otpLength: 6, otpExpirySeconds: 300, maxMessageLength: 480,
        fallbackProviderId: fallbackProviderId,
      },
    });
    expect(service.statusCode, service.body).toBe(201);
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

  it('delivers an SMS through TextBee and settles the estimated charge', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({
      provider: 'textbee', kind: 'SMS', status: 'sent', fallbackUsed: false,
      providerRequestId: 'sms-request-0001', providerMessageId: smsBatchId,
    });
    // usageSource stays estimated: TextBee reports no segment counts.
    expect(response.json().usage).toMatchObject({
      units: 1, usageSource: 'estimated',
      customerPriceUsd: '0.00500000', creditsDeducted: '0.5', balanceAfter: '99.5',
    });
    expect(response.body).not.toContain('providerCostUsd');

    const sendCall = api.calls.at(-1);
    expect(sendCall).toMatchObject({ method: 'POST' });
    expect(sendCall?.body).toBe(JSON.stringify({
      recipients: ['+381601234567'], message: 'Your package has shipped',
    }));

    const request = await db.query<{ provider: string; status: string; provider_message_id: string }>(
      `SELECT p.slug AS provider, r.status, r.provider_message_id FROM sms_provider_requests r
         JOIN sms_providers p ON p.id = r.provider_id`,
    );
    expect(request.rows[0]).toMatchObject({
      provider: 'textbee', status: 'COMPLETED', provider_message_id: smsBatchId,
    });
    const usage = await db.query<{ provider: string; provider_cost_usd: string }>(
      `SELECT p.slug AS provider, provider_cost_usd::text AS provider_cost_usd
         FROM sms_usage_records u JOIN sms_providers p ON p.id = u.provider_id`,
    );
    // TextBee reports no cost; the service's configured provider cost (zero) is recorded.
    expect(usage.rows[0]).toMatchObject({ provider: 'textbee' });
    expect(Number(usage.rows[0].provider_cost_usd)).toBe(0);
    const ledger = await db.query<{ entry_type: string; amount: string }>(
      'SELECT entry_type, amount::text AS amount FROM ledger_entries',
    );
    expect(ledger.rows).toEqual([{ entry_type: 'CREDIT_DEDUCTION', amount: '0.5' }]);
    expect(await creditBalance(customerId)).toBe(parseUnits('99.5', 6).toString());
    expect(fallback.smsCalls).toHaveLength(0);
  });

  it('renders the OTP server-side and never persists or logs the code', async () => {
    const appLogs: string[] = [];
    const originalError = app.log.error.bind(app.log);
    (app.log as { error: unknown }).error = (...args: unknown[]) => {
      appLogs.push(JSON.stringify(args));
      return originalError(...args as []);
    };
    let response;
    try {
      response = await app.inject({
        method: 'POST', url: '/v1/sms/otp', headers: { authorization: `Bearer ${apiKey}` }, payload: otpPayload(),
      });
    } finally {
      (app.log as { error: unknown }).error = originalError;
    }
    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({ provider: 'textbee', kind: 'OTP' });
    expect(response.body).not.toMatch(/"code"/i);

    const sendBody = JSON.parse(api.calls.at(-1)?.body ?? '{}');
    expect(sendBody.message).toMatch(/^Your verification code is \d{6}$/);
    const code = String(sendBody.message).slice(-6);
    expect(appLogs.join('')).not.toContain(code);
    expect(appLogs.join('')).not.toContain('Your verification code is');
    expect(appLogs.join('')).not.toContain(textbeeApiKey);

    const rows = await db.query<{ attempts: string }>(
      'SELECT attempts::text AS attempts FROM sms_provider_requests',
    );
    for (const row of rows.rows) {
      expect(row.attempts).not.toContain(code);
    }
    const events = await db.query<{ payload: string }>(
      'SELECT payload::text AS payload FROM webhook_events',
    );
    for (const event of events.rows) {
      expect(event.payload).not.toContain(code);
      expect(event.payload).not.toContain('Your verification code is');
    }
    for (const surface of ['/v1/admin/sms/requests', '/v1/admin/sms/usage', '/v1/admin/sms/providers']) {
      const admin = await app.inject({ method: 'GET', url: surface, headers: adminHeaders });
      expect(admin.body, surface).not.toContain(code);
      expect(admin.body, surface).not.toContain(textbeeApiKey);
    }
  });

  it('does not retry or fall back after an ambiguous TextBee timeout', async () => {
    const provider = new TextBeeSmsProvider((async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/gateway/devices')) {
        return jsonResponse({ data: [{ _id: 'device-abc123', enabled: true, isDefault: true }] });
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }) as unknown as typeof fetch);
    await provider.initialize({ apiKey: textbeeApiKey, timeoutMs: 500, baseUrl: 'https://api.textbee.dev/api/v1' });
    const registry = new SmsProviderRegistry();
    registry.register(provider, { enabled: true, settings: { apiKey: textbeeApiKey, timeoutMs: 500 } });
    registry.register(fallback, { enabled: true, settings: { apiKey: 'fallback-key' } });
    await registry.initialize();
    app = await buildApp({ db, smsProviderRegistry: registry });
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({
      error: 'sms_provider_timeout', message: 'The SMS provider request timed out',
    });
    // TextBee declares no idempotent retries, so the timeout is ambiguous: no second send.
    expect(fallback.smsCalls).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(0);
    const failed = await db.query<{ status: string; failure_kind: string }>(
      'SELECT status, failure_kind FROM sms_provider_requests',
    );
    expect(failed.rows[0]).toMatchObject({ status: 'FAILED', failure_kind: 'timeout' });
  }, 15_000);

  it('falls back from a rate-limited TextBee send while preserving the retry hint', async () => {
    api.send = () => jsonResponse({ message: 'daily limit used up' }, 429, { 'retry-after': '30' });
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({
      provider: 'mock-sms-backup', fallbackUsed: true, status: 'sent',
    });
    const request = await db.query<{ attempts: Array<Record<string, unknown>> }>(
      'SELECT attempts FROM sms_provider_requests',
    );
    expect(request.rows[0].attempts).toEqual([expect.objectContaining({
      provider: 'textbee', outcome: 'failed', failureKind: 'rate_limited', retryAfterMs: 30_000,
    })]);
    expect(await creditBalance(customerId)).toBe(parseUnits('99.5', 6).toString());
  });

  it('does not fall back from a TextBee rejection (invalid request or unauthorized)', async () => {
    for (const [status, expectedError] of [[400, 'sms_provider_invalid_request'], [401, 'sms_provider_unauthorized']] as const) {
      api.send = () => jsonResponse({ message: 'raw provider detail' }, status);
      const response = await app.inject({
        method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
        payload: smsPayload({ requestId: `sms-request-${status}` }),
      });
      expect(response.statusCode, String(status)).toBe(status === 400 ? 502 : 502);
      expect(response.json().error, String(status)).toBe(expectedError);
      expect(response.body).not.toContain('raw provider detail');
      expect(response.body).not.toContain(textbeeApiKey);
      expect(fallback.smsCalls, String(status)).toHaveLength(0);
    }
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(0);
    const failed = await db.query<{ status: string }>('SELECT status FROM sms_provider_requests');
    expect(failed.rows.every((row) => row.status === 'FAILED')).toBe(true);
  });

  it('skips an unhealthy TextBee device and uses the configured fallback', async () => {
    api.devices = () => jsonResponse({ data: [{ _id: 'device-abc123', enabled: false }] });
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({
      provider: 'mock-sms-backup', fallbackUsed: true,
    });
    // The send endpoint is never reached: no SMS could be sent through TextBee.
    expect(api.calls.filter((call) => call.url.endsWith('/gateway/send-sms'))).toHaveLength(0);
    const providers = await app.inject({ method: 'GET', url: '/v1/admin/sms/providers', headers: adminHeaders });
    const textbee = providers.json().providers.find((provider: { slug: string }) => provider.slug === 'textbee');
    expect(textbee).toMatchObject({ configured: true, lastStatus: 'unavailable', installed: true });
    expect(textbee.capabilities).toMatchObject({ sendSms: true, idempotentRetries: false });
    expect(textbee.configuration).toEqual({ deviceIdConfigured: false, simSubscriptionConfigured: false });
    expect(providers.body).not.toContain(textbeeApiKey);
  });

  it('never contacts TextBee without sufficient credits', async () => {
    await db.query('UPDATE credit_accounts SET balance_units = 1 WHERE customer_id = $1', [customerId]);
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('insufficient_credits');
    expect(api.calls).toHaveLength(0);
    expect(fallback.smsCalls).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe('1');
  });

  it('preserves merchant isolation and rejects duplicates', async () => {
    const anonymous = await app.inject({ method: 'POST', url: '/v1/sms/send', payload: smsPayload() });
    expect(anonymous.statusCode).toBe(401);
    const foreign = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-foreign', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    });
    expect(foreign.statusCode).toBe(404);
    expect(api.calls).toHaveLength(0);

    const first = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(first.statusCode).toBe(201);
    const duplicate = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe('sms_request_conflict');
    expect(api.calls.filter((call) => call.url.endsWith('/gateway/send-sms'))).toHaveLength(1);
    expect(fallback.smsCalls).toHaveLength(0);
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(1);
  });

  it('maps an unavailable TextBee API to a safe fallback', async () => {
    api.send = () => jsonResponse({ message: 'upstream error' }, 503);
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({ provider: 'mock-sms-backup', fallbackUsed: true });
    expect(response.body).not.toContain('upstream error');
    const request = await db.query<{ attempts: Array<Record<string, unknown>> }>(
      'SELECT attempts FROM sms_provider_requests',
    );
    expect(request.rows[0].attempts).toEqual([expect.objectContaining({
      provider: 'textbee', outcome: 'failed', failureKind: 'unavailable',
    })]);
    expect(await creditBalance(customerId)).toBe(parseUnits('99.5', 6).toString());
  });
});
