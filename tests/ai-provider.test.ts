import { describe, expect, it, vi } from 'vitest';
import { AiProviderError, normalizeAiProviderError, type AiChatCompletionRequest } from '../src/ai-provider.js';
import { AiProviderRegistry } from '../src/ai-providers/registry.js';
import { OpenAiProvider } from '../src/ai-providers/openai-provider.js';
import { createDefaultAiProviderRegistry } from '../src/ai-providers/default-registry.js';
import { MockAiProvider } from './fixtures/mock-ai-provider.js';

const apiKey = 'sk-test-provider-credential-value-123456';

function completionRequest(overrides: Partial<AiChatCompletionRequest> = {}): AiChatCompletionRequest {
  return {
    requestId: 'provider-request-0001',
    model: 'mock-small',
    messages: [{ role: 'user', content: 'Hello there' }],
    maxOutputTokens: 128,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const completionBody = {
  id: 'resp_abc123',
  model: 'gpt-4o-mini',
  choices: [{ message: { role: 'assistant', content: 'Hi from the provider' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1_200, completion_tokens: 340, total_tokens: 1_540 },
};

describe('AI provider registry', () => {
  it('registers a provider, initializes it with server settings, and reports capabilities and health', async () => {
    const provider = new MockAiProvider();
    const registry = new AiProviderRegistry();
    registry.register(provider, { enabled: true, settings: { apiKey } });
    await registry.initialize();

    expect(provider.initialized).toBe(true);
    expect(provider.initializations).toEqual([{ apiKey }]);
    expect(registry.isEnabled('mock-ai')).toBe(true);
    expect(registry.isConfigured('mock-ai')).toBe(true);
    expect(registry.getConfiguredProvider('mock-ai')).toBe(provider);
    const [summary] = await registry.list();
    expect(summary).toMatchObject({
      id: 'mock-ai', status: 'enabled', lifecycle: 'ready', configured: true,
      health: { status: 'healthy' },
      capabilities: { chatCompletions: true, reportsInputTokens: true, reportsOutputTokens: true },
    });
    await registry.shutdown();
    expect(provider.shutDown).toBe(true);
  });

  it('refuses duplicate registration, registration after initialization, and invalid manifests', async () => {
    const registry = new AiProviderRegistry();
    registry.register(new MockAiProvider(), { enabled: true, settings: {} });
    expect(() => registry.register(new MockAiProvider(), { enabled: true, settings: {} }))
      .toThrow(/already registered/);
    await registry.initialize();
    expect(() => registry.register(new MockAiProvider(), { enabled: true, settings: {} }))
      .toThrow(/already initialized/);

    const invalid = new MockAiProvider();
    expect(() => new AiProviderRegistry().register(
      { ...invalid, id: 'Mock AI', manifest: { ...invalid.manifest, id: 'mismatch' } } as never,
      { enabled: true, settings: {} },
    )).toThrow(/manifest is invalid/);
  });

  it('rejects disabled providers and unconfigured credentials before any request', async () => {
    const provider = new MockAiProvider();
    const registry = new AiProviderRegistry();
    registry.register(provider, { enabled: false, settings: {} });
    await registry.initialize();

    expect(registry.isEnabled('mock-ai')).toBe(false);
    expect(registry.isConfigured('mock-ai')).toBe(false);
    expect(() => registry.getConfiguredProvider('mock-ai')).toThrow(AiProviderError);
    expect(() => registry.getConfiguredProvider('unknown-provider')).toThrow(/not installed/);
    expect(provider.completions).toHaveLength(0);
  });

  it('treats a provider without a server-side credential as unconfigured', async () => {
    const provider = new MockAiProvider();
    provider.options = { configured: false };
    const registry = new AiProviderRegistry();
    registry.register(provider, { enabled: true, settings: { apiKey: '' } });
    await registry.initialize();

    expect(registry.isConfigured('mock-ai')).toBe(false);
    expect(() => registry.getConfiguredProvider('mock-ai')).toThrow(/no configured credential/);
  });

  it('exposes the default registry with the environment-configured provider only', async () => {
    const registry = createDefaultAiProviderRegistry();
    await registry.initialize();
    const summaries = await registry.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: 'openai-compatible', kind: 'openai-compatible' });
    expect(summaries[0]).not.toHaveProperty('apiKey');
    expect(JSON.stringify(summaries)).not.toContain('Bearer');
  });
});

describe('OpenAI-compatible provider', () => {
  async function providerWith(fetchImpl: typeof fetch, settings: Record<string, unknown> = { apiKey }) {
    const provider = new OpenAiProvider(fetchImpl);
    await provider.initialize(settings);
    return provider;
  }

  it('reports health, discovers models, and normalizes chat completion usage', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/models')) {
        return jsonResponse({ data: [
          { id: 'gpt-4o-mini', max_output_tokens: 4096, context_window: 128_000 },
          { id: 'gpt-4o', max_output_tokens: 16_384 },
          { name: 'missing-id' },
        ] });
      }
      return jsonResponse(completionBody);
    }) as unknown as typeof fetch;
    const provider = await providerWith(fetchImpl);

    expect(await provider.health()).toEqual({ status: 'healthy', message: 'Provider accepted the configured credential' });
    const models = await provider.listModels();
    expect(models).toEqual([
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini', contextWindow: 128_000, maxOutputTokens: 4096 },
      { id: 'gpt-4o', name: 'gpt-4o', contextWindow: null, maxOutputTokens: 16_384 },
    ]);

    const completion = await provider.createChatCompletion(completionRequest({ model: 'gpt-4o-mini' }));
    expect(completion).toMatchObject({
      providerRequestId: 'provider-request-0001',
      providerResponseId: 'resp_abc123',
      model: 'gpt-4o-mini',
      finishReason: 'stop',
      message: { role: 'assistant', content: 'Hi from the provider' },
      usage: { inputTokens: 1_200, outputTokens: 340, authoritative: true },
    });
    const call = fetchImpl.mock.calls.at(-1);
    expect((call?.[1] as RequestInit).method).toBe('POST');
    const headers = (call?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(headers['x-request-id']).toBe('provider-request-0001');
  });

  it('marks usage as non-authoritative when the provider omits token counts', async () => {
    const { usage: _usage, ...withoutUsage } = completionBody;
    const provider = await providerWith((async () => jsonResponse(withoutUsage)) as unknown as typeof fetch);
    const completion = await provider.createChatCompletion(completionRequest());
    expect(completion.usage).toEqual({ inputTokens: 0, outputTokens: 0, authoritative: false });
  });

  it('rejects an empty completion and a malformed provider response identifier', async () => {
    const empty = await providerWith((async () => jsonResponse({ ...completionBody, choices: [{ message: { content: '  ' } }] })) as unknown as typeof fetch);
    await expect(empty.createChatCompletion(completionRequest())).rejects.toThrow(/empty completion/);
    const malformed = await providerWith((async () => jsonResponse({ ...completionBody, id: 'bad id with spaces' })) as unknown as typeof fetch);
    await expect(malformed.createChatCompletion(completionRequest())).rejects.toThrow(/invalid response identifier/);
  });

  it('aborts the request when the configured timeout elapses', async () => {
    const provider = await providerWith(((url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as unknown as typeof fetch, { apiKey, timeoutMs: 1_000 });
    const started = Date.now();
    await expect(provider.createChatCompletion(completionRequest())).rejects.toMatchObject({
      name: 'AiProviderError', kind: 'timeout', statusCode: 504, retryable: true,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('normalizes provider HTTP failures and never leaks the credential', async () => {
    const cases: Array<[number, string, number]> = [
      [401, 'unauthorized', 502], [403, 'unauthorized', 502], [429, 'rate_limited', 503],
      [400, 'invalid_request', 502], [404, 'not_found', 422], [500, 'unavailable', 503], [503, 'unavailable', 503],
    ];
    for (const [status, kind, expectedStatus] of cases) {
      const provider = await providerWith((async () => jsonResponse({ error: { message: 'upstream detail' } }, status)) as unknown as typeof fetch);
      const error = await provider.createChatCompletion(completionRequest()).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(AiProviderError);
      expect((error as AiProviderError).kind).toBe(kind);
      expect((error as AiProviderError).statusCode).toBe(expectedStatus);
      expect((error as Error).message).not.toContain(apiKey);
      expect((error as Error).message).not.toContain('upstream detail');
    }
  });

  it('refuses to call the provider when no credential is configured', async () => {
    const fetchImpl = vi.fn();
    const provider = await providerWith(fetchImpl as unknown as typeof fetch, { apiKey: '' });
    expect(provider.isConfigured()).toBe(false);
    expect(await provider.health()).toEqual({ status: 'unavailable', message: 'Provider credential is not configured' });
    await expect(provider.createChatCompletion(completionRequest())).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caps requested output tokens at the manifest capability', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(completionBody)) as unknown as typeof fetch;
    const provider = await providerWith(fetchImpl);
    await provider.createChatCompletion(completionRequest({ maxOutputTokens: 100_000 }));
    const body = JSON.parse((fetchImpl.mock.calls.at(-1)?.[1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(4096);
  });
});

describe('AI provider error normalization', () => {
  it('maps abort, HTTP, and unknown failures to retryable or terminal kinds', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(normalizeAiProviderError(abort, 'mock-ai')).toMatchObject({ kind: 'timeout', retryable: true, statusCode: 504 });

    const http = Object.assign(new Error('http'), { name: 'AiProviderHttpError', status: 429 });
    expect(normalizeAiProviderError(http, 'mock-ai')).toMatchObject({ kind: 'rate_limited', statusCode: 503 });

    expect(normalizeAiProviderError(new Error('socket hang up'), 'mock-ai')).toMatchObject({
      kind: 'unavailable', statusCode: 502, retryable: true,
    });

    const existing = new AiProviderError('not_found', 'mock-ai', 'missing', false, 422);
    expect(normalizeAiProviderError(existing, 'mock-ai')).toBe(existing);
  });
});
