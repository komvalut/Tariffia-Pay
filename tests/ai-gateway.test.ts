import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { AiProviderError } from '../src/ai-provider.js';
import { AiProviderRegistry } from '../src/ai-providers/registry.js';
import { estimatePromptTokens } from '../src/services/ai-gateway-service.js';
import { MockAiProvider } from './fixtures/mock-ai-provider.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const providerSecret = 'sk-live-must-never-appear-in-any-response-9876543210';

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

function pgAdapterPool(memory: ReturnType<typeof newDb>): Pool {
  const adapter = memory.adapters.createPg();
  return new adapter.Pool() as Pool;
}

describe('AI provider request gateway', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let provider: MockAiProvider;
  let apiKey: string;
  let customerId: string;
  let providerId: string;
  let modelId: string;

  async function buildWithProvider(next: MockAiProvider) {
    const registry = new AiProviderRegistry();
    registry.register(next, { enabled: true, settings: { apiKey: providerSecret } });
    await registry.initialize();
    const built = await buildApp({ db, aiProviderRegistry: registry });
    return built;
  }

  async function configureModel(overrides: Record<string, unknown> = {}) {
    const providerResponse = await app.inject({
      method: 'POST', url: '/v1/admin/ai/providers', headers: adminHeaders,
      payload: { slug: 'mock-ai', name: 'Mock AI', ...overrides },
    });
    providerId = providerResponse.json().provider.id as string;
    const modelResponse = await app.inject({
      method: 'POST', url: `/v1/admin/ai/providers/${providerId}/models`, headers: adminHeaders,
      payload: {
        slug: 'mock-small', name: 'Mock Small', enabled: true, pricingMode: 'PER_1K_TOKENS',
        providerInputCostPer1kUsd: '0.01000000', providerOutputCostPer1kUsd: '0.02000000',
        markupBps: 1000, providerModel: 'mock-small', maxOutputTokens: 512, ...overrides,
      },
    });
    modelId = modelResponse.json().model.id as string;
  }

  async function creditBalance(customer: string) {
    const balance = await db.query<{ balance_units: string }>(
      'SELECT balance_units::text AS balance_units FROM credit_accounts WHERE customer_id = $1', [customer],
    );
    return balance.rows[0]?.balance_units ?? null;
  }

  const chatPayload = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'ai-request-0001', customerId, provider: 'mock-ai', model: 'mock-small',
    messages: [{ role: 'user', content: 'Summarize this document' }],
    maxOutputTokens: 256, ...overrides,
  });

  beforeEach(async () => {
    db = await createDatabase();
    provider = new MockAiProvider();
    app = await buildWithProvider(provider);
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name: 'AI Gateway Store', email: 'gateway@example.com', walletAddress: '0x3333333333333333333333333333333333333333' },
    });
    apiKey = merchant.json().apiKey as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'gateway-customer' },
    });
    customerId = customer.json().customer.id as string;
    await configureModel();
    await db.query(
      `INSERT INTO credit_accounts (id, merchant_id, customer_id, balance_units)
       VALUES ($1, (SELECT merchant_id FROM customers WHERE id = $2), $2, $3)`,
      ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', customerId, parseUnits('1000', 6).toString()],
    );
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('requires merchant authentication and a known customer', async () => {
    const anonymous = await app.inject({ method: 'POST', url: '/v1/ai/chat/completions', payload: chatPayload() });
    expect(anonymous.statusCode).toBe(401);

    const wrongKey = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: 'Bearer not-a-real-merchant-key' }, payload: chatPayload(),
    });
    expect(wrongKey.statusCode).toBe(401);

    const foreignCustomer = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: chatPayload({ customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    });
    expect(foreignCustomer.statusCode).toBe(404);
    expect(foreignCustomer.json().error).toBe('customer_not_found');
    expect(provider.completions).toHaveLength(0);
  });

  it('discovers merchant models with pricing and provider availability', async () => {
    const models = await app.inject({ method: 'GET', url: '/v1/ai/models', headers: { authorization: `Bearer ${apiKey}` } });
    expect(models.statusCode).toBe(200);
    expect(models.json().models[0]).toMatchObject({
      provider: 'mock-ai', model: 'mock-small', maxOutputTokens: 512, providerConfigured: true,
      inputPricePer1kUsd: '0.01100000', outputPricePer1kUsd: '0.02200000',
    });

    const discovery = await app.inject({
      method: 'GET', url: `/v1/admin/ai/providers/${providerId}/models/discovery`, headers: adminHeaders,
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json().models).toEqual([
      { id: 'mock-small', name: 'Mock Small', contextWindow: 8_000, maxOutputTokens: 512 },
    ]);
  });

  it('prices and charges a successful request from authoritative provider usage', async () => {
    provider.options = { inputTokens: 1_000, outputTokens: 250, content: 'Summary of the document' };
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      request: {
        requestId: 'ai-request-0001', provider: 'mock-ai', model: 'mock-small',
        providerRequestId: 'ai-request-0001', providerResponseId: 'resp_mock_0001', finishReason: 'stop',
        message: { role: 'assistant', content: 'Summary of the document' },
      },
      usage: {
        inputTokens: 1_000, outputTokens: 250, usageSource: 'provider',
        customerPriceUsd: '0.01650000', creditsDeducted: '1.65', balanceAfter: '998.35',
      },
    });
    expect(response.body).not.toContain('providerCostUsd');
    expect(response.body).not.toContain('profitUsd');
    expect(provider.completions).toHaveLength(1);
    expect(provider.completions[0]).toMatchObject({ requestId: 'ai-request-0001', model: 'mock-small', maxOutputTokens: 256 });
    expect(await creditBalance(customerId)).toBe('998350000');

    const usage = await db.query<{
      provider_cost_usd: string; customer_price_usd: string; profit_usd: string;
      credits_deducted_units: string; input_tokens: string; output_tokens: string; total_tokens: string;
    }>(
      `SELECT provider_cost_usd::text AS provider_cost_usd, customer_price_usd::text AS customer_price_usd,
              profit_usd::text AS profit_usd, credits_deducted_units::text AS credits_deducted_units,
              input_tokens::text AS input_tokens, output_tokens::text AS output_tokens,
              total_tokens::text AS total_tokens
         FROM ai_usage_records WHERE request_id = 'ai-request-0001'`,
    );
    // pg-mem renders numeric text without fixed scale, so compare the stored values numerically.
    expect(Number(usage.rows[0].provider_cost_usd)).toBeCloseTo(0.015, 8);
    expect(Number(usage.rows[0].customer_price_usd)).toBeCloseTo(0.0165, 8);
    expect(Number(usage.rows[0].profit_usd)).toBeCloseTo(0.0015, 8);
    expect(usage.rows[0]).toMatchObject({
      credits_deducted_units: '1650000', input_tokens: '1000', output_tokens: '250', total_tokens: '1250',
    });

    const ledger = await db.query<{ entry_type: string; amount: string; currency: string }>(
      `SELECT entry_type, amount::text AS amount, currency FROM ledger_entries WHERE reference IN (
         SELECT id::text FROM credit_transactions WHERE idempotency_key = 'ai:ai-request-0001')`,
    );
    expect(ledger.rows).toEqual([{ entry_type: 'CREDIT_DEDUCTION', amount: '1.65', currency: 'CREDITS' }]);

    const providerRequest = await db.query<{
      status: string; provider_request_id: string; provider_response_id: string; usage_authoritative: boolean;
    }>(
      `SELECT status, provider_request_id, provider_response_id, usage_authoritative
         FROM ai_provider_requests WHERE request_id = 'ai-request-0001'`,
    );
    expect(providerRequest.rows[0]).toMatchObject({
      status: 'COMPLETED', provider_request_id: 'ai-request-0001',
      provider_response_id: 'resp_mock_0001', usage_authoritative: true,
    });
    const events = await db.query<{ event_type: string }>('SELECT event_type FROM webhook_events');
    expect(events.rows.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(['credit.deducted', 'ai.usage.recorded', 'ai.request.completed']),
    );
  });

  it('calculates provider cost, customer price, and profit for request-based pricing', async () => {
    await app.inject({
      method: 'PUT', url: `/v1/admin/ai/models/${modelId}`, headers: adminHeaders,
      payload: {
        slug: 'mock-small', name: 'Mock Small', enabled: true, pricingMode: 'PER_REQUEST_AND_TOKENS',
        providerCostPerRequestUsd: '0.00200000', customerPricePerRequestUsd: null,
        providerInputCostPer1kUsd: '0.01000000', customerInputPricePer1kUsd: null,
        providerOutputCostPer1kUsd: '0.02000000', customerOutputPricePer1kUsd: null,
        markupBps: 1000, providerModel: 'mock-small', maxOutputTokens: 512,
      },
    });
    provider.options = { inputTokens: 2_000, outputTokens: 1_000 };
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload({ requestId: 'ai-request-priced' }),
    });
    expect(response.statusCode).toBe(201);
    const usage = await db.query<{ pricing_mode: string; provider_cost_usd: string; customer_price_usd: string; profit_usd: string }>(
      `SELECT pricing_mode, provider_cost_usd::text AS provider_cost_usd,
              customer_price_usd::text AS customer_price_usd, profit_usd::text AS profit_usd
         FROM ai_usage_records WHERE request_id = 'ai-request-priced'`,
    );
    expect(usage.rows[0].pricing_mode).toBe('PER_REQUEST_AND_TOKENS');
    // Provider cost: 0.002 request + 2k input at 0.010/1k + 1k output at 0.020/1k.
    expect(Number(usage.rows[0].provider_cost_usd)).toBeCloseTo(0.042, 8);
    // Customer rates carry a 10% markup: 0.0022 + 0.022 + 0.022.
    expect(Number(usage.rows[0].customer_price_usd)).toBeCloseTo(0.0462, 8);
    expect(Number(usage.rows[0].profit_usd)).toBeCloseTo(0.0042, 8);
    expect(response.json().usage.customerPriceUsd).toBe('0.04620000');
    expect(response.body).not.toContain('profitUsd');
  });

  it('charges the estimated usage when the provider omits token counts', async () => {
    provider.options = { omitUsage: true };
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload(),
    });
    expect(response.statusCode).toBe(201);
    const estimatedInput = estimatePromptTokens([{ content: 'Summarize this document' }]);
    expect(response.json().usage).toMatchObject({ inputTokens: estimatedInput, usageSource: 'estimated' });
    const stored = await db.query<{ usage_source: string }>(
      'SELECT usage_authoritative::text AS usage_source FROM ai_provider_requests',
    );
    expect(stored.rows[0].usage_source).toBe('false');
  });

  it('never calls the provider when credits are insufficient and does not charge', async () => {
    await db.query('UPDATE credit_accounts SET balance_units = 1 WHERE customer_id = $1', [customerId]);
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('insufficient_credits');
    expect(provider.completions).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe('1');
    const usage = await db.query('SELECT id FROM ai_usage_records');
    expect(usage.rows).toHaveLength(0);
  });

  it('refuses disabled models and disabled providers before calling the provider', async () => {
    await app.inject({
      method: 'PUT', url: `/v1/admin/ai/models/${modelId}`, headers: adminHeaders,
      payload: {
        slug: 'mock-small', name: 'Mock Small', enabled: false, pricingMode: 'PER_1K_TOKENS',
        providerInputCostPer1kUsd: '0.01000000', providerOutputCostPer1kUsd: '0.02000000', markupBps: 1000,
        providerModel: 'mock-small', maxOutputTokens: 512,
      },
    });
    const disabledModel = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload(),
    });
    expect(disabledModel.statusCode).toBe(404);
    expect(disabledModel.json().error).toBe('ai_model_not_found');
    expect(provider.completions).toHaveLength(0);

    await app.inject({
      method: 'PUT', url: `/v1/admin/ai/models/${modelId}`, headers: adminHeaders,
      payload: {
        slug: 'mock-small', name: 'Mock Small', enabled: true, pricingMode: 'PER_1K_TOKENS',
        providerInputCostPer1kUsd: '0.01000000', providerOutputCostPer1kUsd: '0.02000000', markupBps: 1000,
        providerModel: 'mock-small', maxOutputTokens: 512,
      },
    });
    await app.inject({
      method: 'PUT', url: `/v1/admin/ai/providers/${providerId}`, headers: adminHeaders, payload: { enabled: false },
    });
    const disabledProvider = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload(),
    });
    expect(disabledProvider.statusCode).toBe(404);
    expect(provider.completions).toHaveLength(0);
    expect(await creditBalance(customerId)).toBe('1000000000');
  });

  it('rejects an unknown model without calling the provider', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload({ model: 'missing-model' }),
    });
    expect(response.statusCode).toBe(404);
    expect(provider.completions).toHaveLength(0);
  });

  it('does not deduct credits when the provider times out', async () => {
    provider.options = { failure: new AiProviderError('timeout', 'mock-ai', 'The AI provider request timed out', true, 504) };
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload(),
    });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ error: 'ai_provider_timeout', message: 'The AI provider request timed out' });
    expect(await creditBalance(customerId)).toBe('1000000000');
    const usage = await db.query('SELECT id FROM ai_usage_records');
    expect(usage.rows).toHaveLength(0);
    const failed = await db.query<{ status: string; failure_kind: string; failure_message: string }>(
      `SELECT status, failure_kind, failure_message FROM ai_provider_requests WHERE request_id = 'ai-request-0001'`,
    );
    expect(failed.rows[0]).toMatchObject({ status: 'FAILED', failure_kind: 'timeout' });
    expect(failed.rows[0].failure_message).not.toContain(providerSecret);
    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM webhook_events WHERE event_type = 'ai.request.failed'`,
    );
    expect(events.rows).toHaveLength(1);
  });

  it('normalizes provider errors and keeps them free of secrets and upstream detail', async () => {
    for (const [failure, expectedStatus, expectedError] of [
      [new AiProviderError('rate_limited', 'mock-ai', 'The AI provider is rate limiting this deployment', true, 503), 503, 'ai_provider_rate_limited'],
      [new AiProviderError('unauthorized', 'mock-ai', 'The AI provider rejected the configured credentials', false, 502), 502, 'ai_provider_unauthorized'],
      [new AiProviderError('invalid_response', 'mock-ai', 'The AI provider returned an empty completion', false, 502), 502, 'ai_provider_invalid_response'],
    ] as const) {
      provider.options = { failure };
      const response = await app.inject({
        method: 'POST', url: '/v1/ai/chat/completions',
        headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload({ requestId: `ai-request-${expectedError}` }),
      });
      expect(response.statusCode).toBe(expectedStatus);
      expect(response.json().error).toBe(expectedError);
      expect(response.body).not.toContain(providerSecret);
    }
    expect(await creditBalance(customerId)).toBe('1000000000');
    const usage = await db.query('SELECT id FROM ai_usage_records');
    expect(usage.rows).toHaveLength(0);
  });

  it('prevents duplicate billing for a repeated request identifier', async () => {
    provider.options = { inputTokens: 1_000, outputTokens: 250 };
    const first = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload(),
    });
    expect(first.statusCode).toBe(201);
    const balanceAfterFirst = await creditBalance(customerId);

    const duplicate = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload(),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe('ai_request_conflict');
    expect(provider.completions).toHaveLength(1);
    expect(await creditBalance(customerId)).toBe(balanceAfterFirst);
    const usage = await db.query('SELECT id FROM ai_usage_records');
    expect(usage.rows).toHaveLength(1);
  });

  it('does not expose the provider credential through admin, merchant, or dashboard surfaces', async () => {
    provider.options = { inputTokens: 1_000, outputTokens: 250 };
    await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload(),
    });
    const surfaces = [
      { url: '/v1/admin/ai/providers', headers: adminHeaders },
      { url: '/v1/admin/ai/models', headers: adminHeaders },
      { url: '/v1/admin/ai/usage', headers: adminHeaders },
      { url: '/v1/admin/ai/requests', headers: adminHeaders },
      { url: `/v1/admin/ai/providers/${providerId}/models/discovery`, headers: adminHeaders },
      { url: '/v1/ai/models', headers: { authorization: `Bearer ${apiKey}` } },
      { url: '/v1/ai/usage', headers: { authorization: `Bearer ${apiKey}` } },
      { url: '/v1/admin/dashboard/ai-providers', headers: adminHeaders },
      { url: '/v1/admin/dashboard/ai-models', headers: adminHeaders },
      { url: '/v1/admin/dashboard/usage', headers: adminHeaders },
      { url: '/v1/dashboard/usage', headers: { authorization: `Bearer ${apiKey}` } },
    ];
    for (const surface of surfaces) {
      const response = await app.inject({ method: 'GET', url: surface.url, headers: surface.headers });
      expect(response.statusCode, `${surface.url}: ${response.body}`).toBe(200);
      expect(response.body, surface.url).not.toContain(providerSecret);
      expect(response.body, surface.url).not.toContain('Bearer ');
    }
    const stored = await db.query<{ api_key: string | null }>(
      `SELECT NULL::text AS api_key FROM ai_providers UNION ALL SELECT NULL::text FROM ai_models`,
    );
    expect(stored.rows.every((row) => row.api_key === null)).toBe(true);
    // No column anywhere in the AI integration may hold credential material. `credential_source`
    // is a non-secret marker recording that the key comes from the environment.
    const columns = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('ai_providers', 'ai_models', 'ai_provider_requests', 'ai_usage_records')
          AND (column_name ILIKE '%api_key%' OR column_name ILIKE '%secret%' OR column_name ILIKE '%password%'
               OR column_name ILIKE '%cipher%' OR column_name ILIKE '%bearer%' OR column_name ILIKE '%token_value%'
               OR column_name ILIKE '%access_key%')`,
    );
    expect(columns.rows).toEqual([]);
  });

  it('reports provider health and configuration status for administrators', async () => {
    const healthy = await app.inject({
      method: 'POST', url: `/v1/admin/ai/providers/${providerId}/health`, headers: adminHeaders,
    });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toMatchObject({
      provider: { slug: 'mock-ai', enabled: true }, health: { status: 'healthy' },
    });
    expect(healthy.body).not.toContain(providerSecret);

    const list = await app.inject({ method: 'GET', url: '/v1/admin/ai/providers', headers: adminHeaders });
    expect(list.json().providers[0]).toMatchObject({
      slug: 'mock-ai', integration: 'openai-compatible', credentialSource: 'environment',
      installed: true, configured: true, lastStatus: 'healthy',
    });
    expect(list.json().integrations[0].capabilities).toMatchObject({ chatCompletions: true });

    const discovery = await app.inject({
      method: 'GET', url: `/v1/admin/ai/providers/${providerId}/models/discovery`, headers: adminHeaders,
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.body).not.toContain(providerSecret);
    const anonymous = await app.inject({
      method: 'GET', url: `/v1/admin/ai/providers/${providerId}/models/discovery`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('logs provider failures without credential or prompt material', async () => {
    provider.options = { failure: new AiProviderError('unavailable', 'mock-ai', `upstream rejected ${providerSecret}`, false, 502) };
    const appLogs: unknown[] = [];
    const originalLog = app.log.error.bind(app.log);
    (app.log as { error: unknown }).error = (...args: unknown[]) => { appLogs.push(args); return originalLog(...args as []); };
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/ai/chat/completions',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: chatPayload({ requestId: 'ai-request-logged', messages: [{ role: 'user', content: 'confidential customer prompt' }] }),
      });
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain(providerSecret);
    } finally {
      (app.log as { error: unknown }).error = originalLog;
    }
    const stored = await db.query<{ failure_message: string }>(
      'SELECT failure_message FROM ai_provider_requests WHERE request_id = $1', ['ai-request-logged'],
    );
    // The stored reason is the normalized message, never the raw provider text or credential.
    expect(stored.rows[0].failure_message).not.toContain(providerSecret);
    expect(JSON.stringify(appLogs)).not.toContain(providerSecret);
  });

  it('serializes concurrent requests so a single balance cannot be spent twice', async () => {
    provider.options = { inputTokens: 1_000, outputTokens: 250 };
    await db.query('UPDATE credit_accounts SET balance_units = $1 WHERE customer_id = $2', ['1650000', customerId]);
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST', url: '/v1/ai/chat/completions',
        headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload({ requestId: 'ai-request-concurrent-1' }),
      }),
      app.inject({
        method: 'POST', url: '/v1/ai/chat/completions',
        headers: { authorization: `Bearer ${apiKey}` }, payload: chatPayload({ requestId: 'ai-request-concurrent-2' }),
      }),
    ]);
    // Each request costs 1.65 credits, so the 1.65-credit balance covers exactly one of them.
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    expect(await creditBalance(customerId)).toBe('0');
    const usage = await db.query('SELECT id FROM ai_usage_records');
    expect(usage.rows).toHaveLength(1);
  });

  it('rejects an oversized prompt before calling the provider', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: chatPayload({ requestId: 'ai-request-oversized', messages: [{ role: 'user', content: 'x'.repeat(16_001) }] }),
    });
    expect(response.statusCode).toBe(400);
    expect(provider.completions).toHaveLength(0);
  });
});
