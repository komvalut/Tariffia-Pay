import { describe, expect, it, vi } from 'vitest';
import {
  SmsProviderError,
  normalizeSmsProviderError,
  type SmsDeliveryRequest,
} from '../src/sms-provider.js';
import { SmsProviderRegistry } from '../src/sms-providers/registry.js';
import { HttpSmsProvider } from '../src/sms-providers/http-sms-provider.js';
import { createDefaultSmsProviderRegistry } from '../src/sms-providers/default-registry.js';
import { MockSmsProvider } from './fixtures/mock-sms-provider.js';

const apiKey = 'sms-live-provider-credential-value-1234567890';

function deliveryRequest(overrides: Partial<SmsDeliveryRequest> = {}): SmsDeliveryRequest {
  return {
    requestId: 'sms-request-0001',
    to: '+381601234567',
    message: 'Your verification code is 123456',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const deliveryBody = {
  id: 'msg_abc123',
  status: 'sent',
  segments: 1,
  cost: 0.004,
};

describe('SMS provider registry', () => {
  it('registers a provider, initializes it with server settings, and reports capabilities and health', async () => {
    const provider = new MockSmsProvider();
    const registry = new SmsProviderRegistry();
    registry.register(provider, { enabled: true, settings: { apiKey } });
    await registry.initialize();

    expect(provider.initialized).toBe(true);
    expect(provider.initializations).toEqual([{ apiKey }]);
    expect(registry.isEnabled('mock-sms')).toBe(true);
    expect(registry.isConfigured('mock-sms')).toBe(true);
    expect(registry.getConfiguredProvider('mock-sms')).toBe(provider);
    const [summary] = await registry.list();
    expect(summary).toMatchObject({
      id: 'mock-sms', status: 'enabled', lifecycle: 'ready', configured: true,
      health: { status: 'healthy' },
      capabilities: { sendSms: true, sendOtp: false, reportsSegments: true, reportsProviderCost: true },
    });
    await registry.shutdown();
    expect(provider.shutDown).toBe(true);
  });

  it('refuses duplicate registration and registration after initialization', async () => {
    const registry = new SmsProviderRegistry();
    registry.register(new MockSmsProvider(), { enabled: true, settings: {} });
    expect(() => registry.register(new MockSmsProvider(), { enabled: true, settings: {} }))
      .toThrow(/already registered/);
    await registry.initialize();
    expect(() => registry.register(new MockSmsProvider(), { enabled: true, settings: {} }))
      .toThrow(/already initialized/);
  });

  it('rejects an invalid manifest', () => {
    const invalid = new MockSmsProvider();
    expect(() => new SmsProviderRegistry().register(
      { ...invalid, id: 'Mock SMS', manifest: { ...invalid.manifest, id: 'mismatch' } } as never,
      { enabled: true, settings: {} },
    )).toThrow(/manifest is invalid/);
  });

  it('rejects disabled providers and unknown providers before any request', async () => {
    const provider = new MockSmsProvider();
    const registry = new SmsProviderRegistry();
    registry.register(provider, { enabled: false, settings: {} });
    await registry.initialize();

    expect(registry.isEnabled('mock-sms')).toBe(false);
    expect(registry.isConfigured('mock-sms')).toBe(false);
    expect(() => registry.getConfiguredProvider('mock-sms')).toThrow(SmsProviderError);
    expect(() => registry.getConfiguredProvider('unknown-sms')).toThrow(/not installed/);
    expect(provider.smsCalls).toHaveLength(0);
  });

  it('treats a provider without a server-side credential as unconfigured', async () => {
    const provider = new MockSmsProvider();
    provider.options = { configured: false };
    const registry = new SmsProviderRegistry();
    registry.register(provider, { enabled: true, settings: { apiKey: '' } });
    await registry.initialize();

    expect(registry.isConfigured('mock-sms')).toBe(false);
    expect(() => registry.getConfiguredProvider('mock-sms')).toThrow(/no configured credential/);
  });

  it('exposes the default registry with the environment-configured provider only', async () => {
    const registry = createDefaultSmsProviderRegistry();
    await registry.initialize();
    const summaries = await registry.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: 'http-sms', kind: 'http-sms' });
    expect(JSON.stringify(summaries)).not.toContain(apiKey);
    expect(JSON.stringify(summaries)).not.toContain('Bearer');
  });
});

describe('HTTP SMS provider', () => {
  async function providerWith(fetchImpl: typeof fetch, settings: Record<string, unknown> = { apiKey, baseUrl: 'https://sms.example' }) {
    const provider = new HttpSmsProvider(fetchImpl);
    await provider.initialize(settings);
    return provider;
  }

  it('reports health and normalizes delivery results with segments and cost', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/health')) return jsonResponse({ status: 'ok' });
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ to: '+381601234567', message: 'Your verification code is 123456', idempotency_key: 'sms-request-0001' });
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${apiKey}`);
      expect(headers['x-request-id']).toBe('sms-request-0001');
      return jsonResponse(deliveryBody);
    }) as unknown as typeof fetch;
    const provider = await providerWith(fetchImpl);

    expect(await provider.health()).toEqual({ status: 'healthy', message: 'Provider accepted the configured credential' });
    const delivery = await provider.sendSms(deliveryRequest());
    expect(delivery).toEqual({
      providerRequestId: 'sms-request-0001',
      providerMessageId: 'msg_abc123',
      status: 'sent',
      segments: 1,
      segmentsAuthoritative: true,
      providerCostUsd: '0.00400000',
    });
  });

  it('marks segments as non-authoritative when the provider omits them', async () => {
    const { segments: _segments, cost: _cost, ...withoutUsage } = deliveryBody;
    const provider = await providerWith((async () => jsonResponse(withoutUsage)) as unknown as typeof fetch);
    const delivery = await provider.sendSms(deliveryRequest());
    expect(delivery).toEqual({
      providerRequestId: 'sms-request-0001',
      providerMessageId: 'msg_abc123',
      status: 'sent',
      segments: 1,
      segmentsAuthoritative: false,
      providerCostUsd: null,
    });
  });

  it('rejects invalid destinations, empty messages, and malformed provider identifiers', async () => {
    const provider = await providerWith((async () => jsonResponse(deliveryBody)) as unknown as typeof fetch);
    await expect(provider.sendSms(deliveryRequest({ to: '601234567' })))
      .rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(provider.sendSms(deliveryRequest({ message: '   ' })))
      .rejects.toMatchObject({ kind: 'invalid_request' });
    const malformed = await providerWith((async () => jsonResponse({ ...deliveryBody, id: 'bad id' })) as unknown as typeof fetch);
    await expect(malformed.sendSms(deliveryRequest())).rejects.toMatchObject({ kind: 'invalid_response' });
    const failed = await providerWith((async () => jsonResponse({ ...deliveryBody, status: 'failed' })) as unknown as typeof fetch);
    await expect(failed.sendSms(deliveryRequest())).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('aborts the request when the configured timeout elapses', async () => {
    const provider = await providerWith(((url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as unknown as typeof fetch, { apiKey, baseUrl: 'https://sms.example', timeoutMs: 1_000 });
    const started = Date.now();
    await expect(provider.sendSms(deliveryRequest())).rejects.toMatchObject({
      name: 'SmsProviderError', kind: 'timeout', statusCode: 504, retryable: true,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('normalizes provider HTTP failures and never leaks the credential or message', async () => {
    const cases: Array<[number, string, number]> = [
      [401, 'unauthorized', 502], [403, 'unauthorized', 502], [429, 'rate_limited', 503],
      [400, 'invalid_request', 502], [404, 'not_found', 422], [500, 'unavailable', 503], [503, 'unavailable', 503],
    ];
    for (const [status, kind, expectedStatus] of cases) {
      const provider = await providerWith((async () => jsonResponse({ message: 'upstream detail' }, status)) as unknown as typeof fetch);
      const error = await provider.sendSms(deliveryRequest()).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(SmsProviderError);
      expect((error as SmsProviderError).kind).toBe(kind);
      expect((error as SmsProviderError).statusCode).toBe(expectedStatus);
      expect((error as Error).message).not.toContain(apiKey);
      expect((error as Error).message).not.toContain('upstream detail');
      expect((error as Error).message).not.toContain('123456');
    }
  });

  it('refuses to call the provider without a credential or endpoint', async () => {
    const fetchImpl = vi.fn();
    const provider = await providerWith(fetchImpl as unknown as typeof fetch, { apiKey: '', baseUrl: '' });
    expect(provider.isConfigured()).toBe(false);
    expect(await provider.health()).toEqual({
      status: 'unavailable', message: 'Provider credential or endpoint is not configured',
    });
    await expect(provider.sendSms(deliveryRequest())).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('SMS provider error normalization', () => {
  it('maps abort, HTTP, and unknown failures to canonical kinds', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(normalizeSmsProviderError(abort, 'mock-sms')).toMatchObject({ kind: 'timeout', retryable: true, statusCode: 504 });

    const http = Object.assign(new Error('http'), { name: 'SmsProviderHttpError', status: 429 });
    expect(normalizeSmsProviderError(http, 'mock-sms')).toMatchObject({ kind: 'rate_limited', statusCode: 503 });

    expect(normalizeSmsProviderError(new Error('socket hang up'), 'mock-sms')).toMatchObject({
      kind: 'unavailable', statusCode: 502, retryable: true,
    });

    const existing = new SmsProviderError('not_found', 'mock-sms', 'missing', false, 422);
    expect(normalizeSmsProviderError(existing, 'mock-sms')).toBe(existing);
  });
});
