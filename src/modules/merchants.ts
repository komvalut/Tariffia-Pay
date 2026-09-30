import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { createMerchantSchema } from '../schemas.js';
import { createApiKey, newId } from '../security.js';
import { parseBody, requireAdmin } from '../http.js';

export const merchantRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.post('/v1/admin/merchants', async (request, reply) => {
    requireAdmin(request);
    const body = parseBody(createMerchantSchema, request.body);
    const merchantId = newId();
    const apiKeyId = newId();
    const apiKey = createApiKey();
    const merchant = await db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO merchants (id, name, email, wallet_address) VALUES ($1, $2, lower($3), lower($4))
         RETURNING id, name, email, wallet_address, status, created_at`,
        [merchantId, body.name, body.email, body.walletAddress],
      );
      await client.query(
        'INSERT INTO api_keys (id, merchant_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4, $5)',
        [apiKeyId, merchantId, body.apiKeyName, apiKey.prefix, apiKey.hash],
      );
      return inserted.rows[0];
    });
    return reply.code(201).send({ merchant, apiKey: apiKey.raw, warning: 'Store this API key now. It will not be shown again.' });
  });
};
