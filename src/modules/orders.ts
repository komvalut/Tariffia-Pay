import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { runIdempotently } from '../idempotency.js';
import { createOrderSchema } from '../schemas.js';
import { newId } from '../security.js';
import { parseBody, requireMerchant } from '../http.js';

export const orderRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.post('/v1/orders', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createOrderSchema, request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') throw new HttpError(400, 'Idempotency-Key header is required', 'missing_idempotency_key');
    const outcome = await runIdempotently({
      db,
      scope: `merchant:${merchant.id}:POST:/v1/orders`,
      key: idempotencyKey,
      request: body,
      work: async (client) => {
        if (body.customerId) {
          const customer = await client.query('SELECT id FROM customers WHERE id = $1 AND merchant_id = $2', [body.customerId, merchant.id]);
          if (!customer.rows[0]) throw new HttpError(404, 'Customer not found for this merchant', 'customer_not_found');
        }
        const orderId = newId();
        const paymentId = newId();
        const order = await client.query(
          `INSERT INTO orders (id, merchant_id, customer_id, reference, description, amount, currency, status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, 'USDC', 'PENDING', $7::jsonb)
           RETURNING id, customer_id AS "customerId", reference, description, amount::text AS amount,
             currency, status, metadata, created_at AS "createdAt"`,
          [orderId, merchant.id, body.customerId ?? null, body.reference ?? null, body.description, body.amount, JSON.stringify(body.metadata)],
        );
        const payment = await client.query(
          `INSERT INTO payments (id, merchant_id, order_id, amount, currency, adapter, network, recipient_address, status, idempotency_key)
           VALUES ($1, $2, $3, $4, 'USDC', 'usdc', 'base', $5, 'PENDING', $6)
           RETURNING id, order_id AS "orderId", amount::text AS amount, currency, adapter, network,
             recipient_address AS "recipientAddress", status, tx_hash AS "txHash", created_at AS "createdAt"`,
          [paymentId, merchant.id, orderId, body.amount, merchant.wallet_address, idempotencyKey],
        );
        await client.query(
          `INSERT INTO ledger_entries (id, merchant_id, order_id, payment_id, entry_type, amount, currency, reference, metadata)
           VALUES ($1, $2, $3, $4, 'PAYMENT_CREATED', $5, 'USDC', $6, $7::jsonb)`,
          [newId(), merchant.id, orderId, paymentId, body.amount, paymentId, JSON.stringify({ status: 'PENDING' })],
        );
        return { status: 201, body: { order: order.rows[0], payment: payment.rows[0] } };
      },
    });
    return reply.header('Idempotency-Replayed', String(outcome.replayed)).code(outcome.status).send(outcome.body);
  });

  app.get('/v1/orders/:orderId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { orderId } = request.params as { orderId: string };
    const result = await db.query(
      `SELECT o.id, o.customer_id AS "customerId", o.reference, o.description, o.amount::text AS amount,
              o.currency, o.status, o.metadata, o.created_at AS "createdAt",
              p.id AS "paymentId", p.status AS "paymentStatus", p.network, p.recipient_address AS "recipientAddress",
              p.tx_hash AS "txHash", p.expires_at AS "expiresAt"
         FROM orders o JOIN payments p ON p.order_id = o.id
        WHERE o.id = $1 AND o.merchant_id = $2`,
      [orderId, merchant.id],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Order not found', 'not_found');
    return reply.send({ order: result.rows[0] });
  });
};
