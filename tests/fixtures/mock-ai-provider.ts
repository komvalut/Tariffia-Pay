import { AiProviderError, type AiChatCompletion, type AiChatCompletionRequest, type AiProviderHealth, type AiProviderModel } from '../../src/ai-provider.js';

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
};

export class MockAiProvider {
  readonly id = 'mock-ai';
  readonly manifest = {
    id: 'mock-ai',
    name: 'Mock AI provider',
    version: '1.0.0',
    description: 'Deterministic provider used by the AI integration tests',
    kind: 'openai-compatible' as const,
    capabilities: {
      chatCompletions: true, streaming: false, toolCalls: false, systemPrompts: true,
      maxOutputTokens: 1024, reportsInputTokens: true, reportsOutputTokens: true,
    },
  };
  readonly completions: AiChatCompletionRequest[] = [];
  readonly initializations: Array<Record<string, unknown>> = [];
  initialized = false;
  shutDown = false;
  healthChecks = 0;
  listModelsCalls = 0;
  options: MockOptions = {};

  async initialize(settings: Readonly<Record<string, unknown>>): Promise<void> {
    this.initializations.push({ ...settings });
    this.initialized = true;
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
    };
  }
}
