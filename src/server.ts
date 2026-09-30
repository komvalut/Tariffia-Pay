import 'dotenv/config';
import { buildApp } from './app.js';
import { config } from './config.js';
import { PostgresDatabase } from './db.js';

const db = new PostgresDatabase();
const app = await buildApp({ db, migrate: () => db.migrate() });

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await app.listen({ host: '0.0.0.0', port: config.PORT });
} catch (error) {
  app.log.error(error);
  await db.close();
  process.exit(1);
}
