import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { requireMerchant } from '../http.js';

export const paymentRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/v1/payments/:paymentId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { paymentId } = request.params as { paymentId: string };
    const result = await db.query(
      `SELECT id, order_id AS "orderId", amount::text AS amount, currency, adapter, network,
              recipient_address AS "recipientAddress", token_address AS "tokenAddress", status,
              tx_hash AS "txHash", expires_at AS "expiresAt", detected_at AS "detectedAt",
              confirmed_at AS "confirmedAt", created_at AS "createdAt"
         FROM payments WHERE id = $1 AND merchant_id = $2`,
      [paymentId, merchant.id],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Payment not found', 'not_found');
    return reply.send({ payment: result.rows[0] });
  });
};
