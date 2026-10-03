import type { FastifyPluginAsync } from 'fastify';
import type { PoolClient } from 'pg';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { createCustomerSchema } from '../schemas.js';
import { newId } from '../security.js';
import { parseBody, requireMerchant } from '../http.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

type CustomerCounts = { orderCount: number; paymentCount: number };

type CustomerRow = {
  id: string;
  externalId: string | null;
  email: string | null;
  name: string | null;
  metadata: Record<string, unknown> | string;
  createdAt: Date;
};

type CustomerInput = {
  externalId?: string;
  email?: string;
  name?: string;
  metadata: Record<string, unknown>;
};

const customerColumns = `id, external_id AS "externalId", email, name, metadata, created_at AS "createdAt"`;

// Email is the fallback identity key when no external id is supplied. Matching normalizes to
// lowercase (the request schema already trims), so case/whitespace variants resolve to one customer.
export function normalizeCustomerEmail(email: string | undefined): string | null {
  return email ? email.trim().toLowerCase() : null;
}

function metadataObject(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
  }
  return value;
}

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

  // Applies the request onto an existing customer: only provided fields change, metadata is merged,
  // and an optional external id is attached when promoting an email-only customer.
  async function applyUpdate(
    client: PoolClient,
    merchantId: string,
    existing: CustomerRow,
    body: CustomerInput,
    normalizedEmail: string | null,
    attachExternalId = false,
  ): Promise<CustomerRow> {
    const metadata = { ...metadataObject(existing.metadata), ...body.metadata };
    const updated = await client.query<CustomerRow>(
      `UPDATE customers
          SET external_id = COALESCE($3, external_id),
              email = COALESCE($4, email),
              name = COALESCE($5, name),
              metadata = $6::jsonb
        WHERE id = $1 AND merchant_id = $2
        RETURNING ${customerColumns}`,
      [existing.id, merchantId, attachExternalId ? body.externalId ?? null : null, normalizedEmail,
        body.name ?? null, JSON.stringify(metadata)],
    );
    return updated.rows[0]!;
  }

  app.post('/v1/customers', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createCustomerSchema, request.body);
    const normalizedEmail = normalizeCustomerEmail(body.email);
    // Identity resolution, in priority order, scoped to the authenticated merchant:
    //   1. an explicit external_id match (the stable external identity),
    //   2. an email-only customer promoted with a new external_id (no duplicate by email),
    //   3. an email match when no external_id is supplied (idempotent create by email).
    const customer = await db.transaction(async (client) => {
      if (body.externalId) {
        const byExternal = await client.query<CustomerRow>(
          `SELECT ${customerColumns} FROM customers WHERE merchant_id = $1 AND external_id = $2`,
          [merchant.id, body.externalId],
        );
        if (byExternal.rows[0]) {
          return applyUpdate(client, merchant.id, byExternal.rows[0], body, normalizedEmail);
        }
        if (normalizedEmail) {
          const emailOnly = await client.query<CustomerRow>(
            `SELECT ${customerColumns} FROM customers
              WHERE merchant_id = $1 AND external_id IS NULL AND lower(email) = $2
              ORDER BY created_at ASC, id ASC LIMIT 1`,
            [merchant.id, normalizedEmail],
          );
          if (emailOnly.rows[0]) {
            return applyUpdate(client, merchant.id, emailOnly.rows[0], body, normalizedEmail, true);
          }
        }
      } else if (normalizedEmail) {
        const byEmail = await client.query<CustomerRow>(
          `SELECT ${customerColumns} FROM customers
            WHERE merchant_id = $1 AND lower(email) = $2
            ORDER BY created_at ASC, id ASC LIMIT 1`,
          [merchant.id, normalizedEmail],
        );
        if (byEmail.rows[0]) {
          return applyUpdate(client, merchant.id, byEmail.rows[0], body, normalizedEmail);
        }
      }
      const inserted = await client.query<CustomerRow>(
        `INSERT INTO customers (id, merchant_id, external_id, email, name, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING ${customerColumns}`,
        [newId(), merchant.id, body.externalId ?? null, normalizedEmail, body.name ?? null, JSON.stringify(body.metadata)],
      );
      return inserted.rows[0]!;
    });
    return reply.code(201).send({ customer });
  });
};
