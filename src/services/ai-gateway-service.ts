import type { PoolClient } from 'pg';
import { config } from '../config.js';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import {
  AiProviderError,
  aiProviderErrorCode,
  aiProviderErrorMessage,
  normalizeAiProviderError,
  type AiProvider,
  type AiStreamEvent,
  type AiToolCall,
  type AiToolDefinition,
} from '../ai-provider.js';
import type { AiProviderRegistry } from '../ai-providers/registry.js';
import { newId } from '../security.js';
import { enqueueWebhookEvent } from '../webhooks/outbox.js';
import {
  calculateAiUsagePrice,
  creditUnitsForPrice,
  type AiPricedModel,
  type AiPricingEngine,
} from './ai-pricing-engine.js';

export type AiChatRequest = {
  merchantId: string;
  customerId: string;
  provider: string;
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolCallId?: string;
    name?: string;
    toolCalls?: readonly AiToolCall[];
  }>;
  maxOutputTokens: number;
  temperature?: number;
  tools?: readonly AiToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  metadata: Record<string, unknown>;
  requestId: string;
};

/** Normalized events forwarded to a streaming client, in arrival order. */
export type AiGatewayStreamEvent =
  | { type: 'chunk'; content: string }
  | { type: 'tool_call'; toolCall: AiToolCall }
  | { type: 'finish'; finishReason: string | null }
  | {
    type: 'done';
    request: {
      id: string;
      requestId: string;
      customerId: string;
      provider: string;
      model: string;
      providerRequestId: string;
      providerResponseId: string;
      finishReason: string | null;
      latencyMs: number;
      toolCallCount: number;
      chargeCapped: boolean;
    };
    usage: {
      id: string;
      requestId: string;
      pricingMode: 'PER_REQUEST' | 'PER_1K_TOKENS' | 'PER_REQUEST_AND_TOKENS';
      inputTokens: number;
      outputTokens: number;
      customerPriceUsd: string;
      creditsDeducted: string;
      balanceAfter: string;
      currency: 'CREDITS';
      usageSource: 'provider' | 'estimated';
    };
  }
  | { type: 'error'; error: string; message: string };

export type AiStreamOutput = {
  /** Called for every normalized event as it becomes available. Never logged. */
  write: (event: AiGatewayStreamEvent) => void;
  /** Aborted by the caller when the merchant client disconnects. */
  signal?: AbortSignal;
};

export type PreparedAiStream = {
  run(output: AiStreamOutput): Promise<void>;
};

/** Conservative token estimate used only to bound the pre-authorization. Never billed. */
export function estimatePromptTokens(messages: readonly { content: string }[]): number {
  let characters = 0;
  for (const message of messages) characters += message.content.length;
  return Math.max(1, Math.ceil(characters / 4));
}

/** Conservative token estimate for streamed output; only received content is counted. */
export function estimateOutputTokens(content: string, maxOutputTokens: number): number {
  return Math.min(Math.max(1, Math.ceil(content.length / 4)), maxOutputTokens);
}

export class AiGatewayService {
  constructor(
    private readonly db: Database,
    private readonly pricing: AiPricingEngine,
    private readonly providers: AiProviderRegistry,
  ) {}

  async createChatCompletion(request: AiChatRequest) {
    const { estimatedInputTokens, maxOutputTokens } = this.validateRequest(request);

    // Authorize the worst case before any provider call, then settle only the authoritative cost.
    const authorization = await this.authorize(request, maxOutputTokens, estimatedInputTokens);
    const provider = await this.resolveProvider(authorization);
    const providerModel = authorization.model.provider_model || authorization.model.model_slug;

    const startedAt = Date.now();
    let completion;
    try {
      completion = await provider.createChatCompletion({
        requestId: request.requestId,
        model: providerModel,
        messages: request.messages,
        maxOutputTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.tools?.length ? { tools: request.tools } : {}),
        ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
      });
    } catch (error) {
      await this.failRequest(authorization.providerRequestId, error, Date.now() - startedAt);
      throw this.toHttpError(error);
    }

    const inputTokens = completion.usage.authoritative ? completion.usage.inputTokens : estimatedInputTokens;
    const outputTokens = completion.usage.authoritative
      ? completion.usage.outputTokens
      : Math.min(maxOutputTokens, config.AI_MAX_OUTPUT_TOKENS);
    const settled = await this.settle(authorization, {
      inputTokens,
      outputTokens,
      usageAuthoritative: completion.usage.authoritative,
      providerRequestId: completion.providerRequestId,
      providerResponseId: completion.providerResponseId,
      finishReason: completion.finishReason,
      latencyMs: Date.now() - startedAt,
      content: completion.message.content,
      toolCalls: completion.toolCalls,
    });
    return {
      status: 201,
      body: {
        request: {
          id: authorization.providerRequestId,
          requestId: authorization.requestId,
          customerId: authorization.customerId,
          provider: authorization.model.provider_slug,
          model: authorization.model.model_slug,
          providerRequestId: completion.providerRequestId,
          providerResponseId: completion.providerResponseId,
          finishReason: completion.finishReason,
          latencyMs: Date.now() - startedAt,
          toolCallCount: completion.toolCalls.length,
          message: { role: 'assistant' as const, content: completion.message.content },
          ...(completion.toolCalls.length ? { toolCalls: completion.toolCalls } : {}),
        },
        usage: {
          ...settled.usage,
          usageSource: completion.usage.authoritative ? 'provider' : 'estimated',
        },
      },
    };
  }

  /**
   * Validates and authorizes a streaming request. Throws bounded HTTP errors before any
   * provider call or stream output; the returned handle owns the stream lifecycle.
   */
  async prepareChatCompletionStream(request: AiChatRequest): Promise<PreparedAiStream> {
    const { estimatedInputTokens, maxOutputTokens } = this.validateRequest(request);
    const authorization = await this.authorize(request, maxOutputTokens, estimatedInputTokens);
    const provider = await this.resolveProvider(authorization);
    if (!provider.manifest.capabilities.streaming || !provider.createChatCompletionStream) {
      const error = new AiProviderError('invalid_request', provider.id, 'The AI provider does not support streaming', false, 501);
      await this.failRequest(authorization.providerRequestId, error, 0);
      throw this.toHttpError(error);
    }
    const providerModel = authorization.model.provider_model || authorization.model.model_slug;
    const worstCase = calculateAiUsagePrice(authorization.model, estimatedInputTokens, maxOutputTokens);

    return {
      run: (output) => this.runStream(request, output, {
        authorization, provider, providerModel, maxOutputTokens, estimatedInputTokens, worstCase,
      }),
    };
  }

  private async runStream(
    request: AiChatRequest,
    output: AiStreamOutput,
    prepared: {
      authorization: Awaited<ReturnType<AiGatewayService['authorize']>>;
      provider: AiProvider;
      providerModel: string;
      maxOutputTokens: number;
      estimatedInputTokens: number;
      worstCase: ReturnType<typeof calculateAiUsagePrice>;
    },
  ): Promise<void> {
    const { authorization, provider, providerModel, maxOutputTokens, estimatedInputTokens, worstCase } = prepared;
    const startedAt = Date.now();
    let disconnected = false;
    const onAbort = () => {
      disconnected = true;
      stream?.abort('client_disconnected');
    };
    output.signal?.addEventListener('abort', onAbort, { once: true });

    let stream: Awaited<ReturnType<NonNullable<typeof provider.createChatCompletionStream>>> | undefined;
    try {
      stream = await provider.createChatCompletionStream!({
        requestId: request.requestId,
        model: providerModel,
        messages: request.messages,
        maxOutputTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.tools?.length ? { tools: request.tools } : {}),
        ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
      });
    } catch (error) {
      output.signal?.removeEventListener('abort', onAbort);
      await this.failRequest(authorization.providerRequestId, error, Date.now() - startedAt);
      output.write(this.errorEvent(error));
      return;
    }

    let content = '';
    const toolCalls: AiToolCall[] = [];
    let finishReason: string | null = null;
    let usage: { inputTokens: number; outputTokens: number; authoritative: boolean } | null = null;
    try {
      for await (const event of stream.events()) {
        const streamEvent = event as AiStreamEvent;
        if (streamEvent.type === 'chunk') {
          content += streamEvent.content;
          output.write({ type: 'chunk', content: streamEvent.content });
        } else if (streamEvent.type === 'tool_call') {
          toolCalls.push(streamEvent.toolCall);
          output.write({ type: 'tool_call', toolCall: streamEvent.toolCall });
        } else if (streamEvent.type === 'usage') {
          usage = streamEvent.usage;
        } else if (streamEvent.type === 'finish') {
          finishReason = streamEvent.finishReason;
        }
      }
    } catch (error) {
      output.signal?.removeEventListener('abort', onAbort);
      if (disconnected) {
        // The client disconnected: terminate the provider request and settle nothing.
        // A failed/incomplete provider request never creates a successful usage charge.
        await this.failRequest(
          authorization.providerRequestId,
          error,
          Date.now() - startedAt,
          { failureKind: 'client_disconnected', failureMessage: 'The client disconnected before the stream completed' },
        );
        return;
      }
      await this.failRequest(authorization.providerRequestId, error, Date.now() - startedAt);
      output.write(this.errorEvent(error));
      return;
    }
    output.signal?.removeEventListener('abort', onAbort);
    output.write({ type: 'finish', finishReason });

    const authoritative = usage?.authoritative === true;
    const inputTokens = authoritative && usage ? usage.inputTokens : estimatedInputTokens;
    const outputTokens = authoritative && usage ? usage.outputTokens : estimateOutputTokens(content, maxOutputTokens);

    // Never settle more than the authorized maximum: cap the charge at the worst case
    // that was authorized before the provider call, while recording the actual usage.
    let settled: Awaited<ReturnType<AiGatewayService['settle']>>;
    try {
      settled = await this.settle(authorization, {
        inputTokens,
        outputTokens,
        usageAuthoritative: authoritative,
        providerRequestId: stream.providerRequestId,
        providerResponseId: stream.providerResponseId,
        finishReason,
        latencyMs: Date.now() - startedAt,
        content,
        toolCalls,
        ...(chargeOverride(authorization, worstCase, inputTokens, outputTokens)
          ? { charge: { customerPriceUsd: worstCase.customerPriceUsd } }
          : {}),
      });
    } catch (error) {
      // Settlement failed after delivery (for example a concurrently exhausted balance):
      // fail the request, emit no successful usage charge and report a canonical error.
      await this.failRequest(authorization.providerRequestId, error, Date.now() - startedAt);
      output.write({
        type: 'error',
        error: 'ai_settlement_failed',
        message: 'The AI request completed but its usage charge could not be settled',
      });
      return;
    }

    output.write({
      type: 'done',
      request: {
        id: authorization.providerRequestId,
        requestId: authorization.requestId,
        customerId: authorization.customerId,
        provider: authorization.model.provider_slug,
        model: authorization.model.model_slug,
        providerRequestId: stream.providerRequestId,
        providerResponseId: stream.providerResponseId,
        finishReason,
        latencyMs: Date.now() - startedAt,
        toolCallCount: toolCalls.length,
        chargeCapped: settled.chargeCapped,
      },
      usage: {
        ...settled.usage,
        currency: 'CREDITS' as const,
        usageSource: authoritative ? 'provider' : 'estimated',
      },
    });
  }

  private validateRequest(request: AiChatRequest) {
    const estimatedInputTokens = estimatePromptTokens(request.messages);
    if (estimatedInputTokens > config.AI_MAX_PROMPT_TOKENS) {
      throw new HttpError(413, 'The prompt exceeds the maximum supported length', 'ai_prompt_too_long');
    }
    const maxOutputTokens = Math.min(request.maxOutputTokens, config.AI_MAX_OUTPUT_TOKENS);
    return { estimatedInputTokens, maxOutputTokens };
  }

  private async resolveProvider(authorization: Awaited<ReturnType<AiGatewayService['authorize']>>) {
    try {
      return this.providers.getConfiguredProvider(authorization.model.provider_slug);
    } catch (error) {
      await this.failRequest(authorization.providerRequestId, error, 0);
      throw this.toHttpError(error);
    }
  }

  private async authorize(request: AiChatRequest, maxOutputTokens: number, estimatedInputTokens: number) {
    return this.db.transaction(async (client) => {
      const customer = await client.query(
        'SELECT id FROM customers WHERE id = $1 AND merchant_id = $2',
        [request.customerId, request.merchantId],
      );
      if (!customer.rows[0]) throw new HttpError(404, 'Customer not found for this merchant', 'customer_not_found');

      // Read under the credit-account lock below; pricing is re-read at settlement.
      const model = await this.pricing.getPricedModel(client, request.provider, request.model);
      if (!model) throw new HttpError(404, 'Enabled AI model not found', 'ai_model_not_found');
      const creditsPerUsdcRate = await this.pricing.getCreditSettings(client);

      const worstCase = calculateAiUsagePrice(model, estimatedInputTokens, maxOutputTokens);
      const authorizedCreditUnits = creditUnitsForPrice(worstCase.customerPriceUsd, creditsPerUsdcRate);
      if (authorizedCreditUnits <= 0n) {
        throw new HttpError(409, 'AI model pricing must produce a positive customer charge', 'zero_ai_usage_price');
      }

      await client.query(
        `INSERT INTO credit_accounts (id, merchant_id, customer_id) VALUES ($1, $2, $3)
         ON CONFLICT (merchant_id, customer_id) DO NOTHING`,
        [newId(), request.merchantId, request.customerId],
      );
      const account = await client.query<{ id: string; balance_units: string }>(
        `SELECT id, balance_units::text AS balance_units FROM credit_accounts
          WHERE merchant_id = $1 AND customer_id = $2 FOR UPDATE`,
        [request.merchantId, request.customerId],
      );
      const creditAccount = account.rows[0];
      if (!creditAccount) throw new Error('Could not initialize AI usage credit account');
      if (BigInt(creditAccount.balance_units) < authorizedCreditUnits) {
        throw new HttpError(409, 'Insufficient credits for the maximum cost of this request', 'insufficient_credits');
      }

      const existing = await client.query<{ id: string; status: string; request_id: string }>(
        'SELECT id, status, request_id FROM ai_provider_requests WHERE merchant_id = $1 AND request_id = $2',
        [request.merchantId, request.requestId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].status === 'AUTHORIZED') {
          throw new HttpError(409, 'A request with this identifier is still being processed', 'ai_request_in_progress');
        }
        throw new HttpError(409, 'This AI request identifier has already been used', 'ai_request_conflict');
      }

      const providerRequestId = newId();
      await client.query(
        `INSERT INTO ai_provider_requests (id, merchant_id, customer_id, provider_id, model_id, request_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'AUTHORIZED')`,
        [providerRequestId, request.merchantId, request.customerId, model.provider_id, model.model_id, request.requestId],
      );
      return {
        providerRequestId,
        model: model as AiPricedModel,
        creditAccountId: creditAccount.id,
        creditsPerUsdcRate,
        merchantId: request.merchantId,
        customerId: request.customerId,
        requestId: request.requestId,
      };
    });
  }

  private async settle(authorization: {
    providerRequestId: string; model: AiPricedModel; creditAccountId: string; creditsPerUsdcRate: number;
    requestId: string; merchantId: string; customerId: string;
  }, outcome: {
    inputTokens: number; outputTokens: number; usageAuthoritative: boolean;
    providerRequestId: string; providerResponseId: string; finishReason: string | null;
    latencyMs: number; content: string; toolCalls: readonly AiToolCall[];
    charge?: { customerPriceUsd: string };
  }) {
    return this.db.transaction(async (client) => {
      const request = await client.query<{ status: string }>(
        'SELECT status FROM ai_provider_requests WHERE id = $1 FOR UPDATE',
        [authorization.providerRequestId],
      );
      if (request.rows[0]?.status !== 'AUTHORIZED') {
        throw new HttpError(409, 'This AI request has already been settled', 'ai_request_already_settled');
      }
      // Re-read pricing settings and lock the account so the settled charge uses current
      // configuration and cannot interleave with a concurrent deduction for the same customer.
      const model = await this.pricing.getPricedModel(client, authorization.model.provider_slug, authorization.model.model_slug);
      if (!model) throw new HttpError(409, 'The AI model is no longer enabled', 'ai_model_not_found');
      const creditsPerUsdcRate = await this.pricing.getCreditSettings(client);
      await client.query(
        'SELECT id FROM credit_accounts WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
        [authorization.creditAccountId, authorization.merchantId],
      );
      const settled = await this.pricing.settleUsageInTransaction(client, {
        merchantId: authorization.merchantId,
        customerId: authorization.customerId,
        accountId: authorization.creditAccountId,
        requestId: authorization.requestId,
        model,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        creditsPerUsdcRate,
        metadata: {
          providerRequestId: outcome.providerRequestId,
          providerResponseId: outcome.providerResponseId,
          ...(outcome.toolCalls.length ? { toolCallCount: outcome.toolCalls.length } : {}),
        },
        providerRequestId: authorization.providerRequestId,
        usageAuthoritative: outcome.usageAuthoritative,
        ...(outcome.charge ? { charge: outcome.charge } : {}),
      });
      await client.query(
        `UPDATE ai_provider_requests
            SET status = 'COMPLETED', provider_request_id = $2, provider_response_id = $3,
                input_tokens = $4, output_tokens = $5, usage_authoritative = $6, latency_ms = $7, completed_at = now()
          WHERE id = $1`,
        [authorization.providerRequestId, outcome.providerRequestId, outcome.providerResponseId,
          outcome.inputTokens, outcome.outputTokens, outcome.usageAuthoritative, outcome.latencyMs],
      );
      await enqueueWebhookEvent({
        client, merchantId: authorization.merchantId, eventType: 'ai.request.completed',
        resourceId: authorization.providerRequestId,
        data: {
          requestId: authorization.requestId, provider: model.provider_slug, model: model.model_slug,
          inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens,
          customerPriceUsd: settled.price.customerPriceUsd, creditsDeducted: settled.usage.creditsDeducted,
          ...(outcome.toolCalls.length ? { toolCallCount: outcome.toolCalls.length } : {}),
        },
      });
      return {
        chargeCapped: outcome.charge !== undefined,
        usage: settled.usage,
      };
    });
  }

  private async failRequest(
    providerRequestId: string,
    error: unknown,
    latencyMs: number,
    options?: { failureKind?: string; failureMessage?: string },
  ): Promise<void> {
    const normalized = normalizeAiProviderError(error, 'ai');
    const failureKind = options?.failureKind ?? normalized.kind;
    const failureMessage = options?.failureMessage ?? aiProviderErrorMessage(normalized.kind);
    await this.db.transaction(async (client: PoolClient) => {
      const result = await client.query<{ id: string; merchant_id: string; request_id: string }>(
        'SELECT id, merchant_id, request_id FROM ai_provider_requests WHERE id = $1 AND status = $2',
        [providerRequestId, 'AUTHORIZED'],
      );
      const row = result.rows[0];
      if (!row) return;
      await client.query(
        `UPDATE ai_provider_requests SET status = 'FAILED', failure_kind = $2, failure_message = $3,
                latency_ms = $4, completed_at = now()
          WHERE id = $1`,
        [row.id, failureKind, failureMessage, latencyMs],
      );
      await enqueueWebhookEvent({
        client, merchantId: row.merchant_id, eventType: 'ai.request.failed', resourceId: row.id,
        data: { requestId: row.request_id, reason: failureKind, retryable: normalized.retryable },
      });
    });
  }

  private errorEvent(error: unknown): AiGatewayStreamEvent {
    const normalized = error instanceof AiProviderError ? error : normalizeAiProviderError(error, 'ai');
    return {
      type: 'error',
      error: aiProviderErrorCode(normalized.kind),
      message: aiProviderErrorMessage(normalized.kind),
    };
  }

  private toHttpError(error: unknown): HttpError {
    const normalized = error instanceof AiProviderError ? error : normalizeAiProviderError(error, 'ai');
    // Use the canonical message and code so provider-supplied text never reaches the client.
    return new HttpError(normalized.statusCode, aiProviderErrorMessage(normalized.kind), aiProviderErrorCode(normalized.kind));
  }
}

/** True when the actual usage would exceed the authorized maximum charge. */
function chargeOverride(
  authorization: { model: AiPricedModel; creditsPerUsdcRate: number },
  worstCase: ReturnType<typeof calculateAiUsagePrice>,
  inputTokens: number,
  outputTokens: number,
): boolean {
  const actual = calculateAiUsagePrice(authorization.model, inputTokens, outputTokens);
  const authorizedUnits = creditUnitsForPrice(worstCase.customerPriceUsd, authorization.creditsPerUsdcRate);
  const actualUnits = creditUnitsForPrice(actual.customerPriceUsd, authorization.creditsPerUsdcRate);
  return actualUnits > authorizedUnits;
}
