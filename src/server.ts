import 'dotenv/config';
import { buildApp } from './app.js';
import { config } from './config.js';
import { PostgresDatabase } from './db.js';
import { BaseUsdcAdapter } from './adapters/usdc/base-usdc-adapter.js';
import { PaymentVerificationService } from './services/payment-verification-service.js';
import { UsdcPaymentDetector } from './services/usdc-payment-detector.js';

const db = new PostgresDatabase();
const paymentAdapter = new BaseUsdcAdapter();
const verification = new PaymentVerificationService(db, [paymentAdapter]);
const detector = new UsdcPaymentDetector(db, paymentAdapter, verification);
const app = await buildApp({ db, migrate: () => db.migrate(), paymentAdapter, verification });
let detectorTimer: NodeJS.Timeout | undefined;

const shutdown = async () => {
  if (detectorTimer) clearInterval(detectorTimer);
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
} catch (error) {
  app.log.error(error);
  await db.close();
  process.exit(1);
}
