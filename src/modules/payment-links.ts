import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { parseBody, requireMerchant } from '../http.js';
import { createOrderSchema } from '../schemas.js';
import type { PaymentCoreService } from '../services/payment-core-service.js';

export const paymentLinkRoutes: FastifyPluginAsync<{ db: Database; paymentCore: PaymentCoreService }> = async (app, { db, paymentCore }) => {
  app.post('/v1/payment-links', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createOrderSchema, request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') throw new HttpError(400, 'Idempotency-Key header is required', 'missing_idempotency_key');
    const result = await paymentCore.createPaymentLink({
      merchant,
      body,
      idempotencyKey,
      scope: `merchant:${merchant.id}:POST:/v1/payment-links`,
    });
    return reply.header('Idempotency-Replayed', String(result.replayed)).code(result.status).send(result.body);
  });
};
