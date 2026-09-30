import 'dotenv/config';
import { PostgresDatabase } from './db.js';
import { safeErrorMetadata } from './safe-logging.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write('DATABASE_URL is required to run migrations.\n');
  process.exitCode = 1;
} else {
  const db = new PostgresDatabase(databaseUrl);
  try {
    await db.migrate();
    process.stdout.write('Tariffia Pay database migrations are current.\n');
  } catch (error) {
    process.stderr.write(`Tariffia Pay database migration failed: ${JSON.stringify(safeErrorMetadata(error))}\n`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
