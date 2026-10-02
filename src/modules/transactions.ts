import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { requireMerchant } from '../http.js';

const paymentStatuses = ['CREATED', 'PENDING', 'DETECTED', 'VERIFYING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'REFUNDED'] as const;

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

// Transactions are a merchant-facing view over existing payment records; no new data is stored.
const transactionSelect = `SELECT p.id AS "paymentId", p.order_id AS "orderId", o.description,
  p.amount::text AS amount, p.currency, p.status, p.network, p.adapter,
  p.tx_hash AS "transactionId", p.tx_hash AS "transactionHash",
  p.detected_at AS "detectedAt", p.confirmed_at AS "confirmedAt", p.expires_at AS "expiresAt",
  p.created_at AS "createdAt"
  FROM payments p JOIN orders o ON o.id = p.order_id
 WHERE p.merchant_id = $1`;

export const transactionRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/v1/transactions', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const query = request.query as { limit?: string; status?: string; network?: string };
    const status = query.status?.trim() ? query.status.trim() : null;
    if (status && !paymentStatuses.includes(status as (typeof paymentStatuses)[number])) {
      throw new HttpError(400, 'Unknown payment status filter', 'invalid_transaction_status');
    }
    const network = query.network?.trim() ? query.network.trim() : null;
    if (network && network.length > 64) {
      throw new HttpError(400, 'Unknown network filter', 'invalid_transaction_network');
    }
    const result = await db.query(
      `${transactionSelect}
        AND ($2::text IS NULL OR p.status = $2)
        AND ($3::text IS NULL OR p.network = $3)
        ORDER BY p.created_at DESC, p.id DESC LIMIT $4`,
      [merchant.id, status, network, pageLimit(query.limit)],
    );
    return reply.send({ transactions: result.rows });
  });

  app.get('/v1/transactions/:paymentId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { paymentId } = request.params as { paymentId: string };
    const result = await db.query(`${transactionSelect} AND p.id = $2`, [merchant.id, paymentId]);
    if (!result.rows[0]) throw new HttpError(404, 'Transaction not found', 'not_found');
    return reply.send({ transaction: result.rows[0] });
  });
};
