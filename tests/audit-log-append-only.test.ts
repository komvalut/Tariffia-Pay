import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { AuditLogService, sanitizeAuditMetadata } from '../src/services/audit-log-service.js';
import { createMigratedDatabase, enforceAuditLogAppendOnly, withoutAuditTrigger } from './fixtures/pg-mem-database.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };

// The production migration installs a plpgsql trigger that pg-mem cannot run, so the migration
// loader strips it and the append-only behaviour is reproduced with a pg-mem query hook. This
// suite asserts both that the production migration defines the trigger and that the enforced
// behaviour rejects UPDATE/DELETE while allowing INSERT.
describe('audit log database append-only protection', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let service: AuditLogService;

  beforeEach(async () => {
    db = await createMigratedDatabase();
    service = new AuditLogService(db);
    app = await buildApp({ db });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('allows INSERT but rejects UPDATE and DELETE on audit_log', async () => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, resource_type, metadata)
       VALUES ($1, 'merchant', 'merchant-1', 'settings.update', 'settings', '{}'::jsonb)`,
      [id],
    );
    const inserted = await db.query('SELECT count(*)::int AS count FROM audit_log');
    expect(inserted.rows[0]!.count).toBe(1);

    await expect(db.query(`UPDATE audit_log SET action = 'tampered' WHERE id = $1`, [id]))
      .rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);

    const after = await db.query('SELECT action FROM audit_log WHERE id = $1', [id]);
    expect(after.rows[0]!.action).toBe('settings.update');
    expect((await db.query('SELECT count(*)::int AS count FROM audit_log')).rows[0]!.count).toBe(1);
  });

  it('keeps the append path (AuditLogService.record) working', async () => {
    await service.record({
      actorType: 'merchant', actorId: 'merchant-1', action: 'api_key.create',
      resourceType: 'api_key', resourceId: 'key-1', metadata: { name: 'Key', scopes: ['orders:read'] },
    });
    await service.record({
      actorType: 'merchant', actorId: 'merchant-1', action: 'api_key.revoke',
      resourceType: 'api_key', resourceId: 'key-1',
    });
    const page = await service.listForMerchant('merchant-1');
    expect(page.entries.map((entry) => entry.action)).toEqual(expect.arrayContaining(['api_key.create', 'api_key.revoke']));
    expect(page.pagination).toMatchObject({ count: 2, hasMore: false });
    // Reads never mutate, and mutation remains blocked through the same connection.
    await expect(db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });

  it('still sanitizes metadata on insert', async () => {
    await service.record({
      actorType: 'merchant', actorId: 'merchant-1', action: 'webhook.create', resourceType: 'webhook',
      metadata: { name: 'Hook', secret: 'whsec_should_drop', apiKey: 'drop', enabled: true },
    });
    const page = await service.listForMerchant('merchant-1');
    expect(page.entries[0]!.metadata).toEqual({ name: 'Hook', enabled: true });
    expect(sanitizeAuditMetadata({ otp: '123456', message: 'hi' })).toEqual({ message: 'hi' });
  });

  it('keeps the merchant and admin audit-log endpoints working despite the trigger', async () => {
    const merchant = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name: 'Append Store', email: 'append@example.com', walletAddress: '0x5151515151515151515151515151515151515151' },
    });
    const apiKey = merchant.json().apiKey as string;
    // An API key creation writes an audit entry through the real route.
    const created = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${apiKey}` }, payload: { name: 'Append key' } });
    expect(created.statusCode, created.body).toBe(201);

    const merchantLog = await app.inject({ method: 'GET', url: '/v1/audit-log', headers: { authorization: `Bearer ${apiKey}` } });
    expect(merchantLog.statusCode, merchantLog.body).toBe(200);
    expect(merchantLog.json().entries.map((entry: { action: string }) => entry.action)).toContain('api_key.create');

    const adminLog = await app.inject({ method: 'GET', url: '/v1/admin/audit-log', headers: adminHeaders });
    expect(adminLog.statusCode, adminLog.body).toBe(200);
    expect(adminLog.json().entries.length).toBeGreaterThanOrEqual(1);

    // The application cannot mutate the log even if it tried to.
    await expect(db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE audit_log SET metadata = '{"x":1}'::jsonb`)).rejects.toThrow(/append-only/);
  });

  it('defines the production trigger in the migration and can strip it for pg-mem', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
    const sql = await readFile(path.join(migrationsDir, '0016_audit_log_append_only.sql'), 'utf8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION reject_audit_log_mutation()');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON audit_log');
    expect(sql).toContain('EXECUTE FUNCTION reject_audit_log_mutation()');
    // The stripper used by the pg-mem loader removes the whole trigger definition.
    const stripped = withoutAuditTrigger(sql);
    expect(stripped).not.toContain('CREATE OR REPLACE FUNCTION reject_audit_log_mutation');
    expect(stripped).not.toContain('CREATE TRIGGER audit_log_append_only');
    // And the enforcement helper blocks mutations.
    expect(() => enforceAuditLogAppendOnly).not.toThrow();
  });
});
