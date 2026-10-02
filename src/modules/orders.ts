import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { parseBody, requireMerchant } from '../http.js';
import { createOrderSchema } from '../schemas.js';
import { orderStatusLabel, orderStatuses, paymentStatusLabel } from '../payment-status.js';
import type { PaymentCoreService } from '../services/payment-core-service.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

function orderView(row: Record<string, unknown>) {
  return {
    ...row,
    statusLabel: orderStatusLabel(String(row.status)),
    paymentStatusLabel: row.paymentStatus === null || row.paymentStatus === undefined
      ? null
      : paymentStatusLabel(String(row.paymentStatus)),
  };
}

export const orderRoutes: FastifyPluginAsync<{ db: Database; paymentCore: PaymentCoreService }> = async (app, { db, paymentCore }) => {
  app.get('/v1/orders', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const query = request.query as { limit?: string; status?: string };
    const status = query.status?.trim() ? query.status.trim() : null;
    if (status && !orderStatuses.includes(status as (typeof orderStatuses)[number])) {
      throw new HttpError(400, 'Unknown order status filter', 'invalid_order_status');
    }
    const result = await db.query(
      `SELECT o.id, o.customer_id AS "customerId", o.reference, o.description, o.amount::text AS amount,
              o.currency, o.status, o.created_at AS "createdAt", o.updated_at AS "updatedAt",
              p.id AS "paymentId", p.status AS "paymentStatus", p.network, p.tx_hash AS "transactionId",
              p.detected_at AS "detectedAt", p.confirmed_at AS "confirmedAt", p.expires_at AS "expiresAt"
         FROM orders o LEFT JOIN payments p ON p.order_id = o.id
        WHERE o.merchant_id = $1 AND ($2::text IS NULL OR o.status = $2)
        ORDER BY o.created_at DESC, o.id DESC LIMIT $3`,
      [merchant.id, status, pageLimit(query.limit)],
    );
    return reply.send({ orders: result.rows.map(orderView) });
  });

  app.get('/v1/orders/:orderId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { orderId } = request.params as { orderId: string };
    const result = await db.query(
      `SELECT o.id, o.customer_id AS "customerId", o.reference, o.description, o.amount::text AS amount,
              o.currency, o.status, o.metadata, o.created_at AS "createdAt", o.updated_at AS "updatedAt",
              p.id AS "paymentId", p.status AS "paymentStatus", p.network, p.recipient_address AS "recipientAddress",
               p.token_address AS "tokenAddress", p.tx_hash AS "txHash", p.tx_hash AS "transactionId",
               p.detected_at AS "detectedAt", p.confirmed_at AS "confirmedAt", p.expires_at AS "expiresAt"
         FROM orders o JOIN payments p ON p.order_id = o.id
        WHERE o.id = $1 AND o.merchant_id = $2`,
      [orderId, merchant.id],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Order not found', 'not_found');
    return reply.send({ order: orderView(result.rows[0]) });
  });

  app.post('/v1/orders', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createOrderSchema, request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') throw new HttpError(400, 'Idempotency-Key header is required', 'missing_idempotency_key');
    const result = await paymentCore.createPaymentLink({
      merchant,
      body,
      idempotencyKey,
      scope: `merchant:${merchant.id}:POST:/v1/orders`,
    });
    return reply.header('Idempotency-Replayed', String(result.replayed)).code(result.status).send(result.body);
  });
};
