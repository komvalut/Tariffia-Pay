import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { parseBody, requireAdmin, requireUuidParam } from '../http.js';
import {
  createSmsProviderSchema,
  createSmsServiceSchema,
  updateSmsProviderSchema,
  updateSmsServiceSchema,
} from '../schemas.js';
import { newId } from '../security.js';
import type { SmsProviderRegistry } from '../sms-providers/registry.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

/** The fallback provider must exist, be enabled and differ from the primary. */
async function validateFallback(
  db: Database,
  fallbackProviderId: string | null,
  primaryProviderId: string,
): Promise<void> {
  if (!fallbackProviderId) return;
  if (fallbackProviderId === primaryProviderId) {
    throw new HttpError(400, 'The fallback provider must differ from the primary provider', 'invalid_fallback_provider');
  }
  const fallback = await db.query<{ id: string; enabled: boolean }>(
    'SELECT id, enabled FROM sms_providers WHERE id = $1', [fallbackProviderId],
  );
  if (!fallback.rows[0]) throw new HttpError(404, 'SMS provider not found', 'sms_provider_not_found');
  if (!fallback.rows[0].enabled) {
    throw new HttpError(400, 'The fallback provider must be enabled', 'invalid_fallback_provider');
  }
}

const serviceColumns = `id, provider_id, fallback_provider_id, slug, name, type, enabled,
  customer_price_per_sms_usd::text AS customer_price_per_sms_usd,
  provider_cost_per_sms_usd::text AS provider_cost_per_sms_usd, markup_bps,
  otp_length, otp_expiry_seconds, otp_message_template, max_message_length,
  metadata, created_at, updated_at`;

const serviceFields = `s.id, s.provider_id AS "providerId", s.fallback_provider_id AS "fallbackProviderId",
  s.slug, s.name, s.type, s.enabled,
  s.customer_price_per_sms_usd::text AS "customerPricePerSmsUsd",
  s.provider_cost_per_sms_usd::text AS "providerCostPerSmsUsd", s.markup_bps AS "markupBps",
  s.otp_length AS "otpLength", s.otp_expiry_seconds AS "otpExpirySeconds",
  s.otp_message_template AS "otpMessageTemplate", s.max_message_length AS "maxMessageLength",
  s.metadata, s.created_at AS "createdAt", s.updated_at AS "updatedAt"`;

const camelService = (row: Record<string, unknown>) => ({
  id: row.id,
  providerId: row.provider_id,
  fallbackProviderId: row.fallback_provider_id,
  slug: row.slug,
  name: row.name,
  type: row.type,
  enabled: row.enabled,
  customerPricePerSmsUsd: row.customer_price_per_sms_usd,
  providerCostPerSmsUsd: row.provider_cost_per_sms_usd,
  markupBps: row.markup_bps,
  otpLength: row.otp_length,
  otpExpirySeconds: row.otp_expiry_seconds,
  otpMessageTemplate: row.otp_message_template,
  maxMessageLength: row.max_message_length,
  metadata: row.metadata,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const adminSmsRoutes: FastifyPluginAsync<{ db: Database; smsProviders: SmsProviderRegistry }> =
  async (app, { db, smsProviders }) => {
    app.get('/v1/admin/sms/providers', async (request, reply) => {
      requireAdmin(request);
      const providers = await db.query(
        `SELECT id, slug, name, enabled, integration, credential_source AS "credentialSource",
                timeout_ms AS "timeoutMs", last_status AS "lastStatus", last_status_message AS "lastStatusMessage",
                last_health_checked_at AS "lastHealthCheckedAt",
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM sms_providers ORDER BY name ASC`,
      );
      const installed = new Map((await smsProviders.list()).map((provider) => [provider.id, provider]));
      const stats = await db.query<{
        provider_id: string; request_count: number; completed_count: number;
        failed_count: number; average_latency_ms: string | null;
      }>(
        `SELECT provider_id, count(*)::int AS request_count,
                COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0)::int AS completed_count,
                COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0)::int AS failed_count,
                avg(latency_ms)::text AS average_latency_ms
           FROM sms_provider_requests GROUP BY provider_id`,
      );
      const statsById = new Map(stats.rows.map((row) => [row.provider_id, row]));
      return reply.send({
        providers: providers.rows.map((provider) => {
          const runtime = installed.get(provider.slug);
          const stat = statsById.get(provider.id);
          return {
            ...provider,
            installed: Boolean(runtime),
            registryStatus: runtime?.status ?? 'disabled',
            configured: runtime?.configured ?? false,
            capabilities: runtime?.capabilities ?? null,
            configuration: runtime?.configuration ?? null,
            requestCount: stat?.request_count ?? 0,
            completedCount: stat?.completed_count ?? 0,
            failedCount: stat?.failed_count ?? 0,
            averageLatencyMs: stat?.average_latency_ms ? Math.round(Number(stat.average_latency_ms)) : null,
          };
        }),
        integrations: await smsProviders.list(),
      });
    });

    app.post('/v1/admin/sms/providers', async (request, reply) => {
      requireAdmin(request);
      const body = parseBody(createSmsProviderSchema, request.body);
      const result = await db.query(
        `INSERT INTO sms_providers (id, slug, name, enabled, integration, timeout_ms)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, slug, name, enabled, integration, credential_source AS "credentialSource",
                   timeout_ms AS "timeoutMs", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [newId(), body.slug, body.name, body.enabled, body.integration, body.timeoutMs ?? null],
      );
      return reply.code(201).send({ provider: result.rows[0] });
    });

    app.put('/v1/admin/sms/providers/:providerId', async (request, reply) => {
      requireAdmin(request);
      const body = parseBody(updateSmsProviderSchema, request.body);
      const providerId = requireUuidParam(request, 'providerId');
      const result = await db.query(
        `UPDATE sms_providers SET name = COALESCE($2, name), enabled = COALESCE($3, enabled), updated_at = now()
          WHERE id = $1
          RETURNING id, slug, name, enabled, integration, credential_source AS "credentialSource",
                    timeout_ms AS "timeoutMs", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [providerId, body.name ?? null, body.enabled ?? null],
      );
      if (!result.rows[0]) throw new HttpError(404, 'SMS provider not found', 'sms_provider_not_found');
      return reply.send({ provider: result.rows[0] });
    });

    app.post('/v1/admin/sms/providers/:providerId/health', async (request, reply) => {
      requireAdmin(request);
      const providerId = requireUuidParam(request, 'providerId');
      const provider = await db.query('SELECT id, slug FROM sms_providers WHERE id = $1', [providerId]);
      if (!provider.rows[0]) throw new HttpError(404, 'SMS provider not found', 'sms_provider_not_found');
      const health = await smsProviders.health(provider.rows[0].slug);
      const enabled = await db.query<{ enabled: boolean }>('SELECT enabled FROM sms_providers WHERE id = $1', [providerId]);
      await db.query(
        `UPDATE sms_providers SET last_status = $2, last_status_message = $3, last_health_checked_at = now(), updated_at = now()
          WHERE id = $1`,
        [providerId, health.status, health.message],
      );
      return reply.send({
        provider: { id: providerId, slug: provider.rows[0].slug, enabled: enabled.rows[0]?.enabled ?? false },
        health: { ...health, checkedAt: new Date().toISOString() },
      });
    });

    app.get('/v1/admin/sms/services', async (request, reply) => {
      requireAdmin(request);
      const result = await db.query(
        `SELECT ${serviceFields}, p.slug AS "providerSlug", p.name AS "providerName",
                fp.slug AS "fallbackProviderSlug", fp.name AS "fallbackProviderName",
                fp.enabled AS "fallbackProviderEnabled"
           FROM sms_services s JOIN sms_providers p ON p.id = s.provider_id
           LEFT JOIN sms_providers fp ON fp.id = s.fallback_provider_id
          ORDER BY p.name ASC, s.name ASC`,
      );
      return reply.send({ services: result.rows });
    });

    app.post('/v1/admin/sms/providers/:providerId/services', async (request, reply) => {
      requireAdmin(request);
      const body = parseBody(createSmsServiceSchema, request.body);
      const providerId = requireUuidParam(request, 'providerId');
      const provider = await db.query('SELECT id FROM sms_providers WHERE id = $1', [providerId]);
      if (!provider.rows[0]) throw new HttpError(404, 'SMS provider not found', 'sms_provider_not_found');
      await validateFallback(db, body.fallbackProviderId, providerId);
      const result = await db.query(
        `INSERT INTO sms_services (id, provider_id, fallback_provider_id, slug, name, type, enabled,
            customer_price_per_sms_usd, provider_cost_per_sms_usd, markup_bps,
            otp_length, otp_expiry_seconds, otp_message_template, max_message_length, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
         RETURNING ${serviceColumns}`,
        [newId(), providerId, body.fallbackProviderId, body.slug, body.name, body.type, body.enabled,
          body.customerPricePerSmsUsd, body.providerCostPerSmsUsd, body.markupBps,
          body.otpLength, body.otpExpirySeconds, body.otpMessageTemplate, body.maxMessageLength,
          JSON.stringify(body.metadata)],
      );
      if (!result.rows[0]) throw new Error('SMS service insert returned no row');
      return reply.code(201).send({ service: camelService(result.rows[0]) });
    });

    app.put('/v1/admin/sms/services/:serviceId', async (request, reply) => {
      requireAdmin(request);
      const body = parseBody(updateSmsServiceSchema, request.body);
      const serviceId = requireUuidParam(request, 'serviceId');
      const existing = await db.query<{ provider_id: string }>(
        'SELECT provider_id FROM sms_services WHERE id = $1', [serviceId],
      );
      if (!existing.rows[0]) throw new HttpError(404, 'SMS service not found', 'sms_service_not_found');
      await validateFallback(db, body.fallbackProviderId, existing.rows[0].provider_id);
      const result = await db.query(
        `UPDATE sms_services SET slug = $2, name = $3, type = $4, enabled = $5,
            customer_price_per_sms_usd = $6, provider_cost_per_sms_usd = $7, markup_bps = $8,
            otp_length = $9, otp_expiry_seconds = $10, otp_message_template = $11,
            max_message_length = $12, metadata = $13::jsonb, fallback_provider_id = $14, updated_at = now()
          WHERE id = $1 RETURNING ${serviceColumns}`,
        [serviceId, body.slug, body.name, body.type, body.enabled,
          body.customerPricePerSmsUsd, body.providerCostPerSmsUsd, body.markupBps,
          body.otpLength, body.otpExpirySeconds, body.otpMessageTemplate, body.maxMessageLength,
          JSON.stringify(body.metadata), body.fallbackProviderId],
      );
      if (!result.rows[0]) throw new HttpError(404, 'SMS service not found', 'sms_service_not_found');
      return reply.send({ service: camelService(result.rows[0]) });
    });

    app.get('/v1/admin/sms/requests', async (request, reply) => {
      requireAdmin(request);
      const query = request.query as { limit?: string; status?: string };
      const result = await db.query(
        `SELECT r.id, r.merchant_id AS "merchantId", r.customer_id AS "customerId",
                s.slug AS service, p.slug AS provider, r.request_id AS "requestId", r.kind,
                r.provider_request_id AS "providerRequestId", r.provider_message_id AS "providerMessageId",
                r.status, r.failure_kind AS "failureKind", r.failure_message AS "failureMessage",
                r.attempts, r.units, r.usage_authoritative AS "usageAuthoritative", r.latency_ms AS "latencyMs",
                r.created_at AS "createdAt", r.completed_at AS "completedAt"
           FROM sms_provider_requests r JOIN sms_services s ON s.id = r.service_id
           JOIN sms_providers p ON p.id = r.provider_id
          WHERE ($1::text IS NULL OR r.status = $1)
          ORDER BY r.created_at DESC LIMIT $2`,
        [query.status ?? null, pageLimit(query.limit)],
      );
      return reply.send({ requests: result.rows });
    });

    app.get('/v1/admin/sms/usage', async (request, reply) => {
      requireAdmin(request);
      const query = request.query as { limit?: string; merchantId?: string };
      const result = await db.query(
        `SELECT u.id, u.merchant_id AS "merchantId", m.name AS merchant, u.customer_id AS "customerId",
                COALESCE(c.name, c.email, c.external_id, c.id::text) AS customer,
                s.slug AS service, p.slug AS provider, u.request_id AS "requestId", u.kind,
                u.units, u.customer_price_usd::text AS "customerPriceUsd",
                u.provider_cost_usd::text AS "providerCostUsd", u.profit_usd::text AS "profitUsd",
                u.credits_deducted_units::text AS "creditsDeductedUnits",
                u.credits_per_usdc_rate AS "creditsPerUsdcRate", u.created_at AS "createdAt"
           FROM sms_usage_records u JOIN merchants m ON m.id = u.merchant_id
           JOIN customers c ON c.id = u.customer_id JOIN sms_services s ON s.id = u.service_id
           JOIN sms_providers p ON p.id = u.provider_id
          WHERE ($1::uuid IS NULL OR u.merchant_id = $1)
          ORDER BY u.created_at DESC LIMIT $2`,
        [query.merchantId ?? null, pageLimit(query.limit)],
      );
      return reply.send({ usage: result.rows });
    });
  };
