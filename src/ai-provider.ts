export const aiProviderKinds = ['openai-compatible'] as const;
export type AiProviderKind = typeof aiProviderKinds[number];

export type AiProviderHealthStatus = 'healthy' | 'degraded' | 'unavailable';

export type AiProviderErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'unauthorized'
  | 'invalid_request'
  | 'not_found'
  | 'unavailable'
  | 'invalid_response';

export interface AiProviderCapabilities {
  readonly chatCompletions: boolean;
  readonly streaming: boolean;
  readonly toolCalls: boolean;
  readonly systemPrompts: boolean;
  readonly maxOutputTokens: number;
  /** Providers that report prompt and completion token counts separately. */
  readonly reportsInputTokens: boolean;
  readonly reportsOutputTokens: boolean;
}

export interface AiProviderManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly kind: AiProviderKind;
  readonly capabilities: AiProviderCapabilities;
}

export interface AiProviderConfiguration {
  readonly enabled: boolean;
  /**
   * Server-side settings. Credentials are supplied from the process environment and are
   * never persisted in the database, returned by the API, or written to logs.
   */
  readonly settings: Readonly<Record<string, unknown>>;
}

export interface AiProviderHealth {
  readonly status: AiProviderHealthStatus;
  readonly message: string;
}

export interface AiChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface AiChatCompletionRequest {
  /** Stable internal request identifier used for provider idempotency and usage records. */
  readonly requestId: string;
  readonly model: string;
  readonly messages: readonly AiChatMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
}

export interface AiNormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** False when the provider did not return token counts and the caller must fall back to an estimate. */
  readonly authoritative: boolean;
}

export interface AiChatCompletion {
  readonly providerRequestId: string;
  readonly providerResponseId: string;
  readonly model: string;
  readonly finishReason: string | null;
  readonly message: AiChatMessage;
  readonly usage: AiNormalizedUsage;
}

export interface AiProviderModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number;
}

export interface AiProvider {
  readonly id: string;
  readonly manifest: AiProviderManifest;
  initialize(settings: Readonly<Record<string, unknown>>): Promise<void>;
  shutdown(): Promise<void>;
  /** True when a usable server-side credential is configured. Never exposes the credential. */
  isConfigured(): boolean;
  health(): Promise<AiProviderHealth>;
  createChatCompletion(request: AiChatCompletionRequest): Promise<AiChatCompletion>;
  listModels(): Promise<readonly AiProviderModel[]>;
}

export class AiProviderError extends Error {
  constructor(
    readonly kind: AiProviderErrorKind,
    readonly providerId: string,
    message: string,
    readonly retryable: boolean,
    readonly statusCode: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AiProviderError';
  }
}

/**
 * Canonical, non-sensitive operator messages per failure kind. Provider-supplied text is never
 * echoed back to callers or stored, so credentials or prompt content cannot leak through it.
 */
const aiProviderErrorMessages: Record<AiProviderErrorKind, string> = {
  timeout: 'The AI provider request timed out',
  rate_limited: 'The AI provider is rate limiting this deployment',
  unauthorized: 'The AI provider rejected the configured credentials',
  invalid_request: 'The AI provider rejected the request',
  not_found: 'The AI provider does not expose the requested model',
  unavailable: 'The AI provider is temporarily unavailable',
  invalid_response: 'The AI provider returned an invalid response',
};

export function aiProviderErrorMessage(kind: AiProviderErrorKind): string {
  return aiProviderErrorMessages[kind];
}

export function aiProviderErrorCode(kind: AiProviderErrorKind): string {
  return `ai_provider_${kind}`;
}

export function normalizeAiProviderError(error: unknown, providerId: string): AiProviderError {
  if (error instanceof AiProviderError) return error;
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new AiProviderError('timeout', providerId, 'The AI provider request timed out', true, 504, { cause: error });
  }
  if (name === 'AiProviderHttpError') {
    const status = Number((error as { status?: unknown }).status);
    if (status === 401 || status === 403) {
      return new AiProviderError('unauthorized', providerId, 'The AI provider rejected the configured credentials', false, 502, { cause: error });
    }
    if (status === 429) {
      return new AiProviderError('rate_limited', providerId, 'The AI provider is rate limiting this deployment', true, 503, { cause: error });
    }
    if (status === 404) {
      return new AiProviderError('not_found', providerId, 'The AI provider does not expose the requested model', false, 422, { cause: error });
    }
    if (status === 400 || status === 422) {
      return new AiProviderError('invalid_request', providerId, 'The AI provider rejected the request', false, 502, { cause: error });
    }
    if (status >= 500) {
      return new AiProviderError('unavailable', providerId, 'The AI provider is temporarily unavailable', true, 503, { cause: error });
    }
    return new AiProviderError('unavailable', providerId, 'The AI provider request failed', true, 502, { cause: error });
  }
  return new AiProviderError('unavailable', providerId, 'The AI provider request could not be completed', true, 502, { cause: error });
}
