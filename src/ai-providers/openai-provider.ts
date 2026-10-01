import { config } from '../config.js';
import {
  AiProviderError,
  normalizeAiProviderError,
  type AiChatCompletion,
  type AiChatCompletionRequest,
  type AiChatCompletionStream,
  type AiProvider,
  type AiProviderHealth,
  type AiProviderManifest,
  type AiProviderModel,
  type AiStreamEvent,
  type AiToolCall,
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
    streaming: true,
    toolCalls: true,
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
    const body = this.completionBody(request);
    const response = await this.requestJson('POST', '/chat/completions', body, 'chat completion', request.requestId);
    return this.normalizeCompletion(response, request);
  }

  async createChatCompletionStream(request: AiChatCompletionRequest): Promise<AiChatCompletionStream> {
    const body = this.completionBody(request, { stream: true });
    if (!this.isConfigured()) {
      throw new AiProviderError('unauthorized', this.id, 'The AI provider has no configured credential', false, 503);
    }
    // Errors before the first event (connection, HTTP status, timeouts) throw here; the caller
    // has not yet forwarded anything to its client. The fetch signal is owned by the returned
    // stream so a later abort terminates the provider request itself.
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.requestHeaders(true, request.requestId),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw this.httpError(response.status, 'chat completion stream');
      if (!response.body) {
        throw new AiProviderError('invalid_response', this.id, 'The AI provider returned no stream body', false, 502);
      }
    } catch (error) {
      throw normalizeAiProviderError(error, this.id);
    } finally {
      clearTimeout(connectTimer);
    }
    return this.createStreamHandle(response, controller, request);
  }

  private completionBody(request: AiChatCompletionRequest, extra: { stream?: boolean } = {}): Record<string, unknown> {
    if (!request.messages.length) {
      throw new AiProviderError('invalid_request', this.id, 'At least one message is required', false, 400);
    }
    const maxOutputTokens = Math.min(request.maxOutputTokens, manifest.capabilities.maxOutputTokens);
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
      throw new AiProviderError('invalid_request', this.id, 'maxOutputTokens must be a positive integer', false, 400);
    }
    if (request.tools?.length && !manifest.capabilities.toolCalls) {
      throw new AiProviderError('invalid_request', this.id, 'The AI provider does not support tool calls', false, 400);
    }
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => this.messageBody(message)),
      max_tokens: maxOutputTokens,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({ type: 'function', function: { ...tool.function } }));
      if (request.toolChoice) body.tool_choice = request.toolChoice;
    }
    if (extra.stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  private messageBody(message: AiChatCompletionRequest['messages'][number]): Record<string, unknown> {
    const body: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.toolCallId !== undefined) body.tool_call_id = message.toolCallId;
    if (message.name !== undefined) body.name = message.name;
    if (message.toolCalls?.length) body.tool_calls = message.toolCalls.map((call) => this.toolCallBody(call));
    return body;
  }

  private toolCallBody(call: AiToolCall): Record<string, unknown> {
    return { id: call.id, type: call.type, function: { name: call.function.name, arguments: call.function.arguments } };
  }

  private normalizeCompletion(response: ProviderResponse, request: AiChatCompletionRequest): AiChatCompletion {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const first = choices[0];
    const message = typeof first === 'object' && first !== null
      ? (first as { message?: unknown; finish_reason?: unknown }).message
      : null;
    const record = typeof message === 'object' && message !== null
      ? (message as { content?: unknown; tool_calls?: unknown })
      : {};
    const toolCalls = this.normalizeToolCalls(record.tool_calls);
    const content = typeof record.content === 'string' ? record.content : '';
    if (!content.trim() && !toolCalls.length) {
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
      toolCalls,
    };
  }

  /** Normalizes provider tool calls. Tariffia never interprets, follows or executes them. */
  private normalizeToolCalls(value: unknown): AiToolCall[] {
    if (!Array.isArray(value)) return [];
    const calls: AiToolCall[] = [];
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue;
      const call = entry as { id?: unknown; type?: unknown; function?: unknown };
      const fn = typeof call.function === 'object' && call.function !== null
        ? (call.function as { name?: unknown; arguments?: unknown })
        : {};
      if (typeof call.id !== 'string' || !call.id.trim() ||
          call.type !== 'function' || typeof fn.name !== 'string' || !fn.name.trim() ||
          typeof fn.arguments !== 'string') continue;
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(call.id) || fn.name.length > 120 || fn.arguments.length > 16_000) continue;
      calls.push({
        id: call.id,
        type: 'function',
        function: { name: fn.name, arguments: fn.arguments },
      });
    }
    return calls;
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
      const response = await this.fetchImpl(`${this.settings.baseUrl}${endpoint}`, {
        method,
        headers: this.requestHeaders(body !== undefined, requestId),
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

  private requestHeaders(hasBody: boolean, requestId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.settings.apiKey}`,
      accept: 'application/json',
    };
    if (hasBody) headers['content-type'] = 'application/json';
    if (this.settings.organization) headers['openai-organization'] = this.settings.organization;
    if (requestId) headers['x-request-id'] = requestId;
    return headers;
  }

  /**
   * Parses the provider SSE body into normalized events. The timeout acts as an idle
   * deadline: the provider may stream for as long as it keeps producing data, but a
   * silent connection is aborted after the configured timeout. Aborting the handle
   * aborts the underlying provider request.
   */
  private createStreamHandle(
    response: Response,
    controller: AbortController,
    request: AiChatCompletionRequest,
  ): AiChatCompletionStream {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    const state = { providerResponseId: request.requestId };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    };
    const release = () => {
      clearTimeout(idleTimer);
      if (!released) {
        released = true;
        void response.body?.cancel().catch(() => undefined);
      }
    };
    const self = this;
    async function* events(): AsyncGenerator<AiStreamEvent> {
      const decoder = new TextDecoder();
      let buffer = '';
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      let finishReason: string | null = null;
      let usage: AiStreamEvent | null = null;
      try {
        armIdleTimer();
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdleTimer();
          buffer += decoder.decode(value, { stream: true });
          let separator = buffer.indexOf('\n');
          while (separator >= 0) {
            const line = buffer.slice(0, separator).trim();
            buffer = buffer.slice(separator + 1);
            separator = buffer.indexOf('\n');
            if (!line || line.startsWith(':')) continue;
            if (!line.startsWith('data:')) {
              throw new AiProviderError('invalid_response', self.id, 'The AI provider returned an invalid stream', false, 502);
            }
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(payload);
            } catch {
              throw new AiProviderError('invalid_response', self.id, 'The AI provider returned an invalid stream event', false, 502);
            }
            if (typeof parsed === 'object' && parsed !== null && 'id' in parsed &&
                typeof (parsed as { id?: unknown }).id === 'string') {
              const id = (parsed as { id: string }).id.trim();
              if (/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) state.providerResponseId = id;
            }
            for (const event of self.streamEvents(parsed, toolCalls)) {
              if (event.type === 'usage') usage = event;
              else if (event.type === 'finish') finishReason = event.finishReason;
              else yield event;
            }
          }
        }
        for (const call of self.sortedToolCalls(toolCalls)) {
          yield { type: 'tool_call', toolCall: self.toolCall(call) };
        }
        if (usage) yield usage;
        yield { type: 'finish', finishReason };
      } catch (error) {
        throw normalizeAiProviderError(error, self.id);
      } finally {
        release();
      }
    }
    return {
      providerRequestId: request.requestId,
      get providerResponseId() { return state.providerResponseId; },
      events: () => events(),
      abort() {
        controller.abort();
        release();
      },
    };
  }

  /** Maps one provider SSE payload into normalized events; accumulates tool-call deltas. */
  private streamEvents(
    payload: unknown,
    toolCalls: Map<number, { id: string; name: string; arguments: string }>,
  ): AiStreamEvent[] {
    const events: AiStreamEvent[] = [];
    const record = typeof payload === 'object' && payload !== null
      ? (payload as { choices?: unknown; usage?: unknown })
      : {};
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const first = choices[0];
    if (typeof first === 'object' && first !== null) {
      const choice = first as { delta?: unknown; finish_reason?: unknown };
      const delta = typeof choice.delta === 'object' && choice.delta !== null
        ? (choice.delta as { content?: unknown; tool_calls?: unknown })
        : {};
      if (typeof delta.content === 'string' && delta.content.length) {
        events.push({ type: 'chunk', content: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const entry of delta.tool_calls) {
          if (typeof entry !== 'object' || entry === null) continue;
          const deltaCall = entry as { index?: unknown; id?: unknown; function?: unknown };
          const fn = typeof deltaCall.function === 'object' && deltaCall.function !== null
            ? (deltaCall.function as { name?: unknown; arguments?: unknown })
            : {};
          if (typeof deltaCall.index !== 'number' || !Number.isInteger(deltaCall.index) ||
              deltaCall.index < 0 || deltaCall.index > 127) continue;
          const existing = toolCalls.get(deltaCall.index) ?? { id: '', name: '', arguments: '' };
          if (typeof deltaCall.id === 'string' && deltaCall.id.trim()) existing.id = deltaCall.id.trim();
          if (typeof fn.name === 'string' && fn.name.length) existing.name += fn.name;
          if (typeof fn.arguments === 'string') existing.arguments += fn.arguments;
          toolCalls.set(deltaCall.index, existing);
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        events.push({ type: 'finish', finishReason: choice.finish_reason });
      }
    }
    if (record.usage !== undefined) {
      const usage = this.normalizeUsage(record.usage);
      if (usage.authoritative) events.push({ type: 'usage', usage });
    }
    return events;
  }

  private sortedToolCalls(toolCalls: Map<number, { id: string; name: string; arguments: string }>) {
    return [...toolCalls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, call]) => call)
      .filter((call) => call.id && call.name && /^[A-Za-z0-9_.:-]{1,128}$/.test(call.id) &&
        call.name.length <= 120 && call.arguments.length <= 16_000);
  }

  private toolCall(call: { id: string; name: string; arguments: string }): AiToolCall {
    return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
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
