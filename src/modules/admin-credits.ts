import { formatUnits } from 'viem';
import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { parseBody, requireAdmin } from '../http.js';
import { updateCreditSettingsSchema } from '../schemas.js';
import type { CreditEngine } from '../services/credit-engine.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

export const adminCreditRoutes: FastifyPluginAsync<{ db: Database; credits: CreditEngine }> = async (app, { db, credits }) => {
  app.get('/v1/admin/credits/settings', async (request, reply) => {
    requireAdmin(request);
    return reply.send({ settings: await credits.getSettings() });
  });

  app.put('/v1/admin/credits/settings', async (request, reply) => {
    requireAdmin(request);
    const input = parseBody(updateCreditSettingsSchema, request.body);
    const settings = await credits.updateSettings({
      creditsPerUsdcRate: input.creditsPerUsdcRate,
      minimumTopupUsdc: input.minimumTopupUsdc,
      maximumTopupUsdc: input.maximumTopupUsdc,
    });
    return reply.send({ settings });
  });

  app.get('/v1/admin/credits/accounts', async (request, reply) => {
    requireAdmin(request);
    const query = request.query as { limit?: string };
    const result = await db.query<{
      id: string; merchant_id: string; merchant: string; customer_id: string; customer: string;
      balance_units: string; created_at: Date; updated_at: Date;
    }>(
      `SELECT a.id, a.merchant_id, m.name AS merchant, a.customer_id,
              COALESCE(c.name, c.email, c.external_id, a.customer_id::text) AS customer,
              a.balance_units::text AS balance_units, a.created_at, a.updated_at
         FROM credit_accounts a JOIN merchants m ON m.id = a.merchant_id
         JOIN customers c ON c.id = a.customer_id
        ORDER BY a.updated_at DESC LIMIT $1`,
      [pageLimit(query.limit)],
    );
    return reply.send({ accounts: result.rows.map((account) => ({
      id: account.id, merchantId: account.merchant_id, merchant: account.merchant,
      customerId: account.customer_id, customer: account.customer,
      balance: formatUnits(BigInt(account.balance_units), 6), currency: 'CREDITS',
      createdAt: account.created_at, updatedAt: account.updated_at,
    })) });
  });

  app.get('/v1/admin/credits/transactions', async (request, reply) => {
    requireAdmin(request);
    const query = request.query as { limit?: string; type?: string };
    const allowedType = query.type && ['TOPUP', 'DEDUCTION'].includes(query.type) ? query.type : null;
    const result = await db.query<{
      id: string; merchant_id: string; merchant: string; account_id: string; customer_id: string;
      customer: string; transaction_type: string; credit_units: string; balance_after_units: string;
      reference: string | null; metadata: Record<string, unknown>; created_at: Date;
    }>(
      `SELECT t.id, t.merchant_id, m.name AS merchant, t.account_id, t.customer_id,
              COALESCE(c.name, c.email, c.external_id, t.customer_id::text) AS customer,
              t.transaction_type, t.credit_units::text AS credit_units,
              t.balance_after_units::text AS balance_after_units, t.reference, t.metadata, t.created_at
         FROM credit_transactions t JOIN merchants m ON m.id = t.merchant_id
         JOIN customers c ON c.id = t.customer_id
        WHERE ($1::text IS NULL OR t.transaction_type = $1)
        ORDER BY t.created_at DESC LIMIT $2`,
      [allowedType, pageLimit(query.limit)],
    );
    return reply.send({ transactions: result.rows.map((transaction) => ({
      id: transaction.id, merchantId: transaction.merchant_id, merchant: transaction.merchant,
      accountId: transaction.account_id, customerId: transaction.customer_id, customer: transaction.customer,
      type: transaction.transaction_type, amount: formatUnits(BigInt(transaction.credit_units), 6),
      balanceAfter: formatUnits(BigInt(transaction.balance_after_units), 6), currency: 'CREDITS',
      reference: transaction.reference, metadata: transaction.metadata, createdAt: transaction.created_at,
    })) });
  });
};
