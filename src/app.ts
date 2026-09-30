import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import type { Database } from './db.js';
import { HttpError } from './errors.js';
import type { PaymentAdapter } from './payment-adapter.js';
import { BaseUsdcAdapter } from './adapters/usdc/base-usdc-adapter.js';
import { PaymentVerificationService } from './services/payment-verification-service.js';
import { customerRoutes } from './modules/customers.js';
import { checkoutRoutes } from './modules/checkout.js';
import { apiKeyRoutes } from './modules/api-keys.js';
import { ledgerRoutes } from './modules/ledger.js';
import { merchantRoutes } from './modules/merchants.js';
import { orderRoutes } from './modules/orders.js';
import { paymentLinkRoutes } from './modules/payment-links.js';
import { paymentRoutes } from './modules/payments.js';
import { PaymentCoreService } from './services/payment-core-service.js';

type AppOptions = {
  db: Database;
  migrate?: () => Promise<void>;
  paymentAdapter?: PaymentAdapter;
  verification?: PaymentVerificationService;
};

export async function buildApp({ db, migrate, paymentAdapter, verification }: AppOptions): Promise<FastifyInstance> {
  if (migrate) await migrate();
  const adapter = paymentAdapter ?? new BaseUsdcAdapter();
  const paymentVerification = verification ?? new PaymentVerificationService(db, [adapter]);
  const paymentCore = new PaymentCoreService(db, adapter);
  const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });
  await app.register(sensible);
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      void reply.code(409).send({ error: 'conflict', message: 'A record with these unique fields already exists' });
      return;
    }
    app.log.error(error);
    void reply.code(500).send({ error: 'internal_error', message: 'An unexpected error occurred' });
  });

  app.get('/health', async (_request, reply) => {
    await db.query('SELECT 1');
    return reply.send({ status: 'ok', service: 'tariffia-pay-api' });
  });

  await app.register(merchantRoutes, { db });
  await app.register(apiKeyRoutes, { db });
  await app.register(customerRoutes, { db });
  await app.register(orderRoutes, { db, paymentCore });
  await app.register(paymentLinkRoutes, { db, paymentCore });
  await app.register(paymentRoutes, { db, verification: paymentVerification });
  await app.register(checkoutRoutes, { db, verification: paymentVerification });
  await app.register(ledgerRoutes, { db });
  return app;
}
