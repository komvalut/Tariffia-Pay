import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import type { Database } from '../db.js';
import { parseBody, requireMerchant } from '../http.js';
import { aiChatCompletionSchema, recordAiUsageSchema } from '../schemas.js';
import { customerAiPricesPerUnit, type AiPricingModel } from '../services/ai-pricing-engine.js';
import type { AiPricingEngine } from '../services/ai-pricing-engine.js';
import type { AiGatewayService } from '../services/ai-gateway-service.js';
import type { AiProviderRegistry } from '../ai-providers/registry.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

export const aiRoutes: FastifyPluginAsync<{
  db: Database; aiPricing: AiPricingEngine; aiGateway: AiGatewayService; aiProviders: AiProviderRegistry;
}> = async (app, { db, aiPricing, aiGateway, aiProviders }) => {
  app.get('/v1/ai/models', async (request, reply) => {
    await requireMerchant(request, db);
    const result = await db.query<AiPricingModel & {
      provider_slug: string; provider_name: string; model_slug: string; model_name: string; max_output_tokens: number;
    }>(
      `SELECT p.slug AS provider_slug, p.name AS provider_name, m.slug AS model_slug, m.name AS model_name,
              m.max_output_tokens, m.provider_model,
              m.pricing_mode, m.provider_cost_per_request_usd::text AS provider_cost_per_request_usd,
              m.customer_price_per_request_usd::text AS customer_price_per_request_usd,
              m.provider_input_cost_per_1k_usd::text AS provider_input_cost_per_1k_usd,
              m.customer_input_price_per_1k_usd::text AS customer_input_price_per_1k_usd,
              m.provider_output_cost_per_1k_usd::text AS provider_output_cost_per_1k_usd,
              m.customer_output_price_per_1k_usd::text AS customer_output_price_per_1k_usd, m.markup_bps
         FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
        WHERE p.enabled = true AND m.enabled = true ORDER BY p.name, m.name`,
    );
    return reply.send({ models: result.rows.map((model) => {
      const prices = customerAiPricesPerUnit(model);
      return {
        provider: model.provider_slug,
        providerName: model.provider_name,
        model: model.model_slug,
        name: model.model_name,
        pricingMode: model.pricing_mode,
        maxOutputTokens: model.max_output_tokens,
        providerConfigured: aiProviders.isConfigured(model.provider_slug),
        pricePerRequestUsd: prices.requestUsd,
        inputPricePer1kUsd: prices.inputPer1kUsd,
        outputPricePer1kUsd: prices.outputPer1kUsd,
      };
    }) });
  });

  app.post('/v1/ai/usage', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(recordAiUsageSchema, request.body);
    const result = await aiPricing.recordUsage({ merchantId: merchant.id, ...body });
    return reply.header('Idempotency-Replayed', String(result.replayed)).code(result.status).send(result.body);
  });

  app.post('/v1/ai/chat/completions', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(aiChatCompletionSchema, request.body);
    const result = await aiGateway.createChatCompletion({
      merchantId: merchant.id,
      customerId: body.customerId,
      provider: body.provider,
      model: body.model,
      messages: body.messages,
      maxOutputTokens: Math.min(body.maxOutputTokens ?? config.AI_MAX_OUTPUT_TOKENS, config.AI_MAX_OUTPUT_TOKENS),
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
      metadata: body.metadata,
      requestId: body.requestId,
    });
    return reply.code(result.status).send(result.body);
  });

  app.get('/v1/ai/usage', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const query = request.query as { limit?: string; customerId?: string };
    const result = await db.query(
      `SELECT u.id, u.customer_id AS "customerId", p.slug AS provider, m.slug AS model,
              u.request_id AS "requestId", u.pricing_mode AS "pricingMode", u.input_tokens AS "inputTokens",
              u.output_tokens AS "outputTokens", u.total_tokens AS "totalTokens",
              u.customer_price_usd::text AS "customerPriceUsd",
              u.credits_deducted_units::text AS "creditsDeductedUnits",
              u.created_at AS "createdAt"
         FROM ai_usage_records u JOIN ai_providers p ON p.id = u.provider_id
         JOIN ai_models m ON m.id = u.model_id
        WHERE u.merchant_id = $1 AND ($2::uuid IS NULL OR u.customer_id = $2)
        ORDER BY u.created_at DESC LIMIT $3`,
      [merchant.id, query.customerId ?? null, pageLimit(query.limit)],
    );
    return reply.send({ usage: result.rows });
  });
};
