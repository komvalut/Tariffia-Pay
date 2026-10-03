import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { requireMerchant, parseBody } from '../http.js';
import { createApiKey, newId } from '../security.js';
import { createApiKeySchema } from '../schemas.js';
import { DEFAULT_MERCHANT_SCOPES } from '../scopes.js';
import type { AuditLogService } from '../services/audit-log-service.js';

export const apiKeyRoutes: FastifyPluginAsync<{ db: Database; auditLog: AuditLogService }> = async (app, { db, auditLog }) => {
  app.get('/v1/api-keys', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const result = await db.query<{ status: string }>(
      `SELECT id, name, prefix, scopes, created_at AS "createdAt", last_used_at AS "lastUsedAt",
              revoked_at AS "revokedAt",
              CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status
         FROM api_keys WHERE merchant_id = $1 ORDER BY created_at ASC`,
      [merchant.id],
    );
    // Active keys first; revoked keys stay visible as history. Hashes and secrets are never selected.
    const apiKeys = [...result.rows].sort((left, right) =>
      (left.status === 'active' ? 0 : 1) - (right.status === 'active' ? 0 : 1));
    return reply.send({ apiKeys });
  });

  app.post('/v1/api-keys', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createApiKeySchema, request.body);
    const key = createApiKey();
    const scopes = body.scopes ?? DEFAULT_MERCHANT_SCOPES;
    const result = await db.query(
      `INSERT INTO api_keys (id, merchant_id, name, prefix, key_hash, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, prefix, scopes, created_at AS "createdAt"`,
      [newId(), merchant.id, body.name, key.prefix, key.hash, scopes],
    );
    // The plaintext secret is returned exactly once and is only ever stored as a pepper-hashed HMAC.
    await auditLog.record({
      actorType: 'merchant', actorId: merchant.id, action: 'api_key.create',
      resourceType: 'api_key', resourceId: result.rows[0]?.id as string,
      metadata: { name: body.name, prefix: key.prefix, scopes },
    });
    return reply.code(201).send({ apiKey: result.rows[0], secret: key.raw, warning: 'Store this API key now. It will not be shown again.' });
  });

  app.delete('/v1/api-keys/:keyId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { keyId } = request.params as { keyId: string };
    // Scoped by merchant so another merchant's key is indistinguishable from a missing one.
    const result = await db.query(
      `UPDATE api_keys SET revoked_at = now()
        WHERE id = $1 AND merchant_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [keyId, merchant.id],
    );
    if (!result.rows[0]) throw new HttpError(404, 'API key not found', 'not_found');
    await auditLog.record({
      actorType: 'merchant', actorId: merchant.id, action: 'api_key.revoke',
      resourceType: 'api_key', resourceId: keyId,
    });
    return reply.code(204).send();
  });
};
