import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { parseBody, requireMerchant } from '../http.js';
import { recordAiUsageSchema } from '../schemas.js';
import { customerAiPricesPerUnit, type AiPricingModel } from '../services/ai-pricing-engine.js';
import type { AiPricingEngine } from '../services/ai-pricing-engine.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

export const aiRoutes: FastifyPluginAsync<{ db: Database; aiPricing: AiPricingEngine }> = async (app, { db, aiPricing }) => {
  app.get('/v1/ai/models', async (request, reply) => {
    await requireMerchant(request, db);
    const result = await db.query<AiPricingModel & {
      provider_slug: string; provider_name: string; model_slug: string; model_name: string;
    }>(
      `SELECT p.slug AS provider_slug, p.name AS provider_name, m.slug AS model_slug, m.name AS model_name,
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

  app.get('/v1/ai/usage', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const query = request.query as { limit?: string; customerId?: string };
    const result = await db.query(
      `SELECT u.id, u.customer_id AS "customerId", p.slug AS provider, m.slug AS model,
              u.request_id AS "requestId", u.pricing_mode AS "pricingMode", u.input_tokens AS "inputTokens",
              u.output_tokens AS "outputTokens", u.total_tokens AS "totalTokens",
              u.provider_cost_usd::text AS "providerCostUsd", u.customer_price_usd::text AS "customerPriceUsd",
              u.profit_usd::text AS "profitUsd", u.credits_deducted_units::text AS "creditsDeductedUnits",
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
