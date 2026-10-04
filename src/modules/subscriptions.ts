import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAdmin, requireMerchant, parseBody, requireUuidParam } from '../http.js';
import {
  createSubscriptionPlanSchema,
  createSubscriptionSchema,
  manualSubscriptionRenewalSchema,
  subscriptionActionSchema,
  updateSubscriptionPlanSchema,
} from '../schemas.js';
import { SubscriptionService } from '../services/subscription-service.js';

export const subscriptionRoutes: FastifyPluginAsync<{ db: Database; subscriptions: SubscriptionService }> = async (app, { db, subscriptions }) => {
  app.get('/v1/subscription-plans', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    return reply.send(await subscriptions.listPlans(merchant.id));
  });

  app.post('/v1/subscription-plans', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createSubscriptionPlanSchema, request.body);
    return reply.code(201).send(await subscriptions.createPlan(merchant.id, body));
  });

  app.put('/v1/subscription-plans/:planId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const planId = requireUuidParam(request, 'planId');
    const body = parseBody(updateSubscriptionPlanSchema, request.body);
    return reply.send(await subscriptions.updatePlan(merchant.id, planId, body));
  });

  app.get('/v1/subscriptions', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    return reply.send(await subscriptions.listSubscriptions(merchant.id));
  });

  app.post('/v1/subscriptions', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(createSubscriptionSchema, request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') throw new HttpError(400, 'Idempotency-Key header is required', 'missing_idempotency_key');
    return reply.code(201).send(await subscriptions.createSubscription(merchant, body, idempotencyKey));
  });

  app.get('/v1/subscriptions/:subscriptionId/billing-cycles', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const subscriptionId = requireUuidParam(request, 'subscriptionId');
    return reply.send(await subscriptions.listBillingCycles(merchant.id, subscriptionId));
  });

  app.post('/v1/subscriptions/:subscriptionId/renew', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const subscriptionId = requireUuidParam(request, 'subscriptionId');
    parseBody(manualSubscriptionRenewalSchema, request.body ?? {});
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') throw new HttpError(400, 'Idempotency-Key header is required', 'missing_idempotency_key');
    return reply.code(201).send(await subscriptions.renewManually(merchant, subscriptionId, idempotencyKey));
  });

  app.patch('/v1/subscriptions/:subscriptionId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const subscriptionId = requireUuidParam(request, 'subscriptionId');
    const body = parseBody(subscriptionActionSchema, request.body);
    return reply.send(await subscriptions.updateState(merchant.id, subscriptionId, body.action));
  });

  app.get('/v1/subscriptions/:subscriptionId', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const subscriptionId = requireUuidParam(request, 'subscriptionId');
    return reply.send({ subscription: await subscriptions.getSubscription(merchant.id, subscriptionId) });
  });

  app.get('/v1/customers/:customerId/subscriptions', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const customerId = requireUuidParam(request, 'customerId');
    return reply.send(await subscriptions.listCustomerSubscriptions(merchant.id, customerId));
  });

  app.get('/v1/admin/subscriptions', async (request, reply) => {
    requireAdmin(request);
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
    return reply.send(await subscriptions.listAdminSubscriptions(limit));
  });
};
