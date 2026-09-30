import 'dotenv/config';
import { buildApp } from './app.js';
import { config } from './config.js';
import { PostgresDatabase } from './db.js';
import { BaseUsdcAdapter } from './adapters/usdc/base-usdc-adapter.js';
import { PaymentVerificationService } from './services/payment-verification-service.js';
import { UsdcPaymentDetector } from './services/usdc-payment-detector.js';
import { WebhookDeliveryWorker } from './services/webhook-delivery-worker.js';
import { CreditEngine } from './services/credit-engine.js';

const db = new PostgresDatabase();
const paymentAdapter = new BaseUsdcAdapter();
const verification = new PaymentVerificationService(db, [paymentAdapter]);
const detector = new UsdcPaymentDetector(db, paymentAdapter, verification);
const credits = new CreditEngine(db);
const webhookWorker = new WebhookDeliveryWorker(db, fetch, [credits]);
const app = await buildApp({ db, migrate: () => db.migrate(), paymentAdapter, verification, creditEngine: credits });
let detectorTimer: NodeJS.Timeout | undefined;
let webhookTimer: NodeJS.Timeout | undefined;

const shutdown = async () => {
  if (detectorTimer) clearInterval(detectorTimer);
  if (webhookTimer) clearInterval(webhookTimer);
  await app.close();
  await db.close();
  process.exit(0);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await app.listen({ host: '0.0.0.0', port: config.PORT });
  const runDetector = () => detector.pollOnce().catch((error) => app.log.error({ error }, 'USDC payment detection failed'));
  void runDetector();
  detectorTimer = setInterval(runDetector, config.PAYMENT_DETECTOR_INTERVAL_MS);
  detectorTimer.unref();
  const runWebhooks = () => webhookWorker.runOnce().catch((error) => app.log.error({ error }, 'Webhook worker failed'));
  void runWebhooks();
  webhookTimer = setInterval(runWebhooks, config.WEBHOOK_WORKER_INTERVAL_MS);
  webhookTimer.unref();
} catch (error) {
  app.log.error(error);
  await db.close();
  process.exit(1);
}
