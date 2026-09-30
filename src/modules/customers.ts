import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { createCustomerSchema } from '../schemas.js';
import { newId } from '../security.js';
import { parseBody, requireMerchant } from '../http.js';

export const customerRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
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

  app.get('/v1/customers/:customerId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { customerId } = request.params as { customerId: string };
    const result = await db.query(
      `SELECT id, external_id AS "externalId", email, name, metadata, created_at AS "createdAt"
         FROM customers WHERE id = $1 AND merchant_id = $2`,
      [customerId, merchant.id],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Customer not found', 'not_found');
    return reply.send({ customer: result.rows[0] });
  });
};
