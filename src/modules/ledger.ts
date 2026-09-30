import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { requireMerchant } from '../http.js';

export const ledgerRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/v1/ledger', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const query = request.query as { limit?: string; before?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
    const result = await db.query(
      `SELECT id, order_id AS "orderId", payment_id AS "paymentId", entry_type AS "entryType",
              amount::text AS amount, currency, reference, metadata, created_at AS "createdAt"
         FROM ledger_entries WHERE merchant_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [merchant.id, query.before ?? null, limit],
    );
    return reply.send({ entries: result.rows });
  });
};
