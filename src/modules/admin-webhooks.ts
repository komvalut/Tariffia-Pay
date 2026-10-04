import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { requireAdmin, requireUuidParam } from '../http.js';
import { sanitizeStoredWebhookError } from '../webhooks/error-safety.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

export const adminWebhookRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/v1/admin/webhook-deliveries', async (request, reply) => {
    requireAdmin(request);
    const query = request.query as { limit?: string; status?: string };
    const result = await db.query(
      `SELECT d.id, d.event_id AS "eventId", e.event_type AS event, d.status, d.attempts,
              d.last_http_status AS "lastHttpStatus", d.last_error AS "lastError",
              d.next_attempt_at AS "nextAttemptAt", d.delivered_at AS "deliveredAt",
              d.created_at AS "createdAt", ep.id AS "endpointId", ep.name AS "endpointName", ep.url,
              m.id AS "merchantId", m.name AS merchant
         FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id
         JOIN webhook_endpoints ep ON ep.id = d.endpoint_id
         JOIN merchants m ON m.id = ep.merchant_id
        WHERE ($1::text IS NULL OR d.status = $1)
        ORDER BY d.created_at DESC LIMIT $2`,
      [query.status ?? null, pageLimit(query.limit)],
    );
    return reply.send({ deliveries: result.rows.map((row) => {
      const { url, lastError, ...delivery } = row as Record<string, unknown>;
      return {
        ...delivery,
        url: new URL(String(url)).origin,
        lastError: sanitizeStoredWebhookError(typeof lastError === 'string' ? lastError : null,
          typeof delivery.lastHttpStatus === 'number' ? delivery.lastHttpStatus : null),
      };
    }) });
  });

  app.get('/v1/admin/webhook-deliveries/:deliveryId/attempts', async (request, reply) => {
    requireAdmin(request);
    const deliveryId = requireUuidParam(request, 'deliveryId');
    const result = await db.query(
      `SELECT a.id, a.attempt_number AS "attemptNumber", a.request_timestamp AS "requestTimestamp",
              a.started_at AS "startedAt", a.finished_at AS "finishedAt", a.http_status AS "httpStatus", a.error
         FROM webhook_delivery_attempts a WHERE a.delivery_id = $1 ORDER BY a.attempt_number ASC`,
      [deliveryId],
    );
    return reply.send({ attempts: result.rows.map((row) => {
      const { error, ...attempt } = row as Record<string, unknown>;
      return { ...attempt, error: sanitizeStoredWebhookError(typeof error === 'string' ? error : null,
        typeof attempt.httpStatus === 'number' ? attempt.httpStatus : null) };
    }) });
  });
};
