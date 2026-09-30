import type { FastifyPluginAsync } from 'fastify';
import { formatUnits, parseUnits } from 'viem';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { parseBody, requireMerchant } from '../http.js';
import { createCreditDeductionSchema, createCreditTopupSchema } from '../schemas.js';
import { hashRequest, newId } from '../security.js';
import type { PaymentCoreService } from '../services/payment-core-service.js';
import { CreditEngine } from '../services/credit-engine.js';

function pageLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
}

export const creditRoutes: FastifyPluginAsync<{ db: Database; credits: CreditEngine; paymentCore: PaymentCoreService }> = async (app, { db, credits, paymentCore }) => {
  app.post('/v1/credits/topups', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createCreditTopupSchema, request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') throw new HttpError(400, 'Idempotency-Key header is required', 'missing_idempotency_key');
    const account = await credits.getOrCreateAccount(merchant.id, body.customerId);
    const idempotencyKey = hashRequest({ scope: 'credit_topup', merchantId: merchant.id, key });
    const result = await paymentCore.createPaymentLink({
      merchant,
      body: {
        customerId: body.customerId,
        description: 'USDC credit top-up',
        amount: body.amount,
        currency: 'USDC',
        metadata: { purpose: 'credit_topup', creditAccountId: account.id },
      },
      idempotencyKey: key,
      scope: `merchant:${merchant.id}:POST:/v1/credits/topups`,
      onPaymentCreated: async (client, payment) => {
        const settings = await credits.getSettingsInTransaction(client);
        const amountUnits = parseUnits(payment.amount, 6);
        if (amountUnits < parseUnits(settings.minimumTopupUsdc, 6)) {
          throw new HttpError(400, `Minimum credit top-up is ${settings.minimumTopupUsdc} USDC`, 'topup_below_minimum');
        }
        if (amountUnits > parseUnits(settings.maximumTopupUsdc, 6)) {
          throw new HttpError(400, `Maximum credit top-up is ${settings.maximumTopupUsdc} USDC`, 'topup_above_maximum');
        }
        const creditUnits = CreditEngine.creditUnitsForUsdc(amountUnits, settings.creditsPerUsdcRate);
        const topupId = newId();
        await client.query(
          `INSERT INTO credit_topups (id, merchant_id, account_id, customer_id, order_id, payment_id,
                                      amount_usdc, credit_units, credits_per_usdc_rate, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [topupId, merchant.id, account.id, body.customerId, payment.orderId, payment.paymentId,
            body.amount, creditUnits.toString(), settings.creditsPerUsdcRate, idempotencyKey],
        );
        return {
          response: {
            creditTopup: {
              id: topupId,
              accountId: account.id,
              customerId: body.customerId,
              amountUsdc: body.amount,
              creditAmount: formatUnits(creditUnits, 6),
              creditsPerUsdcRate: settings.creditsPerUsdcRate,
              status: 'PENDING',
            },
          },
          webhookData: { purpose: 'credit_topup', creditAccountId: account.id },
        };
      },
    });
    return reply.header('Idempotency-Replayed', String(result.replayed)).code(result.status).send(result.body);
  });

  app.post('/v1/credits/deductions', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createCreditDeductionSchema, request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') throw new HttpError(400, 'Idempotency-Key header is required', 'missing_idempotency_key');
    const result = await credits.deductCredits({
      merchantId: merchant.id,
      customerId: body.customerId,
      amount: body.amount,
      reference: body.reference,
      metadata: body.metadata,
      idempotencyKey: key,
    });
    return reply.header('Idempotency-Replayed', String(result.replayed)).code(result.status).send(result.body);
  });

  app.get('/v1/credits/:customerId/balance', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { customerId } = request.params as { customerId: string };
    const account = await credits.getOrCreateAccount(merchant.id, customerId);
    const settings = await credits.getSettings();
    return reply.send({
      accountId: account.id,
      customerId,
      balance: formatUnits(BigInt(account.balance_units), 6),
      currency: 'CREDITS',
      creditsPerUsdcRate: settings.creditsPerUsdcRate,
    });
  });

  app.get('/v1/credits/:customerId/topups', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { customerId } = request.params as { customerId: string };
    const account = await credits.getOrCreateAccount(merchant.id, customerId);
    const query = request.query as { limit?: string };
    const result = await db.query<{
      id: string; order_id: string; payment_id: string; amount_usdc: string; credit_units: string;
      credits_per_usdc_rate: number; status: string; created_at: Date; credited_at: Date | null; tx_hash: string | null;
    }>(
      `SELECT t.id, t.order_id, t.payment_id, t.amount_usdc::text AS amount_usdc,
              t.credit_units::text AS credit_units, t.credits_per_usdc_rate, t.status,
              t.created_at, t.credited_at, p.tx_hash
         FROM credit_topups t JOIN payments p ON p.id = t.payment_id
        WHERE t.merchant_id = $1 AND t.customer_id = $2
        ORDER BY t.created_at DESC LIMIT $3`,
      [merchant.id, customerId, pageLimit(query.limit)],
    );
    return reply.send({
      accountId: account.id,
      topups: result.rows.map((topup) => ({
        id: topup.id, orderId: topup.order_id, paymentId: topup.payment_id,
        amountUsdc: topup.amount_usdc, creditAmount: formatUnits(BigInt(topup.credit_units), 6),
        creditsPerUsdcRate: topup.credits_per_usdc_rate, status: topup.status,
        transactionHash: topup.tx_hash, createdAt: topup.created_at, creditedAt: topup.credited_at,
      })),
    });
  });

  app.get('/v1/credits/:customerId/usage', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { customerId } = request.params as { customerId: string };
    const account = await credits.getOrCreateAccount(merchant.id, customerId);
    const query = request.query as { limit?: string };
    const result = await db.query<{
      id: string; credit_units: string; balance_after_units: string; reference: string | null;
      metadata: Record<string, unknown>; created_at: Date;
    }>(
      `SELECT id, credit_units::text AS credit_units, balance_after_units::text AS balance_after_units,
              reference, metadata, created_at
         FROM credit_transactions WHERE account_id = $1 AND transaction_type = 'DEDUCTION'
        ORDER BY created_at DESC LIMIT $2`,
      [account.id, pageLimit(query.limit)],
    );
    return reply.send({
      accountId: account.id,
      usage: result.rows.map((item) => ({
        id: item.id, amount: formatUnits(BigInt(item.credit_units), 6),
        balanceAfter: formatUnits(BigInt(item.balance_after_units), 6),
        reference: item.reference, metadata: item.metadata, createdAt: item.created_at,
      })),
    });
  });
};
