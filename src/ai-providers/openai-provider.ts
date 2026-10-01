import { config } from '../config.js';
import {
  AiProviderError,
  normalizeAiProviderError,
  type AiChatCompletion,
  type AiChatCompletionRequest,
  type AiProvider,
  type AiProviderHealth,
  type AiProviderManifest,
  type AiProviderModel,
} from '../ai-provider.js';

type OpenAiProviderSettings = {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  organization: string;
};

type ProviderHttpError = Error & { name: 'AiProviderHttpError'; status: number; providerRequestId: string | null };

type ProviderResponse = {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
};

const manifest: AiProviderManifest = {
  id: 'openai-compatible',
  name: 'OpenAI-compatible provider',
  version: '1.0.0',
  description: 'Server-configured OpenAI-compatible chat completions endpoint',
  kind: 'openai-compatible',
  capabilities: {
    chatCompletions: true,
    streaming: false,
    toolCalls: false,
    systemPrompts: true,
    maxOutputTokens: 4096,
    reportsInputTokens: true,
    reportsOutputTokens: true,
  },
};

export class OpenAiProvider implements AiProvider {
  readonly id = 'openai-compatible';
  readonly manifest = manifest;
  private settings: OpenAiProviderSettings = {
    apiKey: '', baseUrl: 'https://api.openai.com/v1', timeoutMs: 60_000, organization: '',
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async initialize(settings: Readonly<Record<string, unknown>>): Promise<void> {
    const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
    const baseUrl = typeof settings.baseUrl === 'string' && settings.baseUrl.trim()
      ? settings.baseUrl.trim().replace(/\/+$/, '')
      : 'https://api.openai.com/v1';
    const timeoutMs = typeof settings.timeoutMs === 'number' && Number.isInteger(settings.timeoutMs) && settings.timeoutMs > 0
      ? settings.timeoutMs
      : 60_000;
    const organization = typeof settings.organization === 'string' ? settings.organization.trim() : '';
    this.settings = { apiKey, baseUrl, timeoutMs, organization };
  }

  async shutdown(): Promise<void> {}

  isConfigured(): boolean {
    return this.settings.apiKey.length > 0;
  }

  async health(): Promise<AiProviderHealth> {
    if (!this.isConfigured()) return { status: 'unavailable', message: 'Provider credential is not configured' };
    try {
      await this.requestJson('GET', '/models', undefined, 'health');
      return { status: 'healthy', message: 'Provider accepted the configured credential' };
    } catch (error) {
      const normalized = normalizeAiProviderError(error, this.id);
      if (normalized.kind === 'unauthorized') {
        return { status: 'unavailable', message: 'Provider rejected the configured credential' };
      }
      return { status: 'degraded', message: normalized.message };
    }
  }

  async listModels(): Promise<readonly AiProviderModel[]> {
    const response = await this.requestJson('GET', '/models', undefined, 'model discovery');
    if (!Array.isArray((response as { data?: unknown }).data)) {
      throw new AiProviderError('invalid_response', this.id, 'The AI provider returned an unexpected model list', false, 502);
    }
    return (response as { data: unknown[] }).data.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const value = entry as { id?: unknown; max_output_tokens?: unknown; context_window?: unknown };
      if (typeof value.id !== 'string' || !value.id.trim()) return [];
      return [{
        id: value.id.trim(),
        name: value.id.trim(),
        contextWindow: Number.isInteger(value.context_window) ? (value.context_window as number) : null,
        maxOutputTokens: Number.isInteger(value.max_output_tokens) ? (value.max_output_tokens as number) : manifest.capabilities.maxOutputTokens,
      }];
    });
  }

  async createChatCompletion(request: AiChatCompletionRequest): Promise<AiChatCompletion> {
    if (!request.messages.length) {
      throw new AiProviderError('invalid_request', this.id, 'At least one message is required', false, 400);
    }
    const maxOutputTokens = Math.min(request.maxOutputTokens, manifest.capabilities.maxOutputTokens);
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
      throw new AiProviderError('invalid_request', this.id, 'maxOutputTokens must be a positive integer', false, 400);
    }
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
      max_tokens: maxOutputTokens,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    const response = await this.requestJson('POST', '/chat/completions', body, 'chat completion', request.requestId);
    return this.normalizeCompletion(response, request);
  }

  private normalizeCompletion(response: ProviderResponse, request: AiChatCompletionRequest): AiChatCompletion {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const first = choices[0];
    const message = typeof first === 'object' && first !== null
      ? (first as { message?: unknown; finish_reason?: unknown }).message
      : null;
    const content = typeof message === 'object' && message !== null
      ? (message as { content?: unknown }).content
      : null;
    if (typeof content !== 'string' || !content.trim()) {
      throw new AiProviderError('invalid_response', this.id, 'The AI provider returned an empty completion', false, 502);
    }
    const providerResponseId = typeof response.id === 'string' && response.id.trim() ? response.id.trim() : '';
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(providerResponseId)) {
      throw new AiProviderError('invalid_response', this.id, 'The AI provider returned an invalid response identifier', false, 502);
    }
    const usage = this.normalizeUsage(response.usage);
    return {
      providerRequestId: request.requestId,
      providerResponseId,
      model: typeof response.model === 'string' && response.model.trim() ? response.model.trim() : request.model,
      finishReason: typeof (first as { finish_reason?: unknown } | undefined)?.finish_reason === 'string'
        ? ((first as { finish_reason: string }).finish_reason)
        : null,
      message: { role: 'assistant', content },
      usage,
    };
  }

  private normalizeUsage(usage: unknown) {
    const value = typeof usage === 'object' && usage !== null
      ? (usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown })
      : {};
    const inputTokens = tokenCount(value.prompt_tokens);
    const outputTokens = tokenCount(value.completion_tokens);
    const authoritative = inputTokens !== null && outputTokens !== null;
    return {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      authoritative,
    };
  }

  private async requestJson(
    method: 'GET' | 'POST',
    endpoint: string,
    body: Record<string, unknown> | undefined,
    operation: string,
    requestId?: string,
  ): Promise<ProviderResponse> {
    if (!this.isConfigured()) {
      throw new AiProviderError('unauthorized', this.id, 'The AI provider has no configured credential', false, 503);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.settings.apiKey}`,
        accept: 'application/json',
      };
      if (body) headers['content-type'] = 'application/json';
      if (this.settings.organization) headers['openai-organization'] = this.settings.organization;
      if (requestId) headers['x-request-id'] = requestId;
      const response = await this.fetchImpl(`${this.settings.baseUrl}${endpoint}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) throw this.httpError(response.status, operation);
      return await response.json() as ProviderResponse;
    } catch (error) {
      throw normalizeAiProviderError(error, this.id);
    } finally {
      clearTimeout(timer);
    }
  }

  private httpError(status: number, operation: string): ProviderHttpError {
    const error = new Error(`The AI provider rejected the ${operation} request`) as ProviderHttpError;
    error.name = 'AiProviderHttpError';
    error.status = status;
    error.providerRequestId = null;
    return error;
  }
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function createDefaultAiProvider(): OpenAiProvider {
  return new OpenAiProvider();
}

export function defaultAiProviderSettings() {
  return {
    apiKey: config.OPENAI_API_KEY,
    baseUrl: config.OPENAI_BASE_URL,
    timeoutMs: config.OPENAI_REQUEST_TIMEOUT_MS,
    organization: config.OPENAI_ORGANIZATION,
  };
}
