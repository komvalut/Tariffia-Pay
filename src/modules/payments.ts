import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { parseBody, requireMerchant } from '../http.js';
import { verifyPaymentSchema } from '../schemas.js';
import type { PaymentVerificationService } from '../services/payment-verification-service.js';

export const paymentRoutes: FastifyPluginAsync<{ db: Database; verification: PaymentVerificationService }> = async (app, { db, verification }) => {
  app.get('/v1/payments/:paymentId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { paymentId } = request.params as { paymentId: string };
    const result = await db.query(
      `SELECT id, order_id AS "orderId", amount::text AS amount, amount_base_units::text AS "amountBaseUnits",
              currency, adapter, network, recipient_address AS "recipientAddress", token_address AS "tokenAddress", status,
              tx_hash AS "txHash", tx_hash AS "transactionId", expires_at AS "expiresAt", detected_at AS "detectedAt",
              confirmed_at AS "confirmedAt", created_at AS "createdAt"
         FROM payments WHERE id = $1 AND merchant_id = $2`,
      [paymentId, merchant.id],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Payment not found', 'not_found');
    return reply.send({ payment: result.rows[0] });
  });

  app.post('/v1/payments/:paymentId/verify', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const { paymentId } = request.params as { paymentId: string };
    const body = parseBody(verifyPaymentSchema, request.body);
    const result = await verification.process(paymentId, merchant.id, body.transactionId ?? body.transactionHash!);
    const statusCode = ['CONFIRMED', 'FAILED'].includes(result.status) ? 200 : 202;
    return reply.code(statusCode).send({ payment: result });
  });
};
