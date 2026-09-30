import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { parseBody, requireMerchant } from '../http.js';
import { createWebhookSchema, updateWebhookSchema } from '../schemas.js';
import { newId } from '../security.js';
import { encryptWebhookSecret } from '../webhooks/secret-crypto.js';
import { validateWebhookUrl } from '../webhooks/url.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

export const webhookRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/v1/webhooks', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const result = await db.query(
      `SELECT id, name, url, events, enabled, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM webhook_endpoints WHERE merchant_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [merchant.id],
    );
    return reply.send({ endpoints: result.rows });
  });

  app.post('/v1/webhooks', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createWebhookSchema, request.body);
    const url = await validateWebhookUrl(body.url);
    const encrypted = encryptWebhookSecret(body.secret);
    const result = await db.query(
      `INSERT INTO webhook_endpoints (id, merchant_id, name, url, events, secret_ciphertext, secret_nonce, secret_auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, url, events, enabled, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [newId(), merchant.id, body.name, url, body.events, encrypted.ciphertext, encrypted.nonce, encrypted.authTag],
    );
    return reply.code(201).send({ endpoint: result.rows[0] });
  });

  app.patch('/v1/webhooks/:endpointId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(updateWebhookSchema, request.body);
    const { endpointId } = request.params as { endpointId: string };
    const currentResult = await db.query<{
      id: string; name: string; url: string; events: string[]; enabled: boolean;
      secret_ciphertext: string; secret_nonce: string; secret_auth_tag: string;
    }>(
      `SELECT id, name, url, events, enabled, secret_ciphertext, secret_nonce, secret_auth_tag
         FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL`,
      [endpointId, merchant.id],
    );
    const current = currentResult.rows[0];
    if (!current) throw new HttpError(404, 'Webhook endpoint not found', 'not_found');
    const url = body.url ? await validateWebhookUrl(body.url) : current.url;
    const secret = body.secret ? encryptWebhookSecret(body.secret) : {
      ciphertext: current.secret_ciphertext,
      nonce: current.secret_nonce,
      authTag: current.secret_auth_tag,
    };
    const enabled = body.enabled ?? current.enabled;
    const updated = await db.transaction(async (client) => {
      const endpoint = await client.query(
        `UPDATE webhook_endpoints
            SET name = $3, url = $4, events = $5, enabled = $6,
                secret_ciphertext = $7, secret_nonce = $8, secret_auth_tag = $9, updated_at = now()
          WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL
          RETURNING id, name, url, events, enabled, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [endpointId, merchant.id, body.name ?? current.name, url, body.events ?? current.events, enabled,
          secret.ciphertext, secret.nonce, secret.authTag],
      );
      if (!enabled) {
        await client.query(
          `UPDATE webhook_deliveries SET status = 'CANCELLED', updated_at = now()
            WHERE endpoint_id = $1 AND status IN ('QUEUED', 'RETRYING')`,
          [endpointId],
        );
      }
      return endpoint.rows[0];
    });
    return reply.send({ endpoint: updated });
  });

  app.delete('/v1/webhooks/:endpointId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { endpointId } = request.params as { endpointId: string };
    const deleted = await db.transaction(async (client) => {
      const endpoint = await client.query(
        `UPDATE webhook_endpoints SET enabled = false, deleted_at = COALESCE(deleted_at, now()), updated_at = now()
          WHERE id = $1 AND merchant_id = $2 RETURNING id`,
        [endpointId, merchant.id],
      );
      if (!endpoint.rows[0]) return false;
      await client.query(
        `UPDATE webhook_deliveries SET status = 'CANCELLED', updated_at = now()
          WHERE endpoint_id = $1 AND status IN ('QUEUED', 'RETRYING')`,
        [endpointId],
      );
      return true;
    });
    if (!deleted) throw new HttpError(404, 'Webhook endpoint not found', 'not_found');
    return reply.code(204).send();
  });

  app.get('/v1/webhooks/:endpointId/deliveries', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { endpointId } = request.params as { endpointId: string };
    const query = request.query as { limit?: string; before?: string };
    const result = await db.query(
      `SELECT d.id, d.event_id AS "eventId", e.event_type AS event, d.status, d.attempts,
              d.next_attempt_at AS "nextAttemptAt", d.last_http_status AS "lastHttpStatus",
              d.last_error AS "lastError", d.delivered_at AS "deliveredAt", d.created_at AS "createdAt"
         FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id
         JOIN webhook_endpoints ep ON ep.id = d.endpoint_id
        WHERE ep.id = $1 AND ep.merchant_id = $2 AND ($3::timestamptz IS NULL OR d.created_at < $3)
        ORDER BY d.created_at DESC, d.id DESC LIMIT $4`,
      [endpointId, merchant.id, query.before ?? null, pageLimit(query.limit)],
    );
    return reply.send({ deliveries: result.rows });
  });

  app.get('/v1/webhooks/:endpointId/deliveries/:deliveryId/attempts', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { endpointId, deliveryId } = request.params as { endpointId: string; deliveryId: string };
    const result = await db.query(
      `SELECT a.id, a.attempt_number AS "attemptNumber", a.request_timestamp AS "requestTimestamp",
              a.started_at AS "startedAt", a.finished_at AS "finishedAt", a.http_status AS "httpStatus", a.error
         FROM webhook_delivery_attempts a JOIN webhook_deliveries d ON d.id = a.delivery_id
         JOIN webhook_endpoints ep ON ep.id = d.endpoint_id
        WHERE ep.id = $1 AND ep.merchant_id = $2 AND d.id = $3
        ORDER BY a.attempt_number ASC`,
      [endpointId, merchant.id, deliveryId],
    );
    return reply.send({ attempts: result.rows });
  });
};
