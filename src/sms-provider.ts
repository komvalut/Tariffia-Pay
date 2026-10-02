export const smsProviderKinds = ['http-sms'] as const;
export type SmsProviderKind = typeof smsProviderKinds[number];

export type SmsProviderHealthStatus = 'healthy' | 'degraded' | 'unavailable';

export type SmsProviderErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'unauthorized'
  | 'invalid_request'
  | 'not_found'
  | 'unavailable'
  | 'invalid_response';

export interface SmsProviderCapabilities {
  readonly sendSms: boolean;
  /** Native OTP delivery: the provider generates and owns the code, so Tariffia never sees it. */
  readonly sendOtp: boolean;
  readonly maxMessageLength: number;
  /** Providers that report the actual segment count of a delivered message. */
  readonly reportsSegments: boolean;
  readonly reportsProviderCost: boolean;
  /**
   * The provider guarantees server-side deduplication of retries carrying the same stable
   * idempotency key. Only such providers make timeouts safe to retry or fall back from;
   * otherwise a timeout is ambiguous (the message may already have been accepted).
   */
  readonly idempotentRetries: boolean;
}

export interface SmsProviderManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly kind: SmsProviderKind;
  readonly capabilities: SmsProviderCapabilities;
}

export interface SmsProviderConfiguration {
  readonly enabled: boolean;
  /**
   * Server-side settings. Credentials are supplied from the process environment and are
   * never persisted in the database, returned by the API, or written to logs.
   */
  readonly settings: Readonly<Record<string, unknown>>;
}

export interface SmsProviderHealth {
  readonly status: SmsProviderHealthStatus;
  readonly message: string;
}

export interface SmsDeliveryRequest {
  /** Stable internal request identifier used for provider request records. */
  readonly requestId: string;
  /**
   * Stable idempotency key derived from the Tariffia request. It is identical across
   * every attempt and fallback of the same request; a new key is never generated
   * during a safe retry.
   */
  readonly idempotencyKey: string;
  readonly to: string;
  readonly message: string;
}

export interface SmsOtpRequest {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly to: string;
  readonly codeLength: number;
  readonly expirySeconds: number;
}

export interface SmsDeliveryResult {
  readonly providerRequestId: string;
  readonly providerMessageId: string;
  readonly status: 'sent';
  readonly segments: number;
  /** False when the provider did not report the segment count and the caller must use its estimate. */
  readonly segmentsAuthoritative: boolean;
  /** Total provider cost when the provider reports it; otherwise null. Always USD. */
  readonly providerCostUsd: string | null;
  readonly currency: 'USD';
}

export interface SmsProvider {
  readonly id: string;
  readonly manifest: SmsProviderManifest;
  initialize(settings: Readonly<Record<string, unknown>>): Promise<void>;
  shutdown(): Promise<void>;
  /** True when a usable server-side credential is configured. Never exposes the credential. */
  isConfigured(): boolean;
  health(): Promise<SmsProviderHealth>;
  sendSms(request: SmsDeliveryRequest): Promise<SmsDeliveryResult>;
  sendOtp?(request: SmsOtpRequest): Promise<SmsDeliveryResult>;
  /**
   * Optional non-secret configuration status for administrators (for example which optional
   * server-side integrations are configured). Implementations must never return secrets,
   * credentials, message content or OTP codes.
   */
  configurationStatus?(): Record<string, unknown>;
}

export class SmsProviderError extends Error {
  /** Server-provided retry hint in milliseconds when the provider supplied one (rate limiting). */
  readonly retryAfterMs?: number;

  constructor(
    readonly kind: SmsProviderErrorKind,
    readonly providerId: string,
    message: string,
    readonly retryable: boolean,
    readonly statusCode: number,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = 'SmsProviderError';
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * Canonical, non-sensitive operator messages per failure kind. Provider-supplied text is never
 * echoed back to callers or stored, so credentials, OTP codes or message content cannot leak.
 */
const smsProviderErrorMessages: Record<SmsProviderErrorKind, string> = {
  timeout: 'The SMS provider request timed out',
  rate_limited: 'The SMS provider is rate limiting this deployment',
  unauthorized: 'The SMS provider rejected the configured credentials',
  invalid_request: 'The SMS provider rejected the request',
  not_found: 'The SMS provider does not expose the requested destination',
  unavailable: 'The SMS provider is temporarily unavailable',
  invalid_response: 'The SMS provider returned an invalid response',
};

export function smsProviderErrorMessage(kind: SmsProviderErrorKind): string {
  return smsProviderErrorMessages[kind];
}

export function smsProviderErrorCode(kind: SmsProviderErrorKind): string {
  return `sms_provider_${kind}`;
}

export function normalizeSmsProviderError(error: unknown, providerId: string): SmsProviderError {
  if (error instanceof SmsProviderError) return error;
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new SmsProviderError('timeout', providerId, 'The SMS provider request timed out', true, 504, { cause: error });
  }
  if (name === 'SmsProviderHttpError') {
    const status = Number((error as { status?: unknown }).status);
    const retryAfterMs = retryAfterHint((error as { retryAfterMs?: unknown }).retryAfterMs);
    if (status === 401 || status === 403) {
      return new SmsProviderError('unauthorized', providerId, 'The SMS provider rejected the configured credentials', false, 502, { cause: error });
    }
    if (status === 429) {
      return new SmsProviderError('rate_limited', providerId, 'The SMS provider is rate limiting this deployment', true, 503, { cause: error, retryAfterMs });
    }
    if (status === 404) {
      return new SmsProviderError('not_found', providerId, 'The SMS provider does not expose the requested destination', false, 422, { cause: error });
    }
    if (status === 400 || status === 422) {
      return new SmsProviderError('invalid_request', providerId, 'The SMS provider rejected the request', false, 502, { cause: error });
    }
    if (status >= 500) {
      return new SmsProviderError('unavailable', providerId, 'The SMS provider is temporarily unavailable', true, 503, { cause: error });
    }
    return new SmsProviderError('unavailable', providerId, 'The SMS provider request failed', true, 502, { cause: error });
  }
  return new SmsProviderError('unavailable', providerId, 'The SMS provider request could not be completed', true, 502, { cause: error });
}

function retryAfterHint(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 300_000
    ? Math.round(value)
    : undefined;
}
