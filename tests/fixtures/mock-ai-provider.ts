import {
  AiProviderError,
  type AiChatCompletion,
  type AiChatCompletionRequest,
  type AiChatCompletionStream,
  type AiProviderHealth,
  type AiProviderModel,
  type AiStreamEvent,
  type AiToolCall,
} from '../../src/ai-provider.js';

type MockOptions = {
  content?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Set to omit usage entirely so the caller must fall back to an estimate. */
  omitUsage?: boolean;
  failure?: AiProviderError;
  models?: readonly AiProviderModel[];
  health?: AiProviderHealth;
  configured?: boolean;
  streaming?: boolean;
  /** Chunks emitted by the streaming path. Defaults to a single chunk with `content`. */
  streamChunks?: string[];
  /** Fails the stream after the given number of chunks. */
  streamFailureAfter?: number;
  streamFailure?: AiProviderError;
  toolCalls?: readonly AiToolCall[];
  /** Stalls the stream so an idle-timeout abort can be observed. */
  stallAfter?: number;
  /** Artificial delay between chunks so mid-stream aborts can be observed deterministically. */
  interChunkDelayMs?: number;
};

function abortError(reason: string): Error {
  const error = new Error(reason);
  error.name = 'AbortError';
  return error;
}

export class MockAiProvider {
  readonly id = 'mock-ai';
  readonly manifest = {
    id: 'mock-ai',
    name: 'Mock AI provider',
    version: '1.0.0',
    description: 'Deterministic provider used by the AI integration tests',
    kind: 'openai-compatible' as const,
    capabilities: {
      chatCompletions: true, streaming: true, toolCalls: true, systemPrompts: true,
      maxOutputTokens: 1024, reportsInputTokens: true, reportsOutputTokens: true,
    },
  };
  readonly completions: AiChatCompletionRequest[] = [];
  readonly streamRequests: AiChatCompletionRequest[] = [];
  readonly initializations: Array<Record<string, unknown>> = [];
  initialized = false;
  shutDown = false;
  healthChecks = 0;
  listModelsCalls = 0;
  streamAborts: string[] = [];
  options: MockOptions = {};

  async initialize(settings: Readonly<Record<string, unknown>>): Promise<void> {
    this.initializations.push({ ...settings });
    this.initialized = true;
    if (this.options.streaming === false) {
      this.manifest.capabilities.streaming = false;
    }
  }

  async shutdown(): Promise<void> {
    this.shutDown = true;
  }

  isConfigured(): boolean {
    return this.options.configured ?? true;
  }

  async health(): Promise<AiProviderHealth> {
    this.healthChecks += 1;
    return this.options.health ?? { status: 'healthy', message: 'Mock provider is ready' };
  }

  async listModels(): Promise<readonly AiProviderModel[]> {
    this.listModelsCalls += 1;
    if (this.options.failure) throw this.options.failure;
    return this.options.models ?? [
      { id: 'mock-small', name: 'Mock Small', contextWindow: 8_000, maxOutputTokens: 512 },
    ];
  }

  async createChatCompletion(request: AiChatCompletionRequest): Promise<AiChatCompletion> {
    this.completions.push(request);
    if (this.options.failure) throw this.options.failure;
    const inputTokens = this.options.inputTokens ?? 1_000;
    const outputTokens = this.options.outputTokens ?? 250;
    return {
      providerRequestId: request.requestId,
      providerResponseId: 'resp_mock_0001',
      model: request.model,
      finishReason: this.options.finishReason ?? 'stop',
      message: { role: 'assistant', content: this.options.content ?? 'Mock completion' },
      usage: this.options.omitUsage
        ? { inputTokens: 0, outputTokens: 0, authoritative: false }
        : { inputTokens, outputTokens, authoritative: true },
      toolCalls: this.options.toolCalls ? [...this.options.toolCalls] : [],
    };
  }

  async createChatCompletionStream(request: AiChatCompletionRequest): Promise<AiChatCompletionStream> {
    this.streamRequests.push(request);
    if (this.options.failure) throw this.options.failure;
    const chunks = this.options.streamChunks ?? [this.options.content ?? 'Mock stream completion'];
    const toolCalls = this.options.toolCalls ? [...this.options.toolCalls] : [];
    const provider = this;
    let aborted = false;
    const handle: AiChatCompletionStream = {
      providerRequestId: request.requestId,
      providerResponseId: 'resp_mock_stream_0001',
      events: () => provider.streamEvents(chunks, toolCalls, () => aborted),
      abort(reason) {
        aborted = true;
        provider.streamAborts.push(reason ?? 'aborted');
      },
    };
    return handle;
  }

  private async *streamEvents(
    chunks: string[],
    toolCalls: AiToolCall[],
    isAborted: () => boolean,
  ): AsyncGenerator<AiStreamEvent> {
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0 && this.options.interChunkDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.options.interChunkDelayMs));
      }
      if (isAborted()) throw abortError('stream aborted by the client');
      if (this.options.streamFailureAfter === index) throw this.options.streamFailure;
      if (this.options.stallAfter === index) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      yield { type: 'chunk', content: chunk };
    }
    if (isAborted()) throw abortError('stream aborted by the client');
    for (const toolCall of toolCalls) {
      yield { type: 'tool_call', toolCall };
    }
    if (!this.options.omitUsage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: this.options.inputTokens ?? 1_000,
          outputTokens: this.options.outputTokens ?? 250,
          authoritative: true,
        },
      };
    }
    yield { type: 'finish', finishReason: this.options.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop') };
  }
}
