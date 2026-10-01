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
  /** Stable internal request identifier used for provider idempotency and request records. */
  readonly requestId: string;
  readonly to: string;
  readonly message: string;
}

export interface SmsOtpRequest {
  readonly requestId: string;
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
  /** Total provider cost in USD for this delivery when the provider reports it; otherwise null. */
  readonly providerCostUsd: string | null;
}

export interface SmsProvider {
  readonly id: string;
  readonly manifest: SmsProviderManifest;
  initialize(settings: Readonly<Record<string, unknown>>): Promise<void>;
  shutdown(): Promise<void>;
  /** True when a usable server-side credential and endpoint are configured. Never exposes the credential. */
  isConfigured(): boolean;
  health(): Promise<SmsProviderHealth>;
  sendSms(request: SmsDeliveryRequest): Promise<SmsDeliveryResult>;
  sendOtp?(request: SmsOtpRequest): Promise<SmsDeliveryResult>;
}

export class SmsProviderError extends Error {
  constructor(
    readonly kind: SmsProviderErrorKind,
    readonly providerId: string,
    message: string,
    readonly retryable: boolean,
    readonly statusCode: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SmsProviderError';
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
    if (status === 401 || status === 403) {
      return new SmsProviderError('unauthorized', providerId, 'The SMS provider rejected the configured credentials', false, 502, { cause: error });
    }
    if (status === 429) {
      return new SmsProviderError('rate_limited', providerId, 'The SMS provider is rate limiting this deployment', true, 503, { cause: error });
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
