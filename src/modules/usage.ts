import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { parseBody, requireAdmin, requireMerchant, requireUuidParam } from '../http.js';
import { updateMerchantUsageLimitsSchema } from '../schemas.js';
import type { MerchantUsageService } from '../services/merchant-usage-service.js';

export const merchantUsageRoutes: FastifyPluginAsync<{ db: Database; merchantUsage: MerchantUsageService }> =
  async (app, { db, merchantUsage }) => {
    app.get('/v1/usage', async (request, reply) => {
      const merchant = await requireMerchant(request, db);
      return reply.send({ usage: await merchantUsage.usageSummaryForMerchant(merchant.id) });
    });

    app.get('/v1/admin/usage/merchants', async (request, reply) => {
      requireAdmin(request);
      return reply.send({ usage: await merchantUsage.listUsage() });
    });

    app.get('/v1/admin/usage/merchants/:merchantId', async (request, reply) => {
      requireAdmin(request);
      const merchantId = requireUuidParam(request, 'merchantId');
      const merchant = await db.query<{ name: string; email: string }>(
        'SELECT name, email FROM merchants WHERE id = $1', [merchantId],
      );
      if (!merchant.rows[0]) throw new HttpError(404, 'Merchant not found', 'merchant_not_found');
      const detail = await merchantUsage.usageForMerchant(merchantId);
      return reply.send({
        merchantId,
        merchant: merchant.rows[0].name,
        email: merchant.rows[0].email,
        limits: detail.limits,
        counts: detail.counts,
        windowStart: detail.windowStart,
        windowResetAt: detail.windowResetAt,
      });
    });

    app.put('/v1/admin/usage/merchants/:merchantId', async (request, reply) => {
      requireAdmin(request);
      const merchantId = requireUuidParam(request, 'merchantId');
      const body = parseBody(updateMerchantUsageLimitsSchema, request.body);
      const limits = await merchantUsage.updateLimits(merchantId, body);
      return reply.send({
        merchantId,
        limits: {
          general: await merchantUsage.effectiveLimit(merchantId, 'general'),
          ai: await merchantUsage.effectiveLimit(merchantId, 'ai'),
          sms: await merchantUsage.effectiveLimit(merchantId, 'sms'),
        },
        overrides: limits,
      });
    });
  };
