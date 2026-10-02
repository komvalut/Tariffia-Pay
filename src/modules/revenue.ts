import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { requireMerchant } from '../http.js';

const pendingStatuses = ['CREATED', 'PENDING', 'DETECTED', 'VERIFYING'];
const terminalStatuses = ['CONFIRMED', 'FAILED', 'EXPIRED'];

function parseDate(value: string | undefined, field: string): Date | null {
  if (value === undefined || value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, `Invalid ${field} date filter`, 'invalid_date_range');
  }
  return date;
}

// Read-only revenue summary over existing payment records; no new data is stored or mutated.
export const revenueRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/v1/revenue/summary', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const query = request.query as { from?: string; to?: string };
    const from = parseDate(query.from, 'from');
    const to = parseDate(query.to, 'to');
    if (from && to && from.getTime() > to.getTime()) {
      throw new HttpError(400, 'The from date must not be after the to date', 'invalid_date_range');
    }
    const conditions = ['merchant_id = $1'];
    const params: unknown[] = [merchant.id];
    if (from) { params.push(from); conditions.push(`created_at >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`created_at <= $${params.length}`); }
    const result = await db.query<{ currency: string; status: string; count: number; total: string }>(
      `SELECT currency, status, count(*)::int AS count, COALESCE(SUM(amount), 0)::text AS total
         FROM payments
        WHERE ${conditions.join(' AND ')}
        GROUP BY currency, status`,
      params,
    );
    let confirmedPaymentCount = 0;
    let pendingPaymentCount = 0;
    let failedPaymentCount = 0;
    let expiredPaymentCount = 0;
    const totalsByCurrency: Record<string, string> = {};
    for (const row of result.rows) {
      if (row.status === 'CONFIRMED') {
        confirmedPaymentCount += row.count;
        totalsByCurrency[row.currency] = (Number(totalsByCurrency[row.currency] ?? '0') + Number(row.total)).toFixed(6);
      } else if (pendingStatuses.includes(row.status)) {
        pendingPaymentCount += row.count;
      } else if (row.status === 'FAILED') {
        failedPaymentCount += row.count;
      } else if (row.status === 'EXPIRED') {
        expiredPaymentCount += row.count;
      }
      void terminalStatuses;
    }
    const confirmedCurrencies = Object.keys(totalsByCurrency);
    const currency = confirmedCurrencies.length === 0 ? null : confirmedCurrencies.length === 1 ? confirmedCurrencies[0]! : 'MIXED';
    const totalConfirmed = confirmedCurrencies.length === 0
      ? '0.000000'
      : confirmedCurrencies.length === 1
        ? totalsByCurrency[confirmedCurrencies[0]!]!
        : null;
    return reply.send({
      revenue: {
        currency,
        totalConfirmed,
        confirmedPaymentCount,
        pendingPaymentCount,
        failedPaymentCount,
        expiredPaymentCount,
        totalsByCurrency,
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
      },
    });
  });
};
