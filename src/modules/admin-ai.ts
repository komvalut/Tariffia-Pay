import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { parseBody, requireAdmin } from '../http.js';
import { createAiModelSchema, createAiProviderSchema, updateAiModelSchema, updateAiProviderSchema } from '../schemas.js';
import { newId } from '../security.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

const modelFields = `id, provider_id AS "providerId", slug, name, enabled, pricing_mode AS "pricingMode",
  provider_cost_per_request_usd::text AS "providerCostPerRequestUsd",
  customer_price_per_request_usd::text AS "customerPricePerRequestUsd",
  provider_input_cost_per_1k_usd::text AS "providerInputCostPer1kUsd",
  customer_input_price_per_1k_usd::text AS "customerInputPricePer1kUsd",
  provider_output_cost_per_1k_usd::text AS "providerOutputCostPer1kUsd",
  customer_output_price_per_1k_usd::text AS "customerOutputPricePer1kUsd",
  markup_bps AS "markupBps", created_at AS "createdAt", updated_at AS "updatedAt"`;

export const adminAiRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/v1/admin/ai/providers', async (request, reply) => {
    requireAdmin(request);
    const providers = await db.query(
      `SELECT id, slug, name, enabled, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM ai_providers ORDER BY name ASC`,
    );
    return reply.send({ providers: providers.rows });
  });

  app.post('/v1/admin/ai/providers', async (request, reply) => {
    requireAdmin(request);
    const body = parseBody(createAiProviderSchema, request.body);
    const result = await db.query(
      `INSERT INTO ai_providers (id, slug, name, enabled) VALUES ($1, $2, $3, $4)
       RETURNING id, slug, name, enabled, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [newId(), body.slug, body.name, body.enabled],
    );
    return reply.code(201).send({ provider: result.rows[0] });
  });

  app.put('/v1/admin/ai/providers/:providerId', async (request, reply) => {
    requireAdmin(request);
    const body = parseBody(updateAiProviderSchema, request.body);
    const { providerId } = request.params as { providerId: string };
    const result = await db.query(
      `UPDATE ai_providers SET name = COALESCE($2, name), enabled = COALESCE($3, enabled), updated_at = now()
        WHERE id = $1
        RETURNING id, slug, name, enabled, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [providerId, body.name ?? null, body.enabled ?? null],
    );
    if (!result.rows[0]) throw new HttpError(404, 'AI provider not found', 'ai_provider_not_found');
    return reply.send({ provider: result.rows[0] });
  });

  app.get('/v1/admin/ai/models', async (request, reply) => {
    requireAdmin(request);
    const result = await db.query(
      `SELECT ${modelFields}, p.slug AS "providerSlug", p.name AS "providerName"
         FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
        ORDER BY p.name ASC, m.name ASC`,
    );
    return reply.send({ models: result.rows });
  });

  app.post('/v1/admin/ai/providers/:providerId/models', async (request, reply) => {
    requireAdmin(request);
    const body = parseBody(createAiModelSchema, request.body);
    const { providerId } = request.params as { providerId: string };
    const provider = await db.query('SELECT id FROM ai_providers WHERE id = $1', [providerId]);
    if (!provider.rows[0]) throw new HttpError(404, 'AI provider not found', 'ai_provider_not_found');
    const result = await db.query(
      `INSERT INTO ai_models (id, provider_id, slug, name, enabled, pricing_mode,
          provider_cost_per_request_usd, customer_price_per_request_usd,
          provider_input_cost_per_1k_usd, customer_input_price_per_1k_usd,
          provider_output_cost_per_1k_usd, customer_output_price_per_1k_usd, markup_bps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${modelFields}`,
      [newId(), providerId, body.slug, body.name, body.enabled, body.pricingMode,
        body.providerCostPerRequestUsd, body.customerPricePerRequestUsd,
        body.providerInputCostPer1kUsd, body.customerInputPricePer1kUsd,
        body.providerOutputCostPer1kUsd, body.customerOutputPricePer1kUsd, body.markupBps],
    );
    return reply.code(201).send({ model: result.rows[0] });
  });

  app.put('/v1/admin/ai/models/:modelId', async (request, reply) => {
    requireAdmin(request);
    const body = parseBody(updateAiModelSchema, request.body);
    const { modelId } = request.params as { modelId: string };
    const result = await db.query(
      `UPDATE ai_models SET slug = $2, name = $3, enabled = $4, pricing_mode = $5,
          provider_cost_per_request_usd = $6, customer_price_per_request_usd = $7,
          provider_input_cost_per_1k_usd = $8, customer_input_price_per_1k_usd = $9,
          provider_output_cost_per_1k_usd = $10, customer_output_price_per_1k_usd = $11,
          markup_bps = $12, updated_at = now()
        WHERE id = $1 RETURNING ${modelFields}`,
      [modelId, body.slug, body.name, body.enabled, body.pricingMode,
        body.providerCostPerRequestUsd, body.customerPricePerRequestUsd,
        body.providerInputCostPer1kUsd, body.customerInputPricePer1kUsd,
        body.providerOutputCostPer1kUsd, body.customerOutputPricePer1kUsd, body.markupBps],
    );
    if (!result.rows[0]) throw new HttpError(404, 'AI model not found', 'ai_model_not_found');
    return reply.send({ model: result.rows[0] });
  });

  app.get('/v1/admin/ai/usage', async (request, reply) => {
    requireAdmin(request);
    const query = request.query as { limit?: string; merchantId?: string };
    const result = await db.query(
      `SELECT u.id, u.merchant_id AS "merchantId", m.name AS merchant, u.customer_id AS "customerId",
              COALESCE(c.name, c.email, c.external_id, c.id::text) AS customer,
              p.slug AS provider, am.slug AS model, u.request_id AS "requestId", u.pricing_mode AS "pricingMode",
              u.input_tokens AS "inputTokens", u.output_tokens AS "outputTokens", u.total_tokens AS "totalTokens",
              u.provider_cost_usd::text AS "providerCostUsd", u.customer_price_usd::text AS "customerPriceUsd",
              u.profit_usd::text AS "profitUsd", u.credits_deducted_units::text AS "creditsDeductedUnits",
              u.credits_per_usdc_rate AS "creditsPerUsdcRate", u.created_at AS "createdAt"
         FROM ai_usage_records u JOIN merchants m ON m.id = u.merchant_id
         JOIN customers c ON c.id = u.customer_id JOIN ai_providers p ON p.id = u.provider_id
         JOIN ai_models am ON am.id = u.model_id
        WHERE ($1::uuid IS NULL OR u.merchant_id = $1)
        ORDER BY u.created_at DESC LIMIT $2`,
      [query.merchantId ?? null, pageLimit(query.limit)],
    );
    return reply.send({ usage: result.rows });
  });
};
