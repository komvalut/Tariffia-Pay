import { config } from '../config.js';
import {
  SmsProviderError,
  normalizeSmsProviderError,
  type SmsDeliveryRequest,
  type SmsDeliveryResult,
  type SmsOtpRequest,
  type SmsProvider,
  type SmsProviderHealth,
  type SmsProviderManifest,
} from '../sms-provider.js';

type HttpSmsProviderSettings = {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  sendPath: string;
  healthPath: string;
};

type ProviderHttpError = Error & { name: 'SmsProviderHttpError'; status: number };

type ProviderResponse = {
  id?: unknown;
  status?: unknown;
  segments?: unknown;
  cost?: unknown;
};

const manifest: SmsProviderManifest = {
  id: 'http-sms',
  name: 'HTTP SMS provider',
  version: '1.0.0',
  description: 'Server-configured HTTP SMS delivery endpoint with bearer authentication',
  kind: 'http-sms',
  capabilities: {
    sendSms: true,
    sendOtp: false,
    maxMessageLength: 1600,
    reportsSegments: true,
    reportsProviderCost: true,
  },
};

const e164 = /^\+[1-9]\d{7,14}$/;

export class HttpSmsProvider implements SmsProvider {
  readonly id = 'http-sms';
  readonly manifest = manifest;
  private settings: HttpSmsProviderSettings = {
    apiKey: '', baseUrl: '', timeoutMs: 30_000, sendPath: '/v1/messages', healthPath: '/health',
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async initialize(settings: Readonly<Record<string, unknown>>): Promise<void> {
    const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
    const baseUrl = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim().replace(/\/+$/, '') : '';
    const timeoutMs = typeof settings.timeoutMs === 'number' && Number.isInteger(settings.timeoutMs) && settings.timeoutMs > 0
      ? settings.timeoutMs
      : 30_000;
    const sendPath = typeof settings.sendPath === 'string' && settings.sendPath.trim().startsWith('/')
      ? settings.sendPath.trim()
      : '/v1/messages';
    const healthPath = typeof settings.healthPath === 'string' && settings.healthPath.trim().startsWith('/')
      ? settings.healthPath.trim()
      : '/health';
    this.settings = { apiKey, baseUrl, timeoutMs, sendPath, healthPath };
  }

  async shutdown(): Promise<void> {}

  isConfigured(): boolean {
    return this.settings.apiKey.length > 0 && this.settings.baseUrl.length > 0;
  }

  async health(): Promise<SmsProviderHealth> {
    if (!this.isConfigured()) return { status: 'unavailable', message: 'Provider credential or endpoint is not configured' };
    try {
      await this.requestJson('GET', this.settings.healthPath, undefined, 'health');
      return { status: 'healthy', message: 'Provider accepted the configured credential' };
    } catch (error) {
      const normalized = normalizeSmsProviderError(error, this.id);
      if (normalized.kind === 'unauthorized') {
        return { status: 'unavailable', message: 'Provider rejected the configured credential' };
      }
      return { status: 'degraded', message: normalized.message };
    }
  }

  async sendSms(request: SmsDeliveryRequest): Promise<SmsDeliveryResult> {
    if (!e164.test(request.to)) {
      throw new SmsProviderError('invalid_request', this.id, 'The destination must be an E.164 phone number', false, 400);
    }
    if (!request.message.trim() || request.message.length > manifest.capabilities.maxMessageLength) {
      throw new SmsProviderError('invalid_request', this.id, 'The message length is not supported', false, 400);
    }
    const response = await this.requestJson('POST', this.settings.sendPath, {
      to: request.to,
      message: request.message,
      idempotency_key: request.requestId,
    }, 'sms delivery', request.requestId);
    return this.normalizeDelivery(response, request);
  }

  async sendOtp(_request: SmsOtpRequest): Promise<SmsDeliveryResult> {
    throw new SmsProviderError('invalid_request', this.id, 'The provider does not support native OTP delivery', false, 400);
  }

  private normalizeDelivery(response: ProviderResponse, request: SmsDeliveryRequest): SmsDeliveryResult {
    const providerMessageId = typeof response.id === 'string' ? response.id.trim() : '';
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(providerMessageId)) {
      throw new SmsProviderError('invalid_response', this.id, 'The SMS provider returned an invalid message identifier', false, 502);
    }
    const status = typeof response.status === 'string' ? response.status.trim().toLowerCase() : 'sent';
    if (!['sent', 'queued', 'accepted', 'scheduled', 'delivered'].includes(status)) {
      throw new SmsProviderError('invalid_response', this.id, 'The SMS provider reported a failed delivery', false, 502);
    }
    const segments = typeof response.segments === 'number' && Number.isInteger(response.segments) && response.segments >= 1
      ? response.segments
      : null;
    return {
      providerRequestId: request.requestId,
      providerMessageId,
      status: 'sent',
      segments: segments ?? 1,
      segmentsAuthoritative: segments !== null,
      providerCostUsd: providerCost(response.cost),
    };
  }

  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    operation: string,
    requestId?: string,
  ): Promise<ProviderResponse> {
    if (!this.isConfigured()) {
      throw new SmsProviderError('unauthorized', this.id, 'The SMS provider has no configured credential', false, 503);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body) headers['content-type'] = 'application/json';
      if (this.settings.apiKey) headers.authorization = `Bearer ${this.settings.apiKey}`;
      if (requestId) headers['x-request-id'] = requestId;
      const response = await this.fetchImpl(`${this.settings.baseUrl}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) throw this.httpError(response.status, operation);
      return await response.json() as ProviderResponse;
    } catch (error) {
      throw normalizeSmsProviderError(error, this.id);
    } finally {
      clearTimeout(timer);
    }
  }

  private httpError(status: number, operation: string): ProviderHttpError {
    const error = new Error(`The SMS provider rejected the ${operation} request`) as ProviderHttpError;
    error.name = 'SmsProviderHttpError';
    error.status = status;
    return error;
  }
}

function providerCost(value: unknown): string | null {
  const cost = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : null;
  if (cost === null || !Number.isFinite(cost) || cost < 0) return null;
  return cost.toFixed(8);
}

export function createHttpSmsProvider(): HttpSmsProvider {
  return new HttpSmsProvider();
}

export function httpSmsProviderSettings() {
  return {
    apiKey: config.SMS_HTTP_API_KEY,
    baseUrl: config.SMS_HTTP_BASE_URL,
    timeoutMs: config.SMS_HTTP_TIMEOUT_MS,
    sendPath: config.SMS_HTTP_SEND_PATH,
    healthPath: config.SMS_HTTP_HEALTH_PATH,
  };
}
