import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../src/db.js';

// Opt-in real-PostgreSQL integration lane.
//
// The default `npm test` suite runs on pg-mem, which cannot execute PL/pgSQL
// triggers and therefore strips the ledger immutability and audit append-only
// guards. This lane connects to a REAL PostgreSQL 16 and runs the actual
// migration runner so those database-level guarantees are exercised for real.
//
// It is skipped unless TEST_DATABASE_URL points at a disposable/dedicated
// database. Never point it at production. It does not require superuser/admin
// privileges and does not drop the database; it cleans up only the rows it
// creates.

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
const runLane = Boolean(testDatabaseUrl);

// A fixed set of random UUIDs lets cleanup target exactly this run.
const marker = randomUUID();
const merchantId = randomUUID();
const ledgerEntryId = randomUUID();
const auditEntryId = randomUUID();

const migrationCount = 16;

describe.skipIf(!runLane)('real PostgreSQL integration', () => {
  let db: PostgresDatabase;

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    db = new PostgresDatabase(testDatabaseUrl);
  });

  afterAll(async () => {
    if (!db) return;
    // Best-effort cleanup of only the rows this test created. Ledger rows are
    // immutable by trigger, so they are cleaned up by dropping the migration
    // rows indirectly is impossible; instead we rely on the disposable database
    // and simply detach the merchant last (children first). If a cleanup step is
    // blocked by a trigger we swallow it and leave the disposable data behind.
    try { await db.query('DELETE FROM audit_log WHERE id = $1', [auditEntryId]); } catch { /* append-only, expected */ }
    await db.close();
  });

  it('applies all current migrations through the real migration runner', async () => {
    await db.migrate();
    const applied = await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    const versions = applied.rows.map((row) => row.version);

    // Re-running the idempotent runner must not duplicate rows.
    await db.migrate();
    const reapplied = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM schema_migrations');
    expect(reapplied.rows[0]!.count).toBe(versions.length);

    expect(versions).toHaveLength(migrationCount);
    expect(versions).toContain('0001_phase1.sql');
    expect(versions).toContain('0016_audit_log_append_only.sql');
    // Filenames are forward-only and sorted; the newest is the audit trigger.
    expect(versions[versions.length - 1]).toBe('0016_audit_log_append_only.sql');
  });

  it('creates a valid merchant to anchor foreign keys', async () => {
    await db.query(
      `INSERT INTO merchants (id, name, email, wallet_address)
       VALUES ($1, $2, lower($3), lower($4))`,
      [merchantId, `pg-it ${marker}`, `pg-it-${marker}@example.com`, '0x9999999999999999999999999999999999999999'],
    );
    const found = await db.query('SELECT id FROM merchants WHERE id = $1', [merchantId]);
    expect(found.rows).toHaveLength(1);
  });

  it('rejects UPDATE and DELETE on ledger_entries via the real trigger', async () => {
    await db.query(
      `INSERT INTO ledger_entries (id, merchant_id, entry_type, amount, currency, reference)
       VALUES ($1, $2, 'CREDIT_TOPUP', 1.000000, 'USDC', $3)`,
      [ledgerEntryId, merchantId, `pg-it-${marker}`],
    );

    await expect(db.query(`UPDATE ledger_entries SET amount = 2.000000 WHERE id = $1`, [ledgerEntryId]))
      .rejects.toThrow(/immutable/);
    await expect(db.query('DELETE FROM ledger_entries WHERE id = $1', [ledgerEntryId]))
      .rejects.toThrow(/immutable/);

    const stillThere = await db.query('SELECT amount::text AS amount FROM ledger_entries WHERE id = $1', [ledgerEntryId]);
    expect(stillThere.rows[0]!.amount).toBe('1.000000');
  });

  it('rejects UPDATE and DELETE on audit_log but allows INSERT', async () => {
    await db.query(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'merchant', $2, 'settings.update', 'settings', $2, '{}'::jsonb)`,
      [auditEntryId, merchantId],
    );

    await expect(db.query(`UPDATE audit_log SET action = 'tampered' WHERE id = $1`, [auditEntryId]))
      .rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM audit_log WHERE id = $1', [auditEntryId]))
      .rejects.toThrow(/append-only/);

    const row = await db.query('SELECT action FROM audit_log WHERE id = $1', [auditEntryId]);
    expect(row.rows[0]!.action).toBe('settings.update');
    expect((await db.query('SELECT count(*)::int AS count FROM audit_log WHERE id = $1', [auditEntryId])).rows[0]!.count).toBe(1);
  });

  it('reproduces real-engine upsert behavior that pg-mem does not', async () => {
    // The application relies on `ON CONFLICT ... DO UPDATE ... RETURNING`
    // returning the freshly updated row (customer upsert). pg-mem is known to
    // return stale values here, so this is verified on the real engine.
    const first = await db.query<{ email: string }>(
      `INSERT INTO customers (id, merchant_id, external_id, email, name)
       VALUES ($1, $2, 'pg-it-upsert', 'before@example.com', 'Before')
       ON CONFLICT (merchant_id, external_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING email`,
      [randomUUID(), merchantId],
    );
    expect(first.rows[0]!.email).toBe('before@example.com');

    const second = await db.query<{ email: string }>(
      `INSERT INTO customers (id, merchant_id, external_id, email, name)
       VALUES ($1, $2, 'pg-it-upsert', 'after@example.com', 'After')
       ON CONFLICT (merchant_id, external_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING email`,
      [randomUUID(), merchantId],
    );
    // Real PostgreSQL returns the updated value, not the stale pre-update row.
    expect(second.rows[0]!.email).toBe('after@example.com');
  });

  it('cleans up the rows it created where the schema permits', async () => {
    await db.query('DELETE FROM customers WHERE merchant_id = $1', [merchantId]);
    await db.query('DELETE FROM merchants WHERE id = $1', [merchantId]);
    // audit_log and ledger_entries stay behind (append-only/immutable) on the
    // disposable test database by design.
    const customers = await db.query('SELECT count(*)::int AS count FROM customers WHERE merchant_id = $1', [merchantId]);
    expect(customers.rows[0]!.count).toBe(0);
  });
});
