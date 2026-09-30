import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import type { Database } from './db.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import type { PaymentAdapter } from './payment-adapter.js';
import { BaseUsdcAdapter } from './adapters/usdc/base-usdc-adapter.js';
import { PaymentVerificationService } from './services/payment-verification-service.js';
import { customerRoutes } from './modules/customers.js';
import { checkoutRoutes } from './modules/checkout.js';
import { apiKeyRoutes } from './modules/api-keys.js';
import { adminWebhookRoutes } from './modules/admin-webhooks.js';
import { ledgerRoutes } from './modules/ledger.js';
import { merchantRoutes } from './modules/merchants.js';
import { orderRoutes } from './modules/orders.js';
import { paymentLinkRoutes } from './modules/payment-links.js';
import { paymentRoutes } from './modules/payments.js';
import { webhookRoutes } from './modules/webhooks.js';
import { creditRoutes } from './modules/credits.js';
import { adminCreditRoutes } from './modules/admin-credits.js';
import { PaymentCoreService } from './services/payment-core-service.js';
import { CreditEngine } from './services/credit-engine.js';
import { AiPricingEngine } from './services/ai-pricing-engine.js';
import { adminAiRoutes } from './modules/admin-ai.js';
import { aiRoutes } from './modules/ai.js';
import { dashboardRoutes } from './modules/dashboard.js';
import { safeErrorMetadata } from './safe-logging.js';

type AppOptions = {
  db: Database;
  migrate?: () => Promise<void>;
  paymentAdapter?: PaymentAdapter;
  verification?: PaymentVerificationService;
  creditEngine?: CreditEngine;
};

export async function buildApp({ db, migrate, paymentAdapter, verification, creditEngine }: AppOptions): Promise<FastifyInstance> {
  if (migrate) await migrate();
  const adapter = paymentAdapter ?? new BaseUsdcAdapter();
  const paymentVerification = verification ?? new PaymentVerificationService(db, [adapter]);
  const paymentCore = new PaymentCoreService(db, adapter);
  const credits = creditEngine ?? new CreditEngine(db);
  const aiPricing = new AiPricingEngine(db);
  await credits.initialize();
  paymentVerification.addLifecycleHandler(credits);
  const proxySetting = config.TRUST_PROXY.trim();
  const trustProxy = proxySetting === 'true' ? true : proxySetting === 'false' || !proxySetting
    ? false
    : proxySetting.split(',').map((item) => item.trim()).filter(Boolean);
  const app = Fastify({
    logger: {
      redact: {
        paths: ['req.headers', 'headers.authorization', 'headers.x-admin-api-key', 'headers.cookie', 'headers.set-cookie'],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 256 * 1024,
    trustProxy,
  });
  await app.register(sensible);
  await app.register(rateLimit, { global: true, max: config.API_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('content-security-policy', "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    if (config.NODE_ENV === 'production') reply.header('strict-transport-security', 'max-age=31536000');
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    if (statusCode === 429) {
      void reply.code(429).send({ error: 'rate_limited', message: 'Too many requests; retry later' });
      return;
    }
    if (statusCode === 413) {
      void reply.code(413).send({ error: 'payload_too_large', message: 'Request body exceeds the configured limit' });
      return;
    }
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      void reply.code(statusCode).send({ error: 'bad_request', message: 'Request could not be processed' });
      return;
    }
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      void reply.code(409).send({ error: 'conflict', message: 'A record with these unique fields already exists' });
      return;
    }
    app.log.error(safeErrorMetadata(error), 'Unhandled API error');
    void reply.code(500).send({ error: 'internal_error', message: 'An unexpected error occurred' });
  });

  app.get('/health', async (_request, reply) => {
    await db.query('SELECT 1');
    return reply.send({ status: 'ok', service: 'tariffia-pay-api' });
  });

  app.get('/ready', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return reply.send({ status: 'ready', service: 'tariffia-pay-api' });
    } catch (error) {
      app.log.warn(safeErrorMetadata(error), 'Readiness check failed');
      return reply.code(503).send({ status: 'not_ready', service: 'tariffia-pay-api' });
    }
  });

  await app.register(merchantRoutes, { db });
  await app.register(apiKeyRoutes, { db });
  await app.register(customerRoutes, { db });
  await app.register(orderRoutes, { db, paymentCore });
  await app.register(paymentLinkRoutes, { db, paymentCore });
  await app.register(paymentRoutes, { db, verification: paymentVerification });
  await app.register(checkoutRoutes, { db, verification: paymentVerification });
  await app.register(webhookRoutes, { db });
  await app.register(adminWebhookRoutes, { db });
  await app.register(creditRoutes, { db, credits, paymentCore });
  await app.register(adminCreditRoutes, { db, credits });
  await app.register(adminAiRoutes, { db });
  await app.register(aiRoutes, { db, aiPricing });
  await app.register(ledgerRoutes, { db });
  await app.register(dashboardRoutes, { db });
  return app;
}
