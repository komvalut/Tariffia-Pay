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
import type { AiGatewayStreamEvent } from '../src/services/ai-gateway-service.js';
import { estimatePromptTokens } from '../src/services/ai-gateway-service.js';
import { MockAiProvider } from './fixtures/mock-ai-provider.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const providerSecret = 'sk-live-must-never-appear-in-any-response-9876543210';

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

function parseSseEvents(body: string): AiGatewayStreamEvent[] {
  return body.split('\n\n')
    .filter((frame) => frame.trim())
    .map((frame) => JSON.parse(frame.replace(/^data: /, '')) as AiGatewayStreamEvent);
}

describe('AI streaming and tool-call gateway', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let provider: MockAiProvider;
  let apiKey: string;
  let merchantId: string;
  let customerId: string;

  async function buildWithProvider(next: MockAiProvider) {
    const registry = new AiProviderRegistry();
    registry.register(next, { enabled: true, settings: { apiKey: providerSecret } });
    await registry.initialize();
    return buildApp({ db, aiProviderRegistry: registry });
  }

  async function creditBalance(customer: string) {
    const balance = await db.query<{ balance_units: string }>(
      'SELECT balance_units::text AS balance_units FROM credit_accounts WHERE customer_id = $1', [customer],
    );
    return balance.rows[0]?.balance_units ?? null;
  }

  const streamPayload = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'stream-request-0001', customerId, provider: 'mock-ai', model: 'mock-small',
    messages: [{ role: 'user', content: 'Count to three' }],
    maxOutputTokens: 128, ...overrides,
  });

  const tools = [{
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }];

  beforeEach(async () => {
    db = await createDatabase();
    provider = new MockAiProvider();
    app = await buildWithProvider(provider);
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name: 'Stream Store', email: 'stream@example.com', walletAddress: '0x6666666666666666666666666666666666666666' },
    });
    apiKey = merchant.json().apiKey as string;
    merchantId = merchant.json().merchant.id as string;
    const customer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalId: 'stream-customer' },
    });
    customerId = customer.json().customer.id as string;
    const aiProvider = await app.inject({
      method: 'POST', url: '/v1/admin/ai/providers', headers: adminHeaders, payload: { slug: 'mock-ai', name: 'Mock AI' },
    });
    const providerId = aiProvider.json().provider.id as string;
    const model = await app.inject({
      method: 'POST', url: `/v1/admin/ai/providers/${providerId}/models`, headers: adminHeaders,
      payload: {
        slug: 'mock-small', name: 'Mock Small', enabled: true, pricingMode: 'PER_1K_TOKENS',
        providerInputCostPer1kUsd: '0.01000000', providerOutputCostPer1kUsd: '0.02000000', markupBps: 1000,
        providerModel: 'mock-small', maxOutputTokens: 512,
      },
    });
    expect(model.statusCode, model.body).toBe(201);
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

  it('streams chunks and settles authoritative usage in a final done event', async () => {
    provider.options = {
      streamChunks: ['One ', 'two ', 'three.'],
      inputTokens: 10, outputTokens: 20, finishReason: 'stop', content: 'unused',
    };
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: streamPayload(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseSseEvents(response.body);
    expect(events.slice(0, 3)).toEqual([
      { type: 'chunk', content: 'One ' },
      { type: 'chunk', content: 'two ' },
      { type: 'chunk', content: 'three.' },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      request: {
        requestId: 'stream-request-0001', provider: 'mock-ai', model: 'mock-small',
        finishReason: 'stop', toolCallCount: 0, chargeCapped: false,
        providerResponseId: 'resp_mock_stream_0001',
      },
      usage: {
        inputTokens: 10, outputTokens: 20, usageSource: 'provider',
        customerPriceUsd: '0.00055000', creditsDeducted: '0.055', balanceAfter: '999.945',
      },
    });
    expect(response.body).not.toContain('providerCostUsd');
    expect(response.body).not.toContain('profitUsd');

    const requestRow = await db.query<{ status: string; provider_response_id: string; usage_authoritative: boolean }>(
      `SELECT status, provider_response_id, usage_authoritative FROM ai_provider_requests
        WHERE request_id = 'stream-request-0001'`,
    );
    expect(requestRow.rows[0]).toMatchObject({
      status: 'COMPLETED', provider_response_id: 'resp_mock_stream_0001', usage_authoritative: true,
    });
    const usage = await db.query<{ input_tokens: string; output_tokens: string; credits_deducted_units: string }>(
      `SELECT input_tokens::text AS input_tokens, output_tokens::text AS output_tokens,
              credits_deducted_units::text AS credits_deducted_units
         FROM ai_usage_records WHERE request_id = 'stream-request-0001'`,
    );
    expect(usage.rows[0]).toMatchObject({
      input_tokens: '10', output_tokens: '20', credits_deducted_units: '55000',
    });
    const ledger = await db.query<{ entry_type: string; amount: string; currency: string }>(
      `SELECT entry_type, amount::text AS amount, currency FROM ledger_entries
        WHERE reference IN (SELECT id::text FROM credit_transactions WHERE idempotency_key = 'ai:stream-request-0001')`,
    );
    expect(ledger.rows).toEqual([{ entry_type: 'CREDIT_DEDUCTION', amount: '0.055', currency: 'CREDITS' }]);
    expect(await creditBalance(customerId)).toBe(parseUnits('999.945', 6).toString());
    const events2 = await db.query<{ event_type: string }>('SELECT event_type FROM webhook_events');
    expect(events2.rows.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(['credit.deducted', 'ai.usage.recorded', 'ai.request.completed']),
    );
  });

  it('requires merchant authentication and rejects unknown customers before streaming', async () => {
    const anonymous = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream', payload: streamPayload(),
    });
    expect(anonymous.statusCode).toBe(401);
    const wrongKey = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream',
      headers: { authorization: 'Bearer not-a-key' }, payload: streamPayload(),
    });
    expect(wrongKey.statusCode).toBe(401);
    const foreign = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: streamPayload({ customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    });
    expect(foreign.statusCode).toBe(404);
    expect(provider.streamRequests).toHaveLength(0);
  });

  it('never starts a stream when credits are insufficient or the request is duplicated', async () => {
    await db.query('UPDATE credit_accounts SET balance_units = 1 WHERE customer_id = $1', [customerId]);
    const insufficient = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream',
      headers: { authorization: `Bearer ${apiKey}` }, payload: streamPayload(),
    });
    expect(insufficient.statusCode).toBe(409);
    expect(insufficient.json().error).toBe('insufficient_credits');
    expect(provider.streamRequests).toHaveLength(0);

    await db.query('UPDATE credit_accounts SET balance_units = $1 WHERE customer_id = $2',
      [parseUnits('1000', 6).toString(), customerId]);
    provider.options = { streamChunks: ['ok'], inputTokens: 400, outputTokens: 100 };
    const first = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream',
      headers: { authorization: `Bearer ${apiKey}` }, payload: streamPayload(),
    });
    expect(first.statusCode).toBe(200);
    expect(parseSseEvents(first.body).at(-1)?.type).toBe('done');
    const balanceAfterFirst = await creditBalance(customerId);

    const duplicate = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream',
      headers: { authorization: `Bearer ${apiKey}` }, payload: streamPayload(),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe('ai_request_conflict');
    expect(provider.streamRequests).toHaveLength(1);
    expect(await creditBalance(customerId)).toBe(balanceAfterFirst);
    const usage = await db.query('SELECT id FROM ai_usage_records');
    expect(usage.rows).toHaveLength(1);
  });

  it('emits a canonical error event and charges nothing when the provider stream fails', async () => {
    provider.options = {
      streamChunks: ['partial ', 'answer'],
      streamFailureAfter: 1,
      streamFailure: new AiProviderError('unavailable', 'mock-ai', 'upstream detail with secret', true, 503),
      inputTokens: 400, outputTokens: 100,
    };
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream',
      headers: { authorization: `Bearer ${apiKey}` }, payload: streamPayload(),
    });
    expect(response.statusCode).toBe(200);
    const events = parseSseEvents(response.body);
    expect(events[0]).toEqual({ type: 'chunk', content: 'partial ' });
    expect(events.at(-1)).toEqual({
      type: 'error', error: 'ai_provider_unavailable', message: 'The AI provider is temporarily unavailable',
    });
    expect(response.body).not.toContain('upstream detail');
    expect(response.body).not.toContain(providerSecret);

    expect(await creditBalance(customerId)).toBe(parseUnits('1000', 6).toString());
    const usage = await db.query('SELECT id FROM ai_usage_records');
    expect(usage.rows).toHaveLength(0);
    const failed = await db.query<{ status: string; failure_kind: string; failure_message: string }>(
      'SELECT status, failure_kind, failure_message FROM ai_provider_requests',
    );
    expect(failed.rows[0]).toMatchObject({ status: 'FAILED', failure_kind: 'unavailable' });
    expect(failed.rows[0].failure_message).not.toContain('upstream detail');
    const webhook = await db.query<{ event_type: string }>(
      `SELECT event_type FROM webhook_events WHERE event_type = 'ai.request.failed'`,
    );
    expect(webhook.rows).toHaveLength(1);
  });

  it('normalizes a provider stream timeout without charging', async () => {
    provider.options = {
      streamChunks: ['partial', 'answer'],
      streamFailureAfter: 1,
      streamFailure: new AiProviderError('timeout', 'mock-ai', 'The AI provider request timed out', true, 504),
    };
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream',
      headers: { authorization: `Bearer ${apiKey}` }, payload: streamPayload(),
    });
    expect(response.statusCode).toBe(200);
    expect(parseSseEvents(response.body).at(-1)).toEqual({
      type: 'error', error: 'ai_provider_timeout', message: 'The AI provider request timed out',
    });
    expect(await creditBalance(customerId)).toBe(parseUnits('1000', 6).toString());
    const usage = await db.query('SELECT id FROM ai_usage_records');
    expect(usage.rows).toHaveLength(0);
    const failed = await db.query<{ failure_kind: string }>('SELECT failure_kind FROM ai_provider_requests');
    expect(failed.rows[0].failure_kind).toBe('timeout');
  });

  it('aborts the provider request on client disconnect and never charges', async () => {
    provider.options = {
      streamChunks: ['first ', 'second ', 'third'],
      interChunkDelayMs: 150,
      inputTokens: 400, outputTokens: 100,
    };
    // Client disconnects are exercised through the gateway handle directly so the abort
    // can be triggered deterministically between two streamed chunks.
    const registry = new AiProviderRegistry();
    registry.register(provider, { enabled: true, settings: { apiKey: providerSecret } });
    await registry.initialize();
    const { AiGatewayService } = await import('../src/services/ai-gateway-service.js');
    const { AiPricingEngine } = await import('../src/services/ai-pricing-engine.js');
    const service = new AiGatewayService(db, new AiPricingEngine(db), registry);
    const written: AiGatewayStreamEvent[] = [];
    const disconnect = new AbortController();
    const runPromise = service.prepareChatCompletionStream({
      merchantId,
      customerId,
      provider: 'mock-ai',
      model: 'mock-small',
      messages: [{ role: 'user', content: 'Count to three' }],
      maxOutputTokens: 128,
      metadata: {},
      requestId: 'stream-request-disconnect',
    }).then((prepared) => prepared.run({
      write: (event) => written.push(event),
      signal: disconnect.signal,
    }));
    const firstChunkDeadline = Date.now() + 5_000;
    while (written.length < 1 && Date.now() < firstChunkDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(written).toEqual([{ type: 'chunk', content: 'first ' }]);
    disconnect.abort();
    await runPromise;

    expect(provider.streamAborts).toHaveLength(1);
    expect(await creditBalance(customerId)).toBe(parseUnits('1000', 6).toString());
    const usage = await db.query('SELECT id FROM ai_usage_records');
    expect(usage.rows).toHaveLength(0);
    const failed = await db.query<{ status: string; failure_kind: string }>(
      'SELECT status, failure_kind FROM ai_provider_requests',
    );
    expect(failed.rows[0]).toMatchObject({ status: 'FAILED', failure_kind: 'client_disconnected' });
    const webhook = await db.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM webhook_events WHERE event_type = 'ai.request.failed'`,
    );
    expect(webhook.rows[0].payload).toContain('client_disconnected');
  });

  it('falls back to estimated usage when the stream omits token counts', async () => {
    provider.options = {
      streamChunks: ['Hello ', 'streaming ', 'world!'], omitUsage: true,
    };
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream',
      headers: { authorization: `Bearer ${apiKey}` }, payload: streamPayload(),
    });
    expect(response.statusCode).toBe(200);
    const done = parseSseEvents(response.body).at(-1);
    const estimatedInput = estimatePromptTokens([{ content: 'Count to three' }]);
    expect(done).toMatchObject({
      type: 'done',
      usage: {
        inputTokens: estimatedInput,
        outputTokens: 6,
        usageSource: 'estimated',
        customerPriceUsd: '0.00017600', creditsDeducted: '0.0176', balanceAfter: '999.9824',
      },
    });
    const stored = await db.query<{ usage_authoritative: boolean }>(
      'SELECT usage_authoritative FROM ai_provider_requests',
    );
    expect(stored.rows[0].usage_authoritative).toBe(false);
    expect(await creditBalance(customerId)).toBe(parseUnits('999.9824', 6).toString());
  });

  it('caps the final settlement at the authorized maximum when usage exceeds it', async () => {
    // The prompt estimate is tiny, so provider-reported input usage far exceeds the
    // authorized worst case; the charge must stay bounded at the authorized maximum.
    provider.options = { streamChunks: ['answer'], inputTokens: 1_000_000, outputTokens: 500 };
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream',
      headers: { authorization: `Bearer ${apiKey}` }, payload: streamPayload(),
    });
    expect(response.statusCode).toBe(200);
    const done = parseSseEvents(response.body).at(-1);
    expect(done).toMatchObject({
      type: 'done',
      request: { chargeCapped: true },
      usage: {
        inputTokens: 1_000_000, outputTokens: 500, usageSource: 'provider',
        customerPriceUsd: '0.00286000', creditsDeducted: '0.286', balanceAfter: '999.714',
      },
    });
    const usage = await db.query<{ input_tokens: string; customer_price_usd: string }>(
      'SELECT input_tokens::text AS input_tokens, customer_price_usd::text AS customer_price_usd FROM ai_usage_records',
    );
    expect(usage.rows[0].input_tokens).toBe('1000000');
    expect(Number(usage.rows[0].customer_price_usd)).toBeCloseTo(0.00286, 8);
    expect(await creditBalance(customerId)).toBe(parseUnits('999.714', 6).toString());
  });

  it('streams normalized tool calls and never executes them', async () => {
    provider.options = {
      streamChunks: [],
      toolCalls: [{
        id: 'call_1', type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Belgrade"}' },
      }],
      inputTokens: 4, outputTokens: 10,
    };
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/stream',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: streamPayload({ tools, toolChoice: 'auto' }),
    });
    expect(response.statusCode).toBe(200);
    const events = parseSseEvents(response.body);
    expect(events[0]).toEqual({
      type: 'tool_call',
      toolCall: { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Belgrade"}' } },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      request: { toolCallCount: 1, finishReason: 'tool_calls' },
    });

    // The tool definitions reached the provider as passthrough data; nothing was executed.
    expect(provider.streamRequests[0]).toMatchObject({ tools, toolChoice: 'auto', maxOutputTokens: 128 });
    expect(provider.completions).toHaveLength(0);

    const usage = await db.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM ai_usage_records WHERE request_id = $1', ['stream-request-0001'],
    );
    expect(usage.rows[0].metadata).toMatchObject({ toolCallCount: 1 });
    // No execution surface exists: the request record stores only metadata, not content.
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ai_provider_requests'
          AND (column_name ILIKE '%content%' OR column_name ILIKE '%prompt%' OR column_name ILIKE '%tool%')`,
    );
    expect(columns.rows).toEqual([]);
  });

  it('returns tool calls from non-streaming completions too', async () => {
    provider.options = {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
      inputTokens: 300, outputTokens: 50,
    };
    const response = await app.inject({
      method: 'POST', url: '/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        requestId: 'tool-request-0001', customerId, provider: 'mock-ai', model: 'mock-small',
        messages: [{ role: 'user', content: 'Weather in Belgrade?' }], tools, toolChoice: 'auto',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({
      finishReason: 'tool_calls', toolCallCount: 1,
      toolCalls: [{ id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
    });
    expect(provider.completions[0]).toMatchObject({ tools });
    const usage = await db.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM ai_usage_records WHERE request_id = $1', ['tool-request-0001'],
    );
    expect(usage.rows[0].metadata).toMatchObject({ toolCallCount: 1 });
  });

  it('keeps prompts and completion content out of logs and stored records', async () => {
    provider.options = { streamChunks: ['confidential streamed content'], inputTokens: 100, outputTokens: 50 };
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
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/ai/chat/stream',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: streamPayload({ messages: [{ role: 'user', content: 'confidential customer prompt' }] }),
      });
      expect(response.statusCode).toBe(200);
    } finally {
      (app.log as { error: unknown }).error = originalError;
      (app.log as { info: unknown }).info = originalInfo;
    }
    const logs = appLogs.join('');
    expect(logs).not.toContain('confidential customer prompt');
    expect(logs).not.toContain('confidential streamed content');
    expect(logs).not.toContain(providerSecret);
    const rows = await db.query<{ metadata: string }>(
      'SELECT metadata::text AS metadata FROM ai_usage_records',
    );
    for (const row of rows.rows) {
      expect(row.metadata).not.toContain('confidential');
    }
  });
});
