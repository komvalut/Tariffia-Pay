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
import { estimateSmsSegments } from '../src/services/sms-gateway-service.js';
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
    '0007_subscriptions.sql', '0008_ai_provider_integration.sql', '0009_sms_otp.sql']) {
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

describe('SMS and OTP charging gateway', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let provider: MockSmsProvider;
  let apiKey: string;
  let merchantId: string;
  let customerId: string;
  let smsProviderId: string;
  let smsServiceId: string;

  async function buildWithProvider(next: MockSmsProvider) {
    const registry = new SmsProviderRegistry();
    registry.register(next, { enabled: true, settings: { apiKey: providerSecret } });
    await registry.initialize();
    return buildApp({ db, smsProviderRegistry: registry });
  }

  async function configureService(overrides: Record<string, unknown> = {}) {
    const providerResponse = await app.inject({
      method: 'POST', url: '/v1/admin/sms/providers', headers: adminHeaders,
      payload: { slug: 'mock-sms', name: 'Mock SMS', ...overrides },
    });
    smsProviderId = providerResponse.json().provider.id as string;
    const serviceResponse = await app.inject({
      method: 'POST', url: `/v1/admin/sms/providers/${smsProviderId}/services`, headers: adminHeaders,
      payload: {
        slug: 'otp_sms', name: 'OTP SMS', type: 'otp_sms', enabled: true,
        providerCostPerSmsUsd: '0.00400000', customerPricePerSmsUsd: '0.00500000',
        markupBps: 0, otpLength: 6, otpExpirySeconds: 300, maxMessageLength: 480, ...overrides,
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
    provider = new MockSmsProvider();
    app = await buildWithProvider(provider);
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name: 'SMS Store', email: 'sms@example.com', walletAddress: '0x5555555555555555555555555555555555555555' },
    });
    apiKey = merchant.json().apiKey as string;
    merchantId = merchant.json().merchant.id as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'sms-customer' },
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

  it('requires merchant authentication for every SMS endpoint', async () => {
    for (const request of [
      { method: 'GET', url: '/v1/sms/services' },
      { method: 'POST', url: '/v1/sms/send', payload: smsPayload() },
      { method: 'POST', url: '/v1/sms/otp', payload: otpPayload() },
    ]) {
      const anonymous = await app.inject(request as never);
      expect(anonymous.statusCode).toBe(401);
      const wrongKey = await app.inject({ ...request, headers: { authorization: 'Bearer not-a-key' } } as never);
      expect(wrongKey.statusCode).toBe(401);
    }
    expect(provider.smsCalls).toHaveLength(0);
  });

  it('lists enabled customer-facing services with pricing and no internal configuration', async () => {
    const services = await app.inject({ method: 'GET', url: '/v1/sms/services', headers: { authorization: `Bearer ${apiKey}` } });
    expect(services.statusCode).toBe(200);
    expect(services.json().services).toEqual([{
      service: 'otp_sms', name: 'OTP SMS', type: 'otp_sms', pricePerSmsUsd: '0.00500000',
      maxMessageLength: 480, providerConfigured: true, otpLength: 6, otpExpirySeconds: 300,
    }]);
    expect(services.body).not.toContain('mock-sms');
    expect(services.body).not.toContain(providerSecret);

    const disabled = await app.inject({
      method: 'PUT', url: `/v1/admin/sms/services/${smsServiceId}`, headers: adminHeaders,
      payload: { slug: 'otp_sms', name: 'OTP SMS', type: 'otp_sms', enabled: false,
        providerCostPerSmsUsd: '0.00400000', customerPricePerSmsUsd: '0.00500000' },
    });
    expect(disabled.statusCode).toBe(200);
    const afterDisable = await app.inject({ method: 'GET', url: '/v1/sms/services', headers: { authorization: `Bearer ${apiKey}` } });
    expect(afterDisable.json().services).toEqual([]);
  });

  it('sends an SMS, charges credits, records usage, ledger and webhooks', async () => {
    provider.options = { segments: 2, providerCostUsd: '0.00800000' };
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      request: {
        requestId: 'sms-request-0001', service: 'otp_sms', provider: 'mock-sms', kind: 'SMS',
        providerRequestId: 'sms-request-0001', providerMessageId: 'msg_sms-request-0001', status: 'sent',
      },
      usage: {
        units: 2, usageSource: 'provider', customerPriceUsd: '0.01000000',
        creditsDeducted: '1', balanceAfter: '99', currency: 'CREDITS',
      },
    });
    expect(response.body).not.toContain('providerCostUsd');
    expect(response.body).not.toContain('profitUsd');
    expect(provider.smsCalls).toEqual([{
      requestId: 'sms-request-0001', to: '+381601234567', message: 'Your package has shipped',
    }]);
    expect(await creditBalance(customerId)).toBe(parseUnits('99', 6).toString());

    const usage = await db.query<{
      kind: string; units: string; customer_price_usd: string; provider_cost_usd: string;
      profit_usd: string; credits_deducted_units: string;
    }>(
      `SELECT kind, units::text AS units, customer_price_usd::text AS customer_price_usd,
              provider_cost_usd::text AS provider_cost_usd, profit_usd::text AS profit_usd,
              credits_deducted_units::text AS credits_deducted_units
         FROM sms_usage_records WHERE request_id = 'sms-request-0001'`,
    );
    expect(Number(usage.rows[0].customer_price_usd)).toBeCloseTo(0.01, 8);
    expect(Number(usage.rows[0].provider_cost_usd)).toBeCloseTo(0.008, 8);
    expect(Number(usage.rows[0].profit_usd)).toBeCloseTo(0.002, 8);
    expect(usage.rows[0]).toMatchObject({ kind: 'SMS', units: '2', credits_deducted_units: '1000000' });

    const ledger = await db.query<{ entry_type: string; amount: string; currency: string }>(
      `SELECT entry_type, amount::text AS amount, currency FROM ledger_entries
        WHERE reference IN (SELECT id::text FROM credit_transactions WHERE idempotency_key = 'sms:sms-request-0001')`,
    );
    expect(ledger.rows).toEqual([{ entry_type: 'CREDIT_DEDUCTION', amount: '1', currency: 'CREDITS' }]);

    const request = await db.query<{ status: string; provider_request_id: string; provider_message_id: string }>(
      `SELECT status, provider_request_id, provider_message_id FROM sms_provider_requests
        WHERE request_id = 'sms-request-0001'`,
    );
    expect(request.rows[0]).toMatchObject({
      status: 'COMPLETED', provider_request_id: 'sms-request-0001', provider_message_id: 'msg_sms-request-0001',
    });
    const events = await db.query<{ event_type: string }>('SELECT event_type FROM webhook_events');
    expect(events.rows.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(['credit.deducted', 'sms.request.completed']),
    );
  });

  it('sends an OTP without ever exposing or storing the code', async () => {
    const appLogs: string[] = [];
    const originalError = app.log.error.bind(app.log);
    const originalInfo = app.log.info.bind(app.log);
    (app.log as { error: unknown }).error = (...args: unknown[]) => {
      appLogs.push(JSON.stringify(args));
      return originalError(...args as []);
    };
    (app.log as { info: unknown }).info = (...args: unknown[]) => {
      appLogs.push(JSON.stringify(args));
      return originalInfo(...args as []);
    };
    let response;
    try {
      response = await app.inject({
        method: 'POST', url: '/v1/sms/otp', headers: { authorization: `Bearer ${apiKey}` }, payload: otpPayload(),
      });
    } finally {
      (app.log as { error: unknown }).error = originalError;
      (app.log as { info: unknown }).info = originalInfo;
    }
    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({ kind: 'OTP', status: 'sent' });
    expect(response.json().usage).toMatchObject({ units: 1, usageSource: 'provider' });
    expect(response.body).not.toMatch(/"code"/i);

    // The provider received a six-digit code inside the rendered message.
    expect(provider.smsCalls).toHaveLength(1);
    const message = provider.smsCalls[0].message as string;
    expect(message).toMatch(/^Your verification code is \d{6}$/);
    const code = message.slice(-6);

    const rows = await db.query<{ resource_id: string; payload: string }>(
      'SELECT resource_id, payload::text AS payload FROM webhook_events',
    );
    for (const row of rows.rows) {
      expect(row.payload).not.toContain(code);
      expect(row.payload).not.toContain(message);
    }
    const stored = await db.query<{ failure_message: string | null }>(
      'SELECT failure_message FROM sms_provider_requests',
    );
    for (const row of stored.rows) expect(JSON.stringify(row)).not.toContain(code);
    expect(appLogs.join('')).not.toContain(code);
    expect(appLogs.join('')).not.toContain(message);
    expect(provider.otpCalls).toHaveLength(0);
  });

  it('uses native provider OTP delivery when the provider supports it', async () => {
    provider = new MockSmsProvider();
    provider.options = { nativeOtp: true };
    app = await buildWithProvider(provider);
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/otp', headers: { authorization: `Bearer ${apiKey}` }, payload: otpPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(provider.otpCalls).toEqual([{
      requestId: 'otp-request-0001', to: '+381601234567', codeLength: 6, expirySeconds: 300,
    }]);
    expect(provider.smsCalls).toHaveLength(0);
  });

  it('charges the estimated segments when the provider omits them', async () => {
    provider.options = { segmentsAuthoritative: false, providerCostUsd: null };
    const longMessage = 'x'.repeat(170);
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-estimate', message: longMessage }),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().usage).toMatchObject({
      units: estimateSmsSegments(longMessage), usageSource: 'estimated',
    });
    const stored = await db.query<{ usage_authoritative: boolean; units: string }>(
      'SELECT usage_authoritative, units::text AS units FROM sms_provider_requests WHERE request_id = $1',
      ['sms-request-estimate'],
    );
    expect(stored.rows[0]).toMatchObject({ usage_authoritative: false, units: '2' });
    const usage = await db.query<{ provider_cost_usd: string }>(
      'SELECT provider_cost_usd::text AS provider_cost_usd FROM sms_usage_records WHERE request_id = $1',
      ['sms-request-estimate'],
    );
    expect(Number(usage.rows[0].provider_cost_usd)).toBeCloseTo(0.008, 8);
  });

  it('never calls the provider when credits are insufficient and does not charge', async () => {
    await db.query('UPDATE credit_accounts SET balance_units = 1 WHERE customer_id = $1', [customerId]);
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('insufficient_credits');
    expect(provider.smsCalls).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe('1');
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(0);
    const requests = await db.query('SELECT id FROM sms_provider_requests');
    expect(requests.rows).toHaveLength(0);
  });

  it('refuses disabled services, disabled providers, and unknown services before calling the provider', async () => {
    const unknown = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ service: 'missing-service' }),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('sms_service_not_found');

    await app.inject({
      method: 'PUT', url: `/v1/admin/sms/services/${smsServiceId}`, headers: adminHeaders,
      payload: { slug: 'otp_sms', name: 'OTP SMS', type: 'otp_sms', enabled: false,
        providerCostPerSmsUsd: '0.00400000', customerPricePerSmsUsd: '0.00500000' },
    });
    const disabledService = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(disabledService.statusCode).toBe(404);
    expect(provider.smsCalls).toHaveLength(0);

    await app.inject({
      method: 'PUT', url: `/v1/admin/sms/services/${smsServiceId}`, headers: adminHeaders,
      payload: { slug: 'otp_sms', name: 'OTP SMS', type: 'otp_sms', enabled: true,
        providerCostPerSmsUsd: '0.00400000', customerPricePerSmsUsd: '0.00500000' },
    });
    await app.inject({
      method: 'PUT', url: `/v1/admin/sms/providers/${smsProviderId}`, headers: adminHeaders, payload: { enabled: false },
    });
    const disabledProvider = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(disabledProvider.statusCode).toBe(404);
    expect(provider.smsCalls).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());
  });

  it('maps an unconfigured runtime provider to a 503 without charging', async () => {
    provider.options = { configured: false };
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('sms_provider_unauthorized');
    expect(provider.smsCalls).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());
    const failed = await db.query<{ status: string; failure_kind: string }>(
      'SELECT status, failure_kind FROM sms_provider_requests',
    );
    expect(failed.rows[0]).toMatchObject({ status: 'FAILED', failure_kind: 'unauthorized' });
  });

  it('does not deduct credits when the provider times out', async () => {
    provider.options = {
      failure: new SmsProviderError('timeout', 'mock-sms', 'The SMS provider request timed out', true, 504),
    };
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ error: 'sms_provider_timeout', message: 'The SMS provider request timed out' });
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(0);
    const failed = await db.query<{ status: string; failure_kind: string; failure_message: string }>(
      'SELECT status, failure_kind, failure_message FROM sms_provider_requests',
    );
    expect(failed.rows[0]).toMatchObject({ status: 'FAILED', failure_kind: 'timeout' });
    expect(failed.rows[0].failure_message).not.toContain(providerSecret);
    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM webhook_events WHERE event_type = 'sms.request.failed'`,
    );
    expect(events.rows).toHaveLength(1);
  });

  it('normalizes provider errors without raw provider text or secrets', async () => {
    for (const [failure, expectedStatus, expectedError] of [
      [new SmsProviderError('rate_limited', 'mock-sms', 'The SMS provider is rate limiting this deployment', true, 503), 503, 'sms_provider_rate_limited'],
      [new SmsProviderError('invalid_response', 'mock-sms', 'upstream detail with sms-live-must-never-appear', false, 502), 502, 'sms_provider_invalid_response'],
      [new SmsProviderError('unavailable', 'mock-sms', 'The SMS provider is temporarily unavailable', true, 503), 503, 'sms_provider_unavailable'],
    ] as const) {
      provider.options = { failure };
      const response = await app.inject({
        method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
        payload: smsPayload({ requestId: `sms-request-${expectedError}` }),
      });
      expect(response.statusCode).toBe(expectedStatus);
      expect(response.json().error).toBe(expectedError);
      expect(response.body).not.toContain(providerSecret);
      expect(response.body).not.toContain('upstream detail');
    }
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(0);
  });

  it('rejects duplicate and concurrent requests without double billing', async () => {
    const first = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(first.statusCode).toBe(201);
    const balanceAfterFirst = await creditBalance(customerId);

    const duplicate = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe('sms_request_conflict');
    expect(provider.smsCalls).toHaveLength(1);
    expect(await creditBalance(customerId)).toBe(balanceAfterFirst);
    const usage = await db.query('SELECT id FROM sms_usage_records');
    expect(usage.rows).toHaveLength(1);

    await db.query('UPDATE credit_accounts SET balance_units = $1 WHERE customer_id = $2',
      [parseUnits('0.5', 6).toString(), customerId]);
    const [concurrentA, concurrentB] = await Promise.all([
      app.inject({
        method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
        payload: smsPayload({ requestId: 'sms-request-concurrent-1' }),
      }),
      app.inject({
        method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
        payload: smsPayload({ requestId: 'sms-request-concurrent-2' }),
      }),
    ]);
    // The balance covers exactly one 0.5-credit charge, so only one request settles
    // and the same balance cannot be spent twice.
    expect([concurrentA.statusCode, concurrentB.statusCode].sort()).toEqual([201, 409]);
    expect(provider.smsCalls).toHaveLength(3);
    const allUsage = await db.query('SELECT id FROM sms_usage_records');
    expect(allUsage.rows).toHaveLength(2);
    expect(await creditBalance(customerId)).toBe('0');
  });

  it('rejects invalid payloads and oversized messages before calling the provider', async () => {
    const badDestination = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-bad-to', to: '601234567' }),
    });
    expect(badDestination.statusCode).toBe(400);
    const badService = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-bad-slug', service: 'Not A Slug' }),
    });
    expect(badService.statusCode).toBe(400);
    const oversized = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-oversized', message: 'x'.repeat(481) }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error).toBe('sms_message_too_long');
    const foreignCustomer = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-foreign', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    });
    expect(foreignCustomer.statusCode).toBe(404);
    expect(provider.smsCalls).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());
  });

  it('bills the merchant own account when no customer is specified', async () => {
    await db.query(
      `INSERT INTO customers (id, merchant_id, external_id, name, metadata)
       VALUES ($1, $2, 'merchant-self', 'Merchant SMS account', '{"purpose":"merchant_self_billing"}'::jsonb)`,
      ['ffffffff-ffff-4fff-8fff-ffffffffffff', merchantId],
    );
    await db.query(
      `INSERT INTO credit_accounts (id, merchant_id, customer_id, balance_units)
       VALUES ($1, $2, $3, $4)`,
      ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', merchantId,
        'ffffffff-ffff-4fff-8fff-ffffffffffff', parseUnits('1', 6).toString()],
    );
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: { requestId: 'sms-request-merchant', service: 'otp_sms', to: '+381601234567', message: 'Hello' },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().usage).toMatchObject({ creditsDeducted: '0.5', balanceAfter: '0.5' });
    const merchantAccount = await db.query<{ balance_units: string }>(
      `SELECT balance_units::text AS balance_units FROM credit_accounts
        WHERE merchant_id = $1 AND customer_id = $2`,
      [merchantId, 'ffffffff-ffff-4fff-8fff-ffffffffffff'],
    );
    expect(merchantAccount.rows[0].balance_units).toBe(parseUnits('0.5', 6).toString());
    // The named customer keeps its full balance.
    expect(await creditBalance(customerId)).toBe(parseUnits('100', 6).toString());
  });

  it('exposes admin provider health, services, and request trails without secrets', async () => {
    await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` }, payload: smsPayload(),
    });
    const surfaces = [
      { url: '/v1/admin/sms/providers', headers: adminHeaders },
      { url: '/v1/admin/sms/services', headers: adminHeaders },
      { url: '/v1/admin/sms/requests', headers: adminHeaders },
      { url: '/v1/admin/sms/usage', headers: adminHeaders },
    ];
    for (const surface of surfaces) {
      const response = await app.inject({ method: 'GET', url: surface.url, headers: surface.headers });
      expect(response.statusCode, `${surface.url}: ${response.body}`).toBe(200);
      expect(response.body, surface.url).not.toContain(providerSecret);
      expect(response.body, surface.url).not.toContain('Bearer ');
      expect(response.body, surface.url).not.toContain('Your package has shipped');
    }
    const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/sms/providers' });
    expect(anonymous.statusCode).toBe(401);

    const health = await app.inject({
      method: 'POST', url: `/v1/admin/sms/providers/${smsProviderId}/health`, headers: adminHeaders,
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      provider: { slug: 'mock-sms', enabled: true }, health: { status: 'healthy' },
    });
    const providers = await app.inject({ method: 'GET', url: '/v1/admin/sms/providers', headers: adminHeaders });
    expect(providers.json().providers[0]).toMatchObject({
      slug: 'mock-sms', integration: 'http-sms', credentialSource: 'environment',
      installed: true, configured: true, lastStatus: 'healthy',
    });
    expect(providers.json().integrations[0].capabilities).toMatchObject({ sendSms: true });
    const requests = await app.inject({ method: 'GET', url: '/v1/admin/sms/requests', headers: adminHeaders });
    expect(requests.json().requests[0]).toMatchObject({
      requestId: 'sms-request-0001', kind: 'SMS', status: 'COMPLETED', service: 'otp_sms', provider: 'mock-sms',
    });
    expect(requests.json().requests[0]).not.toHaveProperty('message');
    const usage = await app.inject({ method: 'GET', url: '/v1/admin/sms/usage', headers: adminHeaders });
    expect(usage.json().usage[0]).toMatchObject({ requestId: 'sms-request-0001', service: 'otp_sms' });
    expect(Number(usage.json().usage[0].providerCostUsd)).toBeCloseTo(0.004, 8);
    expect(Number(usage.json().usage[0].profitUsd)).toBeCloseTo(0.001, 8);

    // No column anywhere in the SMS integration may hold credential material, and the
    // request/usage tables may not hold message content or OTP codes. `credential_source`
    // is a non-secret marker recording that the key comes from the environment.
    const credentialColumns = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('sms_providers', 'sms_services', 'sms_provider_requests', 'sms_usage_records')
          AND (column_name ILIKE '%api_key%' OR column_name ILIKE '%secret%' OR column_name ILIKE '%password%'
               OR column_name ILIKE '%cipher%' OR column_name ILIKE '%bearer%' OR column_name ILIKE '%token%'
               OR column_name ILIKE '%access_key%'
               OR (column_name ILIKE '%credential%' AND column_name <> 'credential_source'))`,
    );
    expect(credentialColumns.rows).toEqual([]);
    const contentColumns = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('sms_provider_requests', 'sms_usage_records')
          AND (column_name ILIKE '%body%' OR column_name ILIKE '%content%' OR column_name ILIKE '%prompt%'
               OR column_name ILIKE '%text%' OR column_name ILIKE '%otp%' OR column_name ILIKE '%code%')`,
    );
    expect(contentColumns.rows).toEqual([]);
  });

  it('applies a stricter per-route rate limit to OTP delivery', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1) {
      const response = await app.inject({
        method: 'POST', url: '/v1/sms/otp', headers: { authorization: `Bearer ${apiKey}` },
        payload: otpPayload({ requestId: `otp-request-rate-${index}` }),
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.filter((status) => status === 201)).toHaveLength(30);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    expect(provider.smsCalls).toHaveLength(30);
  }, 30_000);

  it('rejects a zero-priced service configuration at charge time', async () => {
    await app.inject({
      method: 'PUT', url: `/v1/admin/sms/services/${smsServiceId}`, headers: adminHeaders,
      payload: { slug: 'otp_sms', name: 'OTP SMS', type: 'otp_sms', enabled: true,
        providerCostPerSmsUsd: '0', customerPricePerSmsUsd: null, markupBps: 0 },
    });
    const response = await app.inject({
      method: 'POST', url: '/v1/sms/send', headers: { authorization: `Bearer ${apiKey}` },
      payload: smsPayload({ requestId: 'sms-request-zero' }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('zero_sms_usage_price');
    expect(provider.smsCalls).toHaveLength(0);
  });
});
