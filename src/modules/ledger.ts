import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { requireMerchant } from '../http.js';
import { parsePagination, paginate } from '../pagination.js';

export const ledgerRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/v1/ledger', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const query = request.query as { limit?: string; offset?: string };
    const { limit, offset } = parsePagination(query);
    const result = await db.query(
      `SELECT id, order_id AS "orderId", payment_id AS "paymentId", entry_type AS "entryType",
              amount::text AS amount, currency, reference, metadata, created_at AS "createdAt"
         FROM ledger_entries WHERE merchant_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [merchant.id, limit + 1, offset],
    );
    const page = paginate(result.rows, limit, offset);
    return reply.send({ entries: page.items, pagination: page.pagination });
  });
};
