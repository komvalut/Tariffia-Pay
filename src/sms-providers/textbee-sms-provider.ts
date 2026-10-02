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

type TextBeeSettings = {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  deviceId: string;
  simSubscriptionId: number;
};

type ProviderHttpError = Error & { name: 'SmsProviderHttpError'; status: number; retryAfterMs?: number };

type TextBeeEnvelope = { data?: unknown };

type TextBeeSendResult = {
  success?: unknown;
  message?: unknown;
  smsBatchId?: unknown;
  recipientCount?: unknown;
  successCount?: unknown;
  failureCount?: unknown;
};

type TextBeeDevice = {
  _id?: unknown;
  enabled?: unknown;
};

const manifest: SmsProviderManifest = {
  id: 'textbee',
  name: 'TextBee',
  version: '1.0.0',
  description: 'TextBee Android SMS gateway (https://textbee.dev) with x-api-key authentication',
  kind: 'http-sms',
  capabilities: {
    sendSms: true,
    // TextBee documents a plain send endpoint only; Tariffia renders OTP messages server-side.
    sendOtp: false,
    maxMessageLength: 1600,
    // The documented send response carries no segment count (long messages are split by the
    // carrier), so Tariffia's own estimate stays authoritative-marked as estimated.
    reportsSegments: false,
    // The TextBee API reports no per-message provider cost.
    reportsProviderCost: false,
    // The documented send request has no idempotency key and the API documents no request
    // deduplication, so a timeout is an ambiguous outcome and is never retried.
    idempotentRetries: false,
  },
};

const e164 = /^\+[1-9]\d{7,14}$/;
const providerIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

export class TextBeeSmsProvider implements SmsProvider {
  readonly id = 'textbee';
  readonly manifest = manifest;
  private settings: TextBeeSettings = {
    apiKey: '', baseUrl: 'https://api.textbee.dev/api/v1', timeoutMs: 30_000, deviceId: '', simSubscriptionId: 0,
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async initialize(settings: Readonly<Record<string, unknown>>): Promise<void> {
    const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
    const baseUrl = typeof settings.baseUrl === 'string' && settings.baseUrl.trim()
      ? settings.baseUrl.trim().replace(/\/+$/, '')
      : 'https://api.textbee.dev/api/v1';
    const timeoutMs = typeof settings.timeoutMs === 'number' && Number.isInteger(settings.timeoutMs) && settings.timeoutMs > 0
      ? settings.timeoutMs
      : 30_000;
    const deviceId = typeof settings.deviceId === 'string' ? settings.deviceId.trim() : '';
    const simSubscriptionId = typeof settings.simSubscriptionId === 'number' && Number.isInteger(settings.simSubscriptionId) && settings.simSubscriptionId > 0
      ? settings.simSubscriptionId
      : 0;
    this.settings = { apiKey, baseUrl, timeoutMs, deviceId, simSubscriptionId };
  }

  async shutdown(): Promise<void> {}

  isConfigured(): boolean {
    return this.settings.apiKey.length > 0;
  }

  configurationStatus(): Record<string, unknown> {
    return {
      deviceIdConfigured: this.settings.deviceId.length > 0,
      simSubscriptionConfigured: this.settings.simSubscriptionId > 0,
    };
  }

  /**
   * Read-only health check against the documented devices endpoint. It never sends an SMS.
   * A configured device must exist and be enabled on the account; without a configured
   * device, at least one enabled device must exist. Heartbeat recency is not judged:
   * TextBee documents it only as a hint that a silent device "is likely offline".
   */
  async health(): Promise<SmsProviderHealth> {
    if (!this.isConfigured()) {
      return { status: 'unavailable', message: 'Provider credential is not configured' };
    }
    let devices: TextBeeDevice[];
    try {
      const response = await this.requestJson('GET', '/gateway/devices');
      devices = this.parseDevices(response);
    } catch (error) {
      const normalized = normalizeSmsProviderError(error, this.id);
      if (normalized.kind === 'unauthorized') {
        return { status: 'unavailable', message: 'Provider rejected the configured credential' };
      }
      return { status: 'degraded', message: normalized.message };
    }
    if (this.settings.deviceId) {
      const device = devices.find((entry) => entry._id === this.settings.deviceId);
      if (!device) return { status: 'unavailable', message: 'The configured device is not available on this account' };
      if (device.enabled !== true) return { status: 'unavailable', message: 'The configured device is disabled' };
      return { status: 'healthy', message: 'Provider accepted the configured credential and the device is enabled' };
    }
    if (!devices.some((device) => device.enabled === true)) {
      return { status: 'unavailable', message: 'No enabled device is available on this account' };
    }
    return { status: 'healthy', message: 'Provider accepted the configured credential and an enabled device is available' };
  }

  async sendSms(request: SmsDeliveryRequest): Promise<SmsDeliveryResult> {
    if (!e164.test(request.to)) {
      throw new SmsProviderError('invalid_request', this.id, 'The destination must be an E.164 phone number', false, 400);
    }
    if (!request.message.trim() || request.message.length > manifest.capabilities.maxMessageLength) {
      throw new SmsProviderError('invalid_request', this.id, 'The message length is not supported', false, 400);
    }
    // Only documented fields are sent: recipients, message, and the optional configured
    // device/SIM. TextBee documents no idempotency key for the send operation.
    const body: Record<string, unknown> = {
      recipients: [request.to],
      message: request.message,
    };
    if (this.settings.deviceId) body.deviceId = this.settings.deviceId;
    if (this.settings.simSubscriptionId > 0) body.simSubscriptionId = this.settings.simSubscriptionId;
    const response = await this.requestJson('POST', '/gateway/send-sms', body, 'sms delivery');
    return this.normalizeSend(response, request);
  }

  async sendOtp(_request: SmsOtpRequest): Promise<SmsDeliveryResult> {
    throw new SmsProviderError('invalid_request', this.id, 'The provider does not support native OTP delivery', false, 400);
  }

  /**
   * Normalizes the documented send outcomes. A queued send returns `smsBatchId`
   * (used as the provider message identifier). An immediately dispatched send returns
   * `successCount`/`failureCount` instead, with no batch identifier. Anything else is an
   * ambiguous result: the send is treated as invalid and never retried.
   */
  private normalizeSend(response: TextBeeEnvelope, request: SmsDeliveryRequest): SmsDeliveryResult {
    const record = typeof response.data === 'object' && response.data !== null
      ? (response.data as TextBeeSendResult)
      : {};
    if (record.success === false) {
      throw new SmsProviderError('unavailable', this.id, 'The SMS provider did not accept the send', true, 503);
    }
    const smsBatchId = typeof record.smsBatchId === 'string' ? record.smsBatchId.trim() : '';
    if (smsBatchId) {
      if (!providerIdPattern.test(smsBatchId)) {
        throw new SmsProviderError('invalid_response', this.id, 'The SMS provider returned an invalid batch identifier', false, 502);
      }
      return this.delivery(request, smsBatchId);
    }
    const successCount = nonNegativeInteger(record.successCount);
    const failureCount = nonNegativeInteger(record.failureCount);
    if (successCount !== null && successCount >= 1) {
      // Immediately dispatched: accepted, but TextBee provides no identifier for it.
      return this.delivery(request, '');
    }
    if (successCount === 0 && failureCount !== null && failureCount >= 1) {
      // Definitively not pushed to the device: safe to retry or fall back.
      throw new SmsProviderError('unavailable', this.id, 'The SMS provider could not deliver the message to the device', true, 503);
    }
    throw new SmsProviderError('invalid_response', this.id, 'The SMS provider returned an ambiguous send result', false, 502);
  }

  private delivery(request: SmsDeliveryRequest, providerMessageId: string): SmsDeliveryResult {
    return {
      providerRequestId: request.idempotencyKey,
      providerMessageId,
      status: 'sent',
      // TextBee reports no segment count; Tariffia's estimate settles the charge.
      segments: 1,
      segmentsAuthoritative: false,
      providerCostUsd: null,
      currency: 'USD',
    };
  }

  /** DeviceListResponseDTO is `{ data: DeviceDTO[] }`; anything else is invalid. */
  private parseDevices(response: TextBeeEnvelope): TextBeeDevice[] {
    if (!Array.isArray(response.data)) {
      throw new SmsProviderError('invalid_response', this.id, 'The SMS provider returned an invalid device list', false, 502);
    }
    return response.data.filter((entry): entry is TextBeeDevice =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry));
  }

  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    operation?: string,
  ): Promise<TextBeeEnvelope> {
    if (!this.isConfigured()) {
      throw new SmsProviderError('unauthorized', this.id, 'The SMS provider has no configured credential', false, 503);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'x-api-key': this.settings.apiKey,
        accept: 'application/json',
      };
      if (body) headers['content-type'] = 'application/json';
      const response = await this.fetchImpl(`${this.settings.baseUrl}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw this.httpError(response.status, operation ?? 'api request', response.headers.get('retry-after'));
      }
      return await response.json() as TextBeeEnvelope;
    } catch (error) {
      throw normalizeSmsProviderError(error, this.id);
    } finally {
      clearTimeout(timer);
    }
  }

  private httpError(status: number, operation: string, retryAfter?: string | null): ProviderHttpError {
    const error = new Error(`The SMS provider rejected the ${operation} request`) as ProviderHttpError;
    error.name = 'SmsProviderHttpError';
    error.status = status;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 300) error.retryAfterMs = Math.round(seconds * 1000);
    return error;
  }
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function createTextBeeSmsProvider(): TextBeeSmsProvider {
  return new TextBeeSmsProvider();
}

export function textBeeProviderSettings() {
  return {
    apiKey: config.TEXTBEE_API_KEY,
    baseUrl: config.TEXTBEE_BASE_URL,
    timeoutMs: config.TEXTBEE_TIMEOUT_MS,
    deviceId: config.TEXTBEE_DEVICE_ID,
    simSubscriptionId: config.TEXTBEE_SIM_SUBSCRIPTION_ID,
  };
}
