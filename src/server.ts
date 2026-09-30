import 'dotenv/config';
import { buildApp } from './app.js';
import { config } from './config.js';
import { PostgresDatabase } from './db.js';
import { BaseUsdcAdapter } from './adapters/usdc/base-usdc-adapter.js';
import { PaymentVerificationService } from './services/payment-verification-service.js';
import { UsdcPaymentDetector } from './services/usdc-payment-detector.js';
import { WebhookDeliveryWorker } from './services/webhook-delivery-worker.js';
import { CreditEngine } from './services/credit-engine.js';
import { safeErrorMetadata } from './safe-logging.js';
import { createDefaultPaymentAdapterRegistry } from './payment-adapters/default-registry.js';

const db = new PostgresDatabase(config.DATABASE_URL);
const adapters = createDefaultPaymentAdapterRegistry();
await adapters.initialize();
const paymentAdapter = adapters.getForVerification('usdc') as BaseUsdcAdapter;
const verification = new PaymentVerificationService(db, adapters);
const detector = new UsdcPaymentDetector(db, paymentAdapter, verification);
const credits = new CreditEngine(db);
const webhookWorker = new WebhookDeliveryWorker(db, fetch, [credits], { pinDns: config.NODE_ENV === 'production' });
const app = await buildApp({ db, migrate: () => db.migrate(), adapterRegistry: adapters, verification, creditEngine: credits });
let detectorTimer: NodeJS.Timeout | undefined;
let webhookTimer: NodeJS.Timeout | undefined;
let detectorRun: Promise<void> | undefined;
let webhookRun: Promise<void> | undefined;
let shutdownRun: Promise<void> | undefined;

const shutdown = (): Promise<void> => {
  if (shutdownRun) return shutdownRun;
  if (detectorTimer) clearInterval(detectorTimer);
  if (webhookTimer) clearInterval(webhookTimer);
  shutdownRun = (async () => {
    try {
      await app.close();
      await Promise.all([detectorRun, webhookRun].filter((run): run is Promise<void> => run !== undefined));
    } finally {
      try {
        await adapters.shutdown();
      } finally {
        await db.close();
      }
    }
  })();
  return shutdownRun;
};

const handleShutdown = () => {
  void shutdown().catch((error) => {
    app.log.error(safeErrorMetadata(error), 'Graceful shutdown failed');
    process.exitCode = 1;
  });
};
process.once('SIGINT', handleShutdown);
process.once('SIGTERM', handleShutdown);

try {
  await app.listen({ host: '0.0.0.0', port: config.PORT });
  const runDetector = () => {
    if (detectorRun) return detectorRun;
    detectorRun = detector.pollOnce()
      .catch((error) => app.log.error(safeErrorMetadata(error), 'USDC payment detection failed'))
      .finally(() => { detectorRun = undefined; });
    return detectorRun;
  };
  void runDetector();
  detectorTimer = setInterval(runDetector, config.PAYMENT_DETECTOR_INTERVAL_MS);
  detectorTimer.unref();
  const runWebhooks = () => {
    if (webhookRun) return webhookRun;
    webhookRun = webhookWorker.runOnce()
      .then(() => undefined)
      .catch((error) => app.log.error(safeErrorMetadata(error), 'Webhook worker failed'))
      .finally(() => { webhookRun = undefined; });
    return webhookRun;
  };
  void runWebhooks();
  webhookTimer = setInterval(runWebhooks, config.WEBHOOK_WORKER_INTERVAL_MS);
  webhookTimer.unref();
} catch (error) {
  app.log.error(safeErrorMetadata(error), 'Server startup failed');
  await db.close();
  process.exit(1);
}
