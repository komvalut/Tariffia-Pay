import { readFile } from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAdmin, requireMerchant } from '../http.js';
import { sanitizeStoredWebhookError } from '../webhooks/error-safety.js';

type DashboardQuery = { q?: string; status?: string; page?: string; limit?: string };
type Collection = {
  select: string;
  from: string;
  search: string[];
  orderBy: string;
  status?: string;
  filter?: string;
  tenant?: string;
};

const adminHtml = readFile(new URL('../../web/admin.html', import.meta.url), 'utf8');
const merchantHtml = readFile(new URL('../../web/merchant.html', import.meta.url), 'utf8');
const dashboardCss = readFile(new URL('../../web/dashboard.css', import.meta.url), 'utf8');
const dashboardJs = readFile(new URL('../../web/dashboard.js', import.meta.url), 'utf8');

function pageNumber(value: string | undefined): number {
  return Math.min(Math.max(Math.trunc(Number(value ?? 1)) || 1, 1), 10_000);
}

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Math.trunc(Number(value ?? 25)) || 25, 1), 100);
}

async function listCollection(db: Database, collection: Collection, query: DashboardQuery, merchantId?: string) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (merchantId) {
    values.push(merchantId);
    where.push(collection.tenant ?? 'merchant_id = $1');
  }
  if (collection.filter) where.push(collection.filter);
  const search = query.q?.trim().slice(0, 120);
  if (search) {
    values.push(`%${search}%`);
    const index = values.length;
    where.push(`concat_ws(' ', ${collection.search.join(', ')}) ILIKE $${index}`);
  }
  if (query.status && collection.status) {
    values.push(query.status.slice(0, 32));
    where.push(`${collection.status} = $${values.length}`);
  }
  const page = pageNumber(query.page);
  const limit = pageLimit(query.limit);
  values.push(limit + 1, (page - 1) * limit);
  const result = await db.query(
    `SELECT ${collection.select} FROM ${collection.from}
      WHERE ${where.length ? where.join(' AND ') : 'TRUE'}
      ORDER BY ${collection.orderBy} LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const hasMore = result.rows.length > limit;
  return { items: hasMore ? result.rows.slice(0, limit) : result.rows, page, limit, hasMore };
}

const adminCollections: Record<string, Collection> = {
  merchants: {
    select: `m.id, m.name, m.email, m.wallet_address AS "walletAddress", m.status, m.created_at AS "createdAt"`,
    from: 'merchants m', search: ['m.name', 'm.email', 'm.id::text'], orderBy: 'm.created_at DESC', status: 'm.status',
  },
  customers: {
    select: `c.id, c.merchant_id AS "merchantId", m.name AS merchant, c.external_id AS "externalId",
      c.email, c.name, c.created_at AS "createdAt"`,
    from: 'customers c JOIN merchants m ON m.id = c.merchant_id', search: ['c.name', 'c.email', 'c.external_id', 'm.name'], orderBy: 'c.created_at DESC',
  },
  orders: {
    select: `o.id, o.merchant_id AS "merchantId", m.name AS merchant, o.customer_id AS "customerId",
      COALESCE(c.name, c.email, c.external_id) AS customer, o.reference, o.description,
      o.amount::text AS amount, o.currency, o.status, o.created_at AS "createdAt", p.id AS "paymentId", p.status AS "paymentStatus"`,
    from: 'orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN payments p ON p.order_id = o.id',
    search: ['m.name', 'o.reference', 'o.description', 'c.email', 'o.id::text'], orderBy: 'o.created_at DESC', status: 'o.status',
  },
  payments: {
    select: `p.id, p.order_id AS "orderId", p.merchant_id AS "merchantId", m.name AS merchant,
      o.description, p.amount::text AS amount, p.currency, p.network, p.status, p.tx_hash AS "transactionHash",
      p.recipient_address AS recipient, p.created_at AS "createdAt", p.confirmed_at AS "confirmedAt", p.failure_reason AS "failureReason"`,
    from: 'payments p JOIN merchants m ON m.id = p.merchant_id JOIN orders o ON o.id = p.order_id',
    search: ['m.name', 'o.description', 'p.tx_hash', 'p.id::text'], orderBy: 'p.created_at DESC', status: 'p.status',
  },
  'usdc-transactions': {
    select: `p.id, p.merchant_id AS "merchantId", m.name AS merchant, p.tx_hash AS "transactionHash",
      p.amount::text AS amount, p.currency, p.network, p.status, p.confirmed_at AS "confirmedAt", p.created_at AS "createdAt"`,
    from: 'payments p JOIN merchants m ON m.id = p.merchant_id',
    search: ['m.name', 'p.tx_hash', 'p.id::text'], orderBy: 'p.confirmed_at DESC NULLS LAST',
    filter: "p.currency = 'USDC' AND p.tx_hash IS NOT NULL",
  },
  'failed-payments': {
    select: `p.id, p.merchant_id AS "merchantId", m.name AS merchant, o.description, p.amount::text AS amount,
      p.currency, p.status, p.failure_reason AS "failureReason", p.tx_hash AS "transactionHash", p.updated_at AS "updatedAt"`,
    from: 'payments p JOIN merchants m ON m.id = p.merchant_id JOIN orders o ON o.id = p.order_id',
    search: ['m.name', 'o.description', 'p.failure_reason', 'p.id::text'], orderBy: 'p.updated_at DESC', status: 'p.status',
    filter: "p.status IN ('FAILED', 'EXPIRED')",
  },
  'credit-accounts': {
    select: `a.id, a.merchant_id AS "merchantId", m.name AS merchant, a.customer_id AS "customerId",
      COALESCE(c.name, c.email, c.external_id, c.id::text) AS customer, a.balance_units::text AS "balanceUnits",
      a.updated_at AS "updatedAt"`,
    from: 'credit_accounts a JOIN merchants m ON m.id = a.merchant_id JOIN customers c ON c.id = a.customer_id',
    search: ['m.name', 'c.name', 'c.email', 'c.external_id'], orderBy: 'a.updated_at DESC',
  },
  'credit-transactions': {
    select: `t.id, t.merchant_id AS "merchantId", m.name AS merchant, t.customer_id AS "customerId",
      COALESCE(c.name, c.email, c.external_id) AS customer, t.transaction_type AS type,
      t.credit_units::text AS "creditUnits", t.balance_after_units::text AS "balanceAfterUnits",
      t.reference, t.created_at AS "createdAt"`,
    from: 'credit_transactions t JOIN merchants m ON m.id = t.merchant_id JOIN customers c ON c.id = t.customer_id',
    search: ['m.name', 'c.name', 'c.email', 't.reference'], orderBy: 't.created_at DESC', status: 't.transaction_type',
  },
  'ai-providers': {
    select: `p.id, p.slug, p.name, p.enabled, p.created_at AS "createdAt"`,
    from: 'ai_providers p', search: ['p.slug', 'p.name'], orderBy: 'p.name ASC', status: 'p.enabled::text',
  },
  'ai-models': {
    select: `am.id, p.id AS "providerId", p.slug AS provider, am.slug, am.name, am.enabled,
      am.pricing_mode AS "pricingMode", am.provider_cost_per_request_usd::text AS "providerCostPerRequestUsd",
      am.customer_price_per_request_usd::text AS "customerPricePerRequestUsd",
      am.provider_input_cost_per_1k_usd::text AS "providerInputCostPer1kUsd",
      am.customer_input_price_per_1k_usd::text AS "customerInputPricePer1kUsd",
      am.provider_output_cost_per_1k_usd::text AS "providerOutputCostPer1kUsd",
      am.customer_output_price_per_1k_usd::text AS "customerOutputPricePer1kUsd", am.markup_bps AS "markupBps"`,
    from: 'ai_models am JOIN ai_providers p ON p.id = am.provider_id', search: ['p.name', 'p.slug', 'am.name', 'am.slug'],
    orderBy: 'p.name ASC, am.name ASC', status: 'am.enabled::text',
  },
  usage: {
    select: `u.id, u.merchant_id AS "merchantId", me.name AS merchant, u.customer_id AS "customerId",
      COALESCE(c.name, c.email, c.external_id) AS customer, p.slug AS provider, am.slug AS model,
      u.request_id AS "requestId", u.input_tokens AS "inputTokens", u.output_tokens AS "outputTokens",
      u.provider_cost_usd::text AS "providerCostUsd", u.customer_price_usd::text AS "customerPriceUsd",
      u.profit_usd::text AS "profitUsd", u.credits_deducted_units::text AS "creditsDeductedUnits",
      u.created_at AS "createdAt"`,
    from: 'ai_usage_records u JOIN merchants me ON me.id = u.merchant_id JOIN customers c ON c.id = u.customer_id JOIN ai_providers p ON p.id = u.provider_id JOIN ai_models am ON am.id = u.model_id',
    search: ['me.name', 'c.name', 'c.email', 'p.slug', 'am.slug', 'u.request_id'], orderBy: 'u.created_at DESC',
  },
  'webhook-endpoints': {
    select: `ep.id, ep.merchant_id AS "merchantId", m.name AS merchant, ep.name, ep.url,
      ep.events, ep.enabled, ep.created_at AS "createdAt"`,
    from: 'webhook_endpoints ep JOIN merchants m ON m.id = ep.merchant_id',
    search: ['m.name', 'ep.name', 'ep.url'], orderBy: 'ep.created_at DESC', filter: 'ep.deleted_at IS NULL', status: 'ep.enabled::text',
  },
  'webhook-deliveries': {
    select: `d.id, ep.merchant_id AS "merchantId", m.name AS merchant, ep.name AS endpoint,
      e.event_type AS event, d.status, d.attempts, d.last_http_status AS "lastHttpStatus",
      d.last_error AS "lastError", d.created_at AS "createdAt", d.delivered_at AS "deliveredAt"`,
    from: 'webhook_deliveries d JOIN webhook_endpoints ep ON ep.id = d.endpoint_id JOIN merchants m ON m.id = ep.merchant_id JOIN webhook_events e ON e.id = d.event_id',
    search: ['m.name', 'ep.name', 'e.event_type', 'd.last_error'], orderBy: 'd.created_at DESC', status: 'd.status',
  },
};

const merchantCollections: Record<string, Collection> = {
  customers: {
    select: `c.id, c.external_id AS "externalId", c.name, c.email, c.created_at AS "createdAt"`,
    from: 'customers c', search: ['c.name', 'c.email', 'c.external_id', 'c.id::text'], orderBy: 'c.created_at DESC', tenant: 'c.merchant_id = $1',
  },
  orders: {
    select: `o.id, o.customer_id AS "customerId", COALESCE(c.name, c.email, c.external_id) AS customer,
      o.reference, o.description, o.amount::text AS amount, o.currency, o.status,
      p.status AS "paymentStatus", p.detected_at AS "detectedAt", p.confirmed_at AS "confirmedAt",
      p.expires_at AS "expiresAt", o.created_at AS "createdAt"`,
    from: 'orders o LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN payments p ON p.order_id = o.id',
    search: ['o.reference', 'o.description', 'c.name', 'c.email', 'o.id::text'], orderBy: 'o.created_at DESC', status: 'o.status', tenant: 'o.merchant_id = $1',
  },
  payments: {
    select: `p.id, p.order_id AS "orderId", o.description, p.amount::text AS amount, p.currency,
      p.network, p.status, p.tx_hash AS "transactionHash", p.recipient_address AS recipient,
      p.created_at AS "createdAt", p.confirmed_at AS "confirmedAt", p.failure_reason AS "failureReason"`,
    from: 'payments p JOIN orders o ON o.id = p.order_id', search: ['o.description', 'p.tx_hash', 'p.id::text'],
    orderBy: 'p.created_at DESC', status: 'p.status', tenant: 'p.merchant_id = $1',
  },
  'payment-links': {
    select: `p.id AS "paymentId", o.id AS "orderId", o.description, o.amount::text AS amount,
      o.currency, p.status, COALESCE(pl.enabled, true) AS enabled, pl.deleted_at AS "deletedAt",
      p.expires_at AS "expiresAt", p.created_at AS "createdAt"`,
    from: 'payments p JOIN orders o ON o.id = p.order_id LEFT JOIN payment_links pl ON pl.payment_id = p.id',
    filter: 'pl.deleted_at IS NULL', search: ['o.description', 'p.id::text'],
    orderBy: 'p.created_at DESC', status: 'p.status', tenant: 'p.merchant_id = $1',
  },
  'credit-accounts': {
    select: `c.id AS "customerId", c.name, c.email, c.external_id AS "externalId",
      COALESCE(a.id::text, '') AS "accountId", COALESCE(a.balance_units::text, '0') AS "balanceUnits",
      COALESCE(a.updated_at, c.created_at) AS "updatedAt"`,
    from: 'customers c LEFT JOIN credit_accounts a ON a.customer_id = c.id AND a.merchant_id = c.merchant_id',
    search: ['c.name', 'c.email', 'c.external_id'], orderBy: 'COALESCE(a.updated_at, c.created_at) DESC', tenant: 'c.merchant_id = $1',
  },
  'credit-transactions': {
    select: `t.id, t.customer_id AS "customerId", COALESCE(c.name, c.email, c.external_id) AS customer,
      t.transaction_type AS type, t.credit_units::text AS "creditUnits", t.balance_after_units::text AS "balanceAfterUnits",
      t.reference, t.created_at AS "createdAt"`,
    from: 'credit_transactions t JOIN customers c ON c.id = t.customer_id', search: ['c.name', 'c.email', 't.reference'],
    orderBy: 't.created_at DESC', status: 't.transaction_type', tenant: 't.merchant_id = $1',
  },
  topups: {
    select: `t.id, t.customer_id AS "customerId", COALESCE(c.name, c.email, c.external_id) AS customer,
      t.amount_usdc::text AS "amountUsdc", t.credit_units::text AS "creditUnits", t.status,
      t.failure_reason AS "failureReason", t.created_at AS "createdAt", t.credited_at AS "creditedAt", p.tx_hash AS "transactionHash"`,
    from: 'credit_topups t JOIN customers c ON c.id = t.customer_id JOIN payments p ON p.id = t.payment_id',
    search: ['c.name', 'c.email', 'c.external_id', 'p.tx_hash'], orderBy: 't.created_at DESC', status: 't.status', tenant: 't.merchant_id = $1',
  },
  usage: {
    select: `u.id, u.customer_id AS "customerId", COALESCE(c.name, c.email, c.external_id, c.id::text) AS customer,
      p.slug AS provider, m.slug AS model,
      u.request_id AS "requestId", u.input_tokens AS "inputTokens", u.output_tokens AS "outputTokens",
      u.customer_price_usd::text AS "customerPriceUsd", u.credits_deducted_units::text AS "creditsDeductedUnits",
      u.created_at AS "createdAt"`,
    from: 'ai_usage_records u JOIN customers c ON c.id = u.customer_id JOIN ai_providers p ON p.id = u.provider_id JOIN ai_models m ON m.id = u.model_id',
    search: ['c.name', 'c.email', 'p.slug', 'm.slug', 'u.request_id'], orderBy: 'u.created_at DESC', tenant: 'u.merchant_id = $1',
  },
  'webhook-endpoints': {
    select: `id, name, url, events, enabled, created_at AS "createdAt", updated_at AS "updatedAt"`,
    from: 'webhook_endpoints', search: ['name', 'url'], orderBy: 'created_at DESC',
    filter: 'deleted_at IS NULL', status: 'enabled::text', tenant: 'merchant_id = $1',
  },
  'webhook-deliveries': {
    select: `d.id, d.event_id AS "eventId", e.event_type AS event, d.status, d.attempts,
      d.next_attempt_at AS "nextAttemptAt", d.last_http_status AS "lastHttpStatus", d.last_error AS "lastError",
      d.delivered_at AS "deliveredAt", d.created_at AS "createdAt", ep.id AS "endpointId", ep.name AS endpoint`,
    from: 'webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id JOIN webhook_endpoints ep ON ep.id = d.endpoint_id',
    search: ['ep.name', 'e.event_type', 'd.last_error'], orderBy: 'd.created_at DESC', status: 'd.status', tenant: 'ep.merchant_id = $1',
  },
};

export const dashboardRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/admin', async (_request, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await adminHtml));
  app.get('/merchant', async (_request, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await merchantHtml));
  app.get('/assets/dashboard.css', async (_request, reply) => reply.type('text/css; charset=utf-8').header('cache-control', 'no-store').send(await dashboardCss));
  app.get('/assets/dashboard.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-store').send(await dashboardJs));

  app.get('/v1/admin/dashboard/overview', async (request, reply) => {
    requireAdmin(request);
    const result = await db.query(
      `SELECT
        (SELECT count(*) FROM merchants) AS merchants,
        (SELECT count(*) FROM customers) AS customers,
        (SELECT count(*) FROM orders) AS orders,
        (SELECT count(*) FROM payments WHERE status IN ('PENDING', 'DETECTED', 'VERIFYING')) AS pending_payments,
        (SELECT count(*) FROM payments WHERE status IN ('FAILED', 'EXPIRED')) AS failed_or_expired_payments,
        (SELECT COALESCE(sum(amount), 0)::text FROM payments WHERE status = 'CONFIRMED' AND currency = 'USDC') AS usdc_received,
        (SELECT count(*) FROM credit_accounts) AS credit_accounts,
        (SELECT COALESCE(sum(balance_units), 0)::text FROM credit_accounts) AS credit_balance_units,
        (SELECT count(*) FROM ai_usage_records) AS ai_requests,
        (SELECT COALESCE(sum(customer_price_usd), 0)::text FROM ai_usage_records) AS ai_revenue_usd,
        (SELECT COALESCE(sum(provider_cost_usd), 0)::text FROM ai_usage_records) AS provider_cost_usd,
        (SELECT COALESCE(sum(profit_usd), 0)::text FROM ai_usage_records) AS profit_usd,
        (SELECT count(*) FROM webhook_deliveries WHERE status = 'FAILED') AS failed_webhook_deliveries`,
    );
    return reply.send({ overview: result.rows[0] });
  });

  app.get('/v1/admin/dashboard/:collection', async (request, reply) => {
    requireAdmin(request);
    const { collection } = request.params as { collection: string };
    const definition = adminCollections[collection];
    if (!definition) throw new HttpError(404, 'Dashboard collection not found', 'not_found');
    const result = await listCollection(db, definition, request.query as DashboardQuery);
    if (collection === 'webhook-endpoints') {
      return reply.send({ ...result, items: result.items.map((item) => {
        const { url, ...endpoint } = item as Record<string, unknown>;
        return { ...endpoint, origin: new URL(String(url)).origin };
      }) });
    }
    if (collection === 'webhook-deliveries') {
      return reply.send({ ...result, items: result.items.map((item) => {
        const { lastError, ...delivery } = item as Record<string, unknown>;
        return { ...delivery, lastError: sanitizeStoredWebhookError(typeof lastError === 'string' ? lastError : null,
          typeof delivery.lastHttpStatus === 'number' ? delivery.lastHttpStatus : null) };
      }) });
    }
    return reply.send(result);
  });

  app.get('/v1/dashboard/overview', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const result = await db.query(
      `SELECT
        (SELECT count(*) FROM customers WHERE merchant_id = $1) AS customers,
        (SELECT count(*) FROM orders WHERE merchant_id = $1) AS orders,
        (SELECT count(*) FROM payments WHERE merchant_id = $1 AND status IN ('PENDING', 'DETECTED', 'VERIFYING')) AS pending_payments,
        (SELECT count(*) FROM payments WHERE merchant_id = $1 AND status IN ('FAILED', 'EXPIRED')) AS failed_or_expired_payments,
        (SELECT COALESCE(sum(amount), 0)::text FROM payments WHERE merchant_id = $1 AND status = 'CONFIRMED' AND currency = 'USDC') AS usdc_received,
        (SELECT count(*) FROM credit_accounts WHERE merchant_id = $1) AS credit_accounts,
        (SELECT COALESCE(sum(balance_units), 0)::text FROM credit_accounts WHERE merchant_id = $1) AS credit_balance_units,
        (SELECT count(*) FROM ai_usage_records WHERE merchant_id = $1) AS ai_requests,
        (SELECT COALESCE(sum(customer_price_usd), 0)::text FROM ai_usage_records WHERE merchant_id = $1) AS ai_usage_cost_usd,
        (SELECT count(*) FROM webhook_deliveries d JOIN webhook_endpoints ep ON ep.id = d.endpoint_id
          WHERE ep.merchant_id = $1 AND d.status = 'FAILED') AS failed_webhook_deliveries`,
      [merchant.id],
    );
    return reply.send({ overview: result.rows[0] });
  });

  app.get('/v1/dashboard/:collection', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { collection } = request.params as { collection: string };
    const definition = merchantCollections[collection];
    if (!definition) throw new HttpError(404, 'Dashboard collection not found', 'not_found');
    const result = await listCollection(db, definition, request.query as DashboardQuery, merchant.id);
    if (collection === 'webhook-endpoints') {
      return reply.send({ ...result, items: result.items.map((item) => {
        const endpoint = item as Record<string, unknown>;
        return { ...endpoint, url: new URL(String(endpoint.url)).origin };
      }) });
    }
    if (collection === 'webhook-deliveries') {
      return reply.send({ ...result, items: result.items.map((item) => {
        const { lastError, ...delivery } = item as Record<string, unknown>;
        return { ...delivery, lastError: sanitizeStoredWebhookError(typeof lastError === 'string' ? lastError : null,
          typeof delivery.lastHttpStatus === 'number' ? delivery.lastHttpStatus : null) };
      }) });
    }
    return reply.send(result);
  });
};
