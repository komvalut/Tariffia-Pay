import { describe, expect, it, vi } from 'vitest';
import {
  SmsProviderError,
  normalizeSmsProviderError,
  type SmsDeliveryRequest,
} from '../src/sms-provider.js';
import { SmsProviderRegistry } from '../src/sms-providers/registry.js';
import { TextBeeSmsProvider } from '../src/sms-providers/textbee-sms-provider.js';
import { createDefaultSmsProviderRegistry } from '../src/sms-providers/default-registry.js';

const apiKey = 'textbee-live-provider-credential-1234567890';
const deviceId = 'device-abc123';

function deliveryRequest(overrides: Partial<SmsDeliveryRequest> = {}): SmsDeliveryRequest {
  return {
    requestId: 'textbee-request-0001',
    idempotencyKey: 'textbee-request-0001',
    to: '+381601234567',
    message: 'Your verification code is 123456',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const queuedSend = {
  data: {
    success: true,
    message: 'SMS added to queue for processing',
    smsBatchId: 'batch_5f8ac3d2e4b01a7c9d0e6f7a',
    recipientCount: 1,
  },
};

const immediateSend = { data: { successCount: 1, failureCount: 0 } };

const device = (overrides: Record<string, unknown> = {}) => ({
  _id: deviceId, enabled: true, isDefault: true, model: 'Pixel 7', ...overrides,
});

const devicesOk = { data: [device()] };

async function textbeeWith(fetchImpl: typeof fetch, settings: Record<string, unknown> = { apiKey }) {
  const provider = new TextBeeSmsProvider(fetchImpl);
  await provider.initialize(settings);
  return provider;
}

describe('TextBee provider', () => {
  it('declares the documented capabilities without idempotent retries', async () => {
    const provider = new TextBeeSmsProvider();
    await provider.initialize({ apiKey, deviceId });
    expect(provider.manifest).toMatchObject({
      id: 'textbee', name: 'TextBee', kind: 'http-sms',
      capabilities: {
        sendSms: true, sendOtp: false, reportsSegments: false,
        reportsProviderCost: false, idempotentRetries: false,
      },
    });
    expect(provider.configurationStatus()).toEqual({
      deviceIdConfigured: true, simSubscriptionConfigured: false,
    });
    await provider.initialize({ apiKey, simSubscriptionId: 2 });
    expect(provider.configurationStatus()).toEqual({
      deviceIdConfigured: false, simSubscriptionConfigured: true,
    });
    await provider.initialize({ apiKey });
    expect(provider.configurationStatus()).toEqual({
      deviceIdConfigured: false, simSubscriptionConfigured: false,
    });
  });

  it('registers alongside other providers and passes registry validation', async () => {
    const registry = new SmsProviderRegistry();
    const provider = new TextBeeSmsProvider();
    registry.register(provider, { enabled: true, settings: { apiKey } });
    await registry.initialize();
    expect(registry.isEnabled('textbee')).toBe(true);
    expect(registry.isConfigured('textbee')).toBe(true);
    const [summary] = await registry.list();
    expect(summary).toMatchObject({
      id: 'textbee', status: 'enabled', lifecycle: 'ready', configured: true,
      configuration: { deviceIdConfigured: false, simSubscriptionConfigured: false },
    });
    expect(JSON.stringify(summary)).not.toContain(apiKey);
  });

  it('is not part of the default registry unless explicitly enabled', async () => {
    const disabled = createDefaultSmsProviderRegistry();
    await disabled.initialize();
    expect((await disabled.list()).map((summary) => summary.id)).toEqual(['http-sms']);
    await disabled.shutdown();

    process.env.TEXTBEE_ENABLED = 'true';
    process.env.TEXTBEE_API_KEY = apiKey;
    let enabled: SmsProviderRegistry | undefined;
    try {
      vi.resetModules();
      const registryModule = await import('../src/sms-providers/default-registry.js');
      enabled = registryModule.createDefaultSmsProviderRegistry();
      await enabled.initialize();
      expect((await enabled.list()).map((summary) => summary.id)).toEqual(['http-sms', 'textbee']);
      const textbee = enabled.getProvider('textbee');
      expect(typeof textbee.sendSms).toBe('function');
      expect(textbee.isConfigured()).toBe(true);
      expect(JSON.stringify(await enabled.list())).not.toContain(apiKey);
    } finally {
      delete process.env.TEXTBEE_ENABLED;
      delete process.env.TEXTBEE_API_KEY;
      await enabled?.shutdown();
      vi.resetModules();
    }
  });

  it('maps the Tariffia request onto the documented send body and normalizes smsBatchId', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.textbee.dev/api/v1/gateway/send-sms');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe(apiKey);
      expect(headers.authorization).toBeUndefined();
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ recipients: ['+381601234567'], message: 'Your verification code is 123456' });
      return jsonResponse(queuedSend);
    }) as unknown as typeof fetch;
    const provider = await textbeeWith(fetchImpl);
    const delivery = await provider.sendSms(deliveryRequest());
    expect(delivery).toEqual({
      providerRequestId: 'textbee-request-0001',
      providerMessageId: 'batch_5f8ac3d2e4b01a7c9d0e6f7a',
      status: 'sent',
      segments: 1,
      segmentsAuthoritative: false,
      providerCostUsd: null,
      currency: 'USD',
    });
  });

  it('sends the configured device and SIM when provided', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        recipients: ['+381601234567'],
        message: 'Your verification code is 123456',
        deviceId,
        simSubscriptionId: 2,
      });
      return jsonResponse(queuedSend);
    }) as unknown as typeof fetch;
    const provider = await textbeeWith(fetchImpl, { apiKey, deviceId, simSubscriptionId: 2 });
    await provider.sendSms(deliveryRequest());
  });

  it('accepts the documented immediate-dispatch shape without inventing an identifier', async () => {
    const provider = await textbeeWith((async () => jsonResponse(immediateSend)) as unknown as typeof fetch);
    const delivery = await provider.sendSms(deliveryRequest());
    expect(delivery).toEqual({
      providerRequestId: 'textbee-request-0001',
      providerMessageId: '',
      status: 'sent',
      segments: 1,
      segmentsAuthoritative: false,
      providerCostUsd: null,
      currency: 'USD',
    });
  });

  it('rejects ambiguous or failed send results safely', async () => {
    const notAccepted = await textbeeWith((async () => jsonResponse({ data: { success: false } })) as unknown as typeof fetch);
    await expect(notAccepted.sendSms(deliveryRequest())).rejects.toMatchObject({
      kind: 'unavailable', retryable: true, statusCode: 503,
    });
    const notPushed = await textbeeWith(
      (async () => jsonResponse({ data: { successCount: 0, failureCount: 1 } })) as unknown as typeof fetch,
    );
    await expect(notPushed.sendSms(deliveryRequest())).rejects.toMatchObject({
      kind: 'unavailable', retryable: true, statusCode: 503,
    });
    for (const ambiguous of [
      { data: {} },
      { data: { successCount: 0 } },
      { data: { smsBatchId: 'has spaces' } },
      {},
    ]) {
      const provider = await textbeeWith((async () => jsonResponse(ambiguous)) as unknown as typeof fetch);
      await expect(provider.sendSms(deliveryRequest())).rejects.toMatchObject({
        kind: 'invalid_response', retryable: false, statusCode: 502,
      });
    }
  });

  it('maps documented TextBee HTTP errors and never exposes the key or raw bodies', async () => {
    const cases: Array<[number, string, number]> = [
      [401, 'unauthorized', 502], [400, 'invalid_request', 502], [429, 'rate_limited', 503],
      [404, 'not_found', 422], [500, 'unavailable', 503], [503, 'unavailable', 503],
    ];
    for (const [status, kind, expectedStatus] of cases) {
      const provider = await textbeeWith(
        (async () => jsonResponse({ message: 'raw provider detail' }, status)) as unknown as typeof fetch,
      );
      const error = await provider.sendSms(deliveryRequest()).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(SmsProviderError);
      expect((error as SmsProviderError).kind).toBe(kind);
      expect((error as SmsProviderError).statusCode).toBe(expectedStatus);
      expect((error as Error).message).not.toContain('raw provider detail');
      expect((error as Error).message).not.toContain(apiKey);
      expect((error as Error).message).not.toContain('123456');
    }
  });

  it('preserves the Retry-After hint on rate-limited responses', async () => {
    const rateLimited = new Response(JSON.stringify({ message: 'daily limit used up' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '45' },
    });
    const provider = await textbeeWith((async () => rateLimited) as unknown as typeof fetch);
    const error = await provider.sendSms(deliveryRequest()).catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: 'rate_limited', retryable: true, statusCode: 503, retryAfterMs: 45_000 });
    expect((error as Error).message).not.toContain('daily limit used up');
  });

  it('aborts the request on the configured timeout', async () => {
    const provider = await textbeeWith(((url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      void url;
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as unknown as typeof fetch, { apiKey, timeoutMs: 1_000 });
    const started = Date.now();
    await expect(provider.sendSms(deliveryRequest())).rejects.toMatchObject({
      kind: 'timeout', retryable: true, statusCode: 504,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('checks health against the documented devices endpoint without sending an SMS', async () => {
    const unconfigured = new TextBeeSmsProvider();
    await unconfigured.initialize({ apiKey: '' });
    expect(await unconfigured.health()).toEqual({
      status: 'unavailable', message: 'Provider credential is not configured',
    });

    const rejected = await textbeeWith((async () => jsonResponse({ message: 'invalid key' }, 401)) as unknown as typeof fetch);
    expect(await rejected.health()).toEqual({
      status: 'unavailable', message: 'Provider rejected the configured credential',
    });

    const reachable = await textbeeWith(
      (async () => jsonResponse({ message: 'server error' }, 500)) as unknown as typeof fetch,
    );
    expect(await reachable.health()).toMatchObject({ status: 'degraded' });

    const noDevices = await textbeeWith((async () => jsonResponse({ data: [] })) as unknown as typeof fetch);
    expect(await noDevices.health()).toMatchObject({
      status: 'unavailable', message: 'No enabled device is available on this account',
    });

    const allDisabled = await textbeeWith(
      (async () => jsonResponse({ data: [device({ enabled: false })] })) as unknown as typeof fetch,
    );
    expect(await allDisabled.health()).toMatchObject({ status: 'unavailable' });

    const healthy = await textbeeWith((async () => jsonResponse(devicesOk)) as unknown as typeof fetch);
    expect(await healthy.health()).toEqual({
      status: 'healthy',
      message: 'Provider accepted the configured credential and an enabled device is available',
    });
  });

  it('verifies a configured device exists and is enabled for health', async () => {
    const missing = await textbeeWith(
      (async () => jsonResponse({ data: [device({ _id: 'another-device' })] })) as unknown as typeof fetch,
      { apiKey, deviceId },
    );
    expect(await missing.health()).toEqual({
      status: 'unavailable', message: 'The configured device is not available on this account',
    });

    const disabled = await textbeeWith(
      (async () => jsonResponse({ data: [device({ enabled: false })] })) as unknown as typeof fetch,
      { apiKey, deviceId },
    );
    expect(await disabled.health()).toEqual({
      status: 'unavailable', message: 'The configured device is disabled',
    });

    const ok = await textbeeWith((async () => jsonResponse(devicesOk)) as unknown as typeof fetch, { apiKey, deviceId });
    expect(await ok.health()).toEqual({
      status: 'healthy', message: 'Provider accepted the configured credential and the device is enabled',
    });
  });

  it('never sends an SMS as a health check', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('/gateway/devices');
      return jsonResponse(devicesOk);
    }) as unknown as typeof fetch;
    const provider = await textbeeWith(fetchImpl);
    expect(await provider.health()).toMatchObject({ status: 'healthy' });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('is unusable without configuration and rejects invalid destinations', async () => {
    const fetchImpl = vi.fn();
    const provider = await textbeeWith(fetchImpl as unknown as typeof fetch, { apiKey: '' });
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.sendSms(deliveryRequest())).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(await provider.health()).toMatchObject({ status: 'unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();

    const configured = await textbeeWith((async () => jsonResponse(queuedSend)) as unknown as typeof fetch);
    await expect(configured.sendSms(deliveryRequest({ to: '601234567' })))
      .rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(configured.sendSms(deliveryRequest({ message: '   ' })))
      .rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('reuses the shared error normalization for provider-level classification', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(normalizeSmsProviderError(abort, 'textbee')).toMatchObject({ kind: 'timeout', statusCode: 504 });
    const http = Object.assign(new Error('http'), { name: 'SmsProviderHttpError', status: 429, retryAfterMs: 5_000 });
    expect(normalizeSmsProviderError(http, 'textbee')).toMatchObject({
      kind: 'rate_limited', statusCode: 503, retryAfterMs: 5_000,
    });
  });
});
