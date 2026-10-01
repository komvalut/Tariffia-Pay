import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { parseBody, requireMerchant } from '../http.js';
import { smsOtpSchema, smsSendSchema } from '../schemas.js';
import type { SmsGatewayService } from '../services/sms-gateway-service.js';

export const smsRoutes: FastifyPluginAsync<{
  db: Database; smsGateway: SmsGatewayService;
}> = async (app, { db, smsGateway }) => {
  app.get('/v1/sms/services', async (request, reply) => {
    await requireMerchant(request, db);
    return reply.send(await smsGateway.listServices());
  });

  app.post('/v1/sms/send', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(smsSendSchema, request.body);
    const result = await smsGateway.sendSms({
      merchantId: merchant.id,
      requestId: body.requestId,
      service: body.service,
      to: body.to,
      message: body.message,
      ...(body.customerId === undefined ? {} : { customerId: body.customerId }),
      metadata: body.metadata,
    });
    return reply.code(result.status).send(result.body);
  });

  app.post('/v1/sms/otp', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    const body = parseBody(smsOtpSchema, request.body);
    const result = await smsGateway.sendOtp({
      merchantId: merchant.id,
      requestId: body.requestId,
      service: body.service,
      to: body.to,
      ...(body.customerId === undefined ? {} : { customerId: body.customerId }),
      metadata: body.metadata,
    });
    return reply.code(result.status).send(result.body);
  });
};
