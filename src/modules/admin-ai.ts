import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { parseBody, requireAdmin, requireUuidParam } from '../http.js';
import { createAiModelSchema, createAiProviderSchema, updateAiModelSchema, updateAiProviderSchema } from '../schemas.js';
import { newId } from '../security.js';
import { AiProviderError, aiProviderErrorMessage, normalizeAiProviderError } from '../ai-provider.js';
import type { AiProviderRegistry } from '../ai-providers/registry.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

const modelColumns = `id, provider_id, slug, name, enabled, pricing_mode,
  provider_cost_per_request_usd::text AS provider_cost_per_request_usd,
  customer_price_per_request_usd::text AS customer_price_per_request_usd,
  provider_input_cost_per_1k_usd::text AS provider_input_cost_per_1k_usd,
  customer_input_price_per_1k_usd::text AS customer_input_price_per_1k_usd,
  provider_output_cost_per_1k_usd::text AS provider_output_cost_per_1k_usd,
  customer_output_price_per_1k_usd::text AS customer_output_price_per_1k_usd,
  provider_model, max_output_tokens, markup_bps, created_at, updated_at`;

/** Qualified projection for the joined listing; unqualified ids and names are ambiguous with the provider join. */
const modelFields = `m.id, m.provider_id AS "providerId", m.slug, m.name, m.enabled, m.pricing_mode AS "pricingMode",
  m.provider_cost_per_request_usd::text AS "providerCostPerRequestUsd",
  m.customer_price_per_request_usd::text AS "customerPricePerRequestUsd",
  m.provider_input_cost_per_1k_usd::text AS "providerInputCostPer1kUsd",
  m.customer_input_price_per_1k_usd::text AS "customerInputPricePer1kUsd",
  m.provider_output_cost_per_1k_usd::text AS "providerOutputCostPer1kUsd",
  m.customer_output_price_per_1k_usd::text AS "customerOutputPricePer1kUsd",
  m.provider_model AS "providerModel", m.max_output_tokens AS "maxOutputTokens",
  m.markup_bps AS "markupBps", m.created_at AS "createdAt", m.updated_at AS "updatedAt"`;

const camelModel = (row: Record<string, unknown>) => ({
  id: row.id,
  providerId: row.provider_id,
  slug: row.slug,
  name: row.name,
  enabled: row.enabled,
  pricingMode: row.pricing_mode,
  providerCostPerRequestUsd: row.provider_cost_per_request_usd,
  customerPricePerRequestUsd: row.customer_price_per_request_usd,
  providerInputCostPer1kUsd: row.provider_input_cost_per_1k_usd,
  customerInputPricePer1kUsd: row.customer_input_price_per_1k_usd,
  providerOutputCostPer1kUsd: row.provider_output_cost_per_1k_usd,
  customerOutputPricePer1kUsd: row.customer_output_price_per_1k_usd,
  providerModel: row.provider_model,
  maxOutputTokens: row.max_output_tokens,
  markupBps: row.markup_bps,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const adminAiRoutes: FastifyPluginAsync<{ db: Database; aiProviders: AiProviderRegistry }> = async (app, { db, aiProviders }) => {
  app.get('/v1/admin/ai/providers', async (request, reply) => {
    requireAdmin(request);
    const providers = await db.query(
      `SELECT id, slug, name, enabled, integration, credential_source AS "credentialSource",
              timeout_ms AS "timeoutMs", last_status AS "lastStatus", last_status_message AS "lastStatusMessage",
              last_health_checked_at AS "lastHealthCheckedAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM ai_providers ORDER BY name ASC`,
    );
    const installed = new Map((await aiProviders.list()).map((provider) => [provider.id, provider]));
    return reply.send({
      providers: providers.rows.map((provider) => {
        const runtime = installed.get(provider.slug);
        return {
          ...provider,
          installed: Boolean(runtime),
          registryStatus: runtime?.status ?? 'disabled',
          configured: runtime?.configured ?? false,
          capabilities: runtime?.capabilities ?? null,
        };
      }),
      integrations: await aiProviders.list(),
    });
  });

  app.post('/v1/admin/ai/providers/:providerId/health', async (request, reply) => {
    requireAdmin(request);
    const providerId = requireUuidParam(request, 'providerId');
    const provider = await db.query('SELECT id, slug FROM ai_providers WHERE id = $1', [providerId]);
    if (!provider.rows[0]) throw new HttpError(404, 'AI provider not found', 'ai_provider_not_found');
    const health = await aiProviders.health(provider.rows[0].slug);
    const enabled = await db.query<{ enabled: boolean }>('SELECT enabled FROM ai_providers WHERE id = $1', [providerId]);
    await db.query(
      `UPDATE ai_providers SET last_status = $2, last_status_message = $3, last_health_checked_at = now(), updated_at = now()
        WHERE id = $1`,
      [providerId, health.status, health.message],
    );
    return reply.send({
      provider: { id: providerId, slug: provider.rows[0].slug, enabled: enabled.rows[0]?.enabled ?? false },
      health: { ...health, checkedAt: new Date().toISOString() },
    });
  });

  app.get('/v1/admin/ai/providers/:providerId/models/discovery', async (request, reply) => {
    requireAdmin(request);
    const providerId = requireUuidParam(request, 'providerId');
    const provider = await db.query('SELECT id, slug FROM ai_providers WHERE id = $1', [providerId]);
    if (!provider.rows[0]) throw new HttpError(404, 'AI provider not found', 'ai_provider_not_found');
    try {
      const models = await aiProviders.getConfiguredProvider(provider.rows[0].slug).listModels();
      return reply.send({ models });
    } catch (error) {
      const normalized = error instanceof AiProviderError ? error : normalizeAiProviderError(error, provider.rows[0].slug);
      throw new HttpError(normalized.statusCode, aiProviderErrorMessage(normalized.kind), 'ai_provider_discovery_failed');
    }
  });

  app.get('/v1/admin/ai/requests', async (request, reply) => {
    requireAdmin(request);
    const query = request.query as { limit?: string; status?: string };
    const result = await db.query(
      `SELECT r.id, r.merchant_id AS "merchantId", r.customer_id AS "customerId", p.slug AS provider,
              m.slug AS model, r.request_id AS "requestId", r.provider_request_id AS "providerRequestId",
              r.provider_response_id AS "providerResponseId", r.status, r.failure_kind AS "failureKind",
              r.failure_message AS "failureMessage", r.input_tokens AS "inputTokens",
              r.output_tokens AS "outputTokens", r.usage_authoritative AS "usageAuthoritative",
              r.latency_ms AS "latencyMs", r.created_at AS "createdAt", r.completed_at AS "completedAt"
         FROM ai_provider_requests r JOIN ai_providers p ON p.id = r.provider_id JOIN ai_models m ON m.id = r.model_id
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY r.created_at DESC LIMIT $2`,
      [query.status ?? null, pageLimit(query.limit)],
    );
    return reply.send({ requests: result.rows });
  });

  app.post('/v1/admin/ai/providers', async (request, reply) => {
    requireAdmin(request);
    const body = parseBody(createAiProviderSchema, request.body);
    const result = await db.query(
      `INSERT INTO ai_providers (id, slug, name, enabled, integration, timeout_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, slug, name, enabled, integration, credential_source AS "credentialSource",
                 timeout_ms AS "timeoutMs", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [newId(), body.slug, body.name, body.enabled, body.integration ?? 'openai-compatible', body.timeoutMs ?? null],
    );
    return reply.code(201).send({ provider: result.rows[0] });
  });

  app.put('/v1/admin/ai/providers/:providerId', async (request, reply) => {
    requireAdmin(request);
    const body = parseBody(updateAiProviderSchema, request.body);
    const providerId = requireUuidParam(request, 'providerId');
    const result = await db.query(
      `UPDATE ai_providers SET name = COALESCE($2, name), enabled = COALESCE($3, enabled), updated_at = now()
        WHERE id = $1
        RETURNING id, slug, name, enabled, integration, credential_source AS "credentialSource",
                  timeout_ms AS "timeoutMs", created_at AS "createdAt", updated_at AS "updatedAt"`,
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
    const providerId = requireUuidParam(request, 'providerId');
    const provider = await db.query('SELECT id FROM ai_providers WHERE id = $1', [providerId]);
    if (!provider.rows[0]) throw new HttpError(404, 'AI provider not found', 'ai_provider_not_found');
    const result = await db.query(
      `INSERT INTO ai_models (id, provider_id, slug, name, enabled, pricing_mode,
          provider_cost_per_request_usd, customer_price_per_request_usd,
          provider_input_cost_per_1k_usd, customer_input_price_per_1k_usd,
          provider_output_cost_per_1k_usd, customer_output_price_per_1k_usd, markup_bps,
          provider_model, max_output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${modelColumns}`,
      [newId(), providerId, body.slug, body.name, body.enabled, body.pricingMode,
        body.providerCostPerRequestUsd, body.customerPricePerRequestUsd,
        body.providerInputCostPer1kUsd, body.customerInputPricePer1kUsd,
        body.providerOutputCostPer1kUsd, body.customerOutputPricePer1kUsd, body.markupBps,
        body.providerModel ?? null, body.maxOutputTokens],
    );
    if (!result.rows[0]) throw new Error('AI model insert returned no row');
    return reply.code(201).send({ model: camelModel(result.rows[0]) });
  });

  app.put('/v1/admin/ai/models/:modelId', async (request, reply) => {
    requireAdmin(request);
    const body = parseBody(updateAiModelSchema, request.body);
    const modelId = requireUuidParam(request, 'modelId');
    const result = await db.query(
      `UPDATE ai_models SET slug = $2, name = $3, enabled = $4, pricing_mode = $5,
          provider_cost_per_request_usd = $6, customer_price_per_request_usd = $7,
          provider_input_cost_per_1k_usd = $8, customer_input_price_per_1k_usd = $9,
          provider_output_cost_per_1k_usd = $10, customer_output_price_per_1k_usd = $11,
          markup_bps = $12, provider_model = $13, max_output_tokens = $14, updated_at = now()
        WHERE id = $1 RETURNING ${modelColumns}`,
      [modelId, body.slug, body.name, body.enabled, body.pricingMode,
        body.providerCostPerRequestUsd, body.customerPricePerRequestUsd,
        body.providerInputCostPer1kUsd, body.customerInputPricePer1kUsd,
        body.providerOutputCostPer1kUsd, body.customerOutputPricePer1kUsd, body.markupBps,
        body.providerModel ?? null, body.maxOutputTokens],
    );
    if (!result.rows[0]) throw new HttpError(404, 'AI model not found', 'ai_model_not_found');
    return reply.send({ model: camelModel(result.rows[0]) });
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
