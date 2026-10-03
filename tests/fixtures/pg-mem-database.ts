import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import type { Database } from '../src/db.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/**
 * pg-mem cannot execute PostgreSQL plpgsql triggers, so the production append-only trigger from
 * `0016_audit_log_append_only.sql` is skipped here and its behaviour is reproduced with a query
 * hook that rejects UPDATE/DELETE on audit_log. Production Postgres applies the real trigger.
 */
export const APPLICATION_MIGRATIONS = [
  '0004_credit_engine.sql', '0005_ai_pricing.sql', '0006_invoices_receipts.sql', '0007_subscriptions.sql',
  '0008_ai_provider_integration.sql', '0009_sms_otp.sql', '0010_sms_provider_hardening.sql',
  '0011_merchant_usage_limits.sql', '0012_payment_links.sql', '0013_merchant_settings.sql',
  '0014_notification_preferences.sql', '0015_audit_log.sql', '0016_audit_log_append_only.sql',
];

const AUDIT_TRIGGER_PATTERN = /CREATE OR REPLACE FUNCTION reject_audit_log_mutation[\s\S]*?EXECUTE FUNCTION reject_audit_log_mutation\(\);/;
const AUDIT_MUTATION_PATTERN = /^\s*(?:update\s+audit_log\b|delete\s+from\s+audit_log\b)/i;

export function withoutAuditTrigger(sql: string): string {
  return sql.replace(AUDIT_TRIGGER_PATTERN, '');
}

/** pg-mem throws on empty or comment-only scripts, so such migrations are skipped entirely. */
function hasExecutableSql(sql: string): boolean {
  return sql
    .split(/\r?\n/)
    .some((line) => line.trim().length > 0 && !line.trimStart().startsWith('--'));
}

/** Replicates the database-level append-only trigger that pg-mem cannot execute. */
export function enforceAuditLogAppendOnly(memory: ReturnType<typeof newDb>): void {
  memory.on('query', (query: string) => {
    if (AUDIT_MUTATION_PATTERN.test(query)) {
      throw new Error('audit_log is append-only');
    }
  });
}

async function readMigration(name: string): Promise<string> {
  const sql = await readFile(path.join(migrationsDir, name), 'utf8');
  return name === '0016_audit_log_append_only.sql' ? withoutAuditTrigger(sql) : sql;
}

/**
 * Builds an in-memory database with every project migration applied. pg-mem cannot parse the
 * legacy plpgsql ledger trigger or the audit trigger, so both are stripped; ledger append-only
 * enforcement is intentionally out of scope for these tests, and audit append-only enforcement is
 * restored separately by callers via `enforceAuditLogAppendOnly`.
 */
export async function createMigratedDatabase(options: { enforceAuditAppendOnly?: boolean } = {}): Promise<Database> {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  if (options.enforceAuditAppendOnly !== false) enforceAuditLogAppendOnly(memory);
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool() as Pool;

  let phaseOne = await readFile(path.join(migrationsDir, '0001_phase1.sql'), 'utf8');
  // pg-mem does not support plpgsql trigger functions; the ledger guard is Postgres-only.
  phaseOne = phaseOne.split('CREATE OR REPLACE FUNCTION reject_ledger_mutation()')[0] ?? phaseOne;
  await pool.query(phaseOne);

  const phaseTwo = await readFile(path.join(migrationsDir, '0002_usdc_base.sql'), 'utf8');
  // The legacy-row backfill uses jsonb_build_object, which pg-mem lacks; the fixture is empty.
  const backfillStart = phaseTwo.indexOf('UPDATE payments\n   SET adapter_data = jsonb_build_object');
  if (backfillStart >= 0) {
    const backfillEnd = phaseTwo.indexOf(';', backfillStart);
    await pool.query(phaseTwo.slice(0, backfillStart) + phaseTwo.slice(backfillEnd + 1));
  } else {
    await pool.query(phaseTwo);
  }

  let webhookMigration = await readFile(path.join(migrationsDir, '0003_webhooks.sql'), 'utf8');
  // pg-mem autogenerates a different inline check name, so let migration 0004 replace the whitelist.
  webhookMigration = webhookMigration.replace(
    /event_type text NOT NULL CHECK \(event_type IN \([\s\S]*?\)\),/,
    'event_type text NOT NULL,',
  );
  await pool.query(webhookMigration);

  for (const migration of APPLICATION_MIGRATIONS) {
    const sql = await readMigration(migration);
    if (hasExecutableSql(sql)) await pool.query(sql);
  }

  return {
    query: (text, values = []) => pool.query(text, values),
    transaction: async (run) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await run(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  } as Database;
}
