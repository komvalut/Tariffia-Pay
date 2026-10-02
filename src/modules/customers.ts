import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { createCustomerSchema } from '../schemas.js';
import { newId } from '../security.js';
import { parseBody, requireMerchant } from '../http.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

type CustomerCounts = { orderCount: number; paymentCount: number };

export const customerRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/v1/customers', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const query = request.query as { limit?: string };
    const customers = await db.query(
      `SELECT id, external_id AS "externalId", email, name, metadata, created_at AS "createdAt"
         FROM customers WHERE merchant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [merchant.id, pageLimit(query.limit)],
    );
    // Basic order/payment counts from the existing records, aggregated per customer.
    const orders = await db.query<{ customerId: string; orderCount: number }>(
      `SELECT o.customer_id AS "customerId", count(*)::int AS "orderCount"
         FROM orders o WHERE o.merchant_id = $1 AND o.customer_id IS NOT NULL GROUP BY o.customer_id`,
      [merchant.id],
    );
    const payments = await db.query<{ customerId: string; paymentCount: number }>(
      `SELECT o.customer_id AS "customerId", count(*)::int AS "paymentCount"
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.merchant_id = $1 AND o.customer_id IS NOT NULL GROUP BY o.customer_id`,
      [merchant.id],
    );
    const orderCounts = new Map(orders.rows.map((row) => [row.customerId, row.orderCount]));
    const paymentCounts = new Map(payments.rows.map((row) => [row.customerId, row.paymentCount]));
    return reply.send({ customers: customers.rows.map((customer) => ({
      ...customer,
      orderCount: orderCounts.get(customer.id as string) ?? 0,
      paymentCount: paymentCounts.get(customer.id as string) ?? 0,
    })) });
  });

  app.get('/v1/customers/:customerId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { customerId } = request.params as { customerId: string };
    const result = await db.query(
      `SELECT id, external_id AS "externalId", email, name, metadata, created_at AS "createdAt"
         FROM customers WHERE id = $1 AND merchant_id = $2`,
      [customerId, merchant.id],
    );
    const customer = result.rows[0];
    if (!customer) throw new HttpError(404, 'Customer not found', 'not_found');
    const orders = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM orders WHERE customer_id = $1 AND merchant_id = $2',
      [customerId, merchant.id],
    );
    const payments = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE o.customer_id = $1 AND p.merchant_id = $2`,
      [customerId, merchant.id],
    );
    const counts: CustomerCounts = {
      orderCount: orders.rows[0]?.count ?? 0,
      paymentCount: payments.rows[0]?.count ?? 0,
    };
    return reply.send({ customer: { ...customer, ...counts } });
  });

  app.post('/v1/customers', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createCustomerSchema, request.body);
    const inserted = await db.query(
      `INSERT INTO customers (id, merchant_id, external_id, email, name, metadata)
       VALUES ($1, $2, $3, lower($4), $5, $6::jsonb)
       ON CONFLICT (merchant_id, external_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, customers.email),
         name = COALESCE(EXCLUDED.name, customers.name), metadata = customers.metadata || EXCLUDED.metadata
       RETURNING id, external_id AS "externalId", email, name, metadata, created_at AS "createdAt"`,
      [newId(), merchant.id, body.externalId ?? null, body.email ?? null, body.name ?? null, JSON.stringify(body.metadata)],
    );
    return reply.code(201).send({ customer: inserted.rows[0] });
  });
};
