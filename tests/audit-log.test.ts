import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sanitizeAuditMetadata } from '../src/services/audit-log-service.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };

function pgAdapterPool(memory: ReturnType<typeof newDb>): Pool {
  const adapter = memory.adapters.createPg();
  return new adapter.Pool() as Pool;
}

async function createDatabase(): Promise<Database> {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const pool = pgAdapterPool(memory);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  let phaseOne = await readFile(path.join(migrationsDir, '0001_phase1.sql'), 'utf8');
  phaseOne = phaseOne.split('CREATE OR REPLACE FUNCTION reject_ledger_mutation()')[0] ?? phaseOne;
  await pool.query(phaseOne);
  const phaseTwo = await readFile(path.join(migrationsDir, '0002_usdc_base.sql'), 'utf8');
  const backfillStart = phaseTwo.indexOf('UPDATE payments\n   SET adapter_data = jsonb_build_object');
  if (backfillStart >= 0) {
    const backfillEnd = phaseTwo.indexOf(';', backfillStart);
    await pool.query(phaseTwo.slice(0, backfillStart) + phaseTwo.slice(backfillEnd + 1));
  } else {
    await pool.query(phaseTwo);
  }
  let webhookMigration = await readFile(path.join(migrationsDir, '0003_webhooks.sql'), 'utf8');
  webhookMigration = webhookMigration.replace(
    /event_type text NOT NULL CHECK \(event_type IN \([\s\S]*?\)\),/,
    'event_type text NOT NULL,',
  );
  await pool.query(webhookMigration);
  for (const migration of ['0004_credit_engine.sql', '0005_ai_pricing.sql', '0006_invoices_receipts.sql',
    '0007_subscriptions.sql', '0008_ai_provider_integration.sql', '0009_sms_otp.sql',
    '0010_sms_provider_hardening.sql', '0011_merchant_usage_limits.sql', '0012_payment_links.sql',
    '0013_merchant_settings.sql', '0014_notification_preferences.sql', '0015_audit_log.sql']) {
    await pool.query(await readFile(path.join(migrationsDir, migration), 'utf8'));
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

type Merchant = { apiKey: string; merchantId: string };

const webhookSecret = 'whsec_live_' + 'a'.repeat(40);

describe('append-only audit log', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let alice: Merchant;
  let bob: Merchant;

  async function createMerchant(name: string, email: string, wallet: string): Promise<Merchant> {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return { apiKey: response.json().apiKey as string, merchantId: response.json().merchant.id as string };
  }

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  const merchantAudit = (key: string, query = '') => app.inject({ method: 'GET', url: `/v1/audit-log${query}`, headers: auth(key) });
  const adminAudit = (query = '', headers: Record<string, string> = adminHeaders) => app.inject({ method: 'GET', url: `/v1/admin/audit-log${query}`, headers });

  const updateSettings = (key: string) => app.inject({
    method: 'PUT', url: '/v1/settings', headers: auth(key),
    payload: { displayName: 'Audited Store', supportEmail: 'audit@example.com', defaultCurrency: 'USDC', timezone: 'UTC' },
  });
  const updateNotifications = (key: string) => app.inject({
    method: 'PUT', url: '/v1/notification-preferences', headers: auth(key),
    payload: { paymentConfirmed: true, paymentFailed: false, paymentExpired: true, creditTopup: true,
      aiRequestFailed: true, smsRequestFailed: false, webhookFailed: true },
  });
  const createApiKey = (key: string, name: string) => app.inject({
    method: 'POST', url: '/v1/api-keys', headers: auth(key), payload: { name },
  });
  const revokeApiKey = (key: string, keyId: string) => app.inject({ method: 'DELETE', url: `/v1/api-keys/${keyId}`, headers: auth(key) });
  const createWebhook = (key: string, name = 'Audit hook') => app.inject({
    method: 'POST', url: '/v1/webhooks', headers: auth(key),
    payload: { name, url: 'https://hooks.example.test/audit', events: ['payment.confirmed'], secret: webhookSecret },
  });
  const patchWebhook = (key: string, id: string) => app.inject({
    method: 'PATCH', url: `/v1/webhooks/${id}`, headers: auth(key),
    payload: { name: 'Renamed hook', secret: 'whsec_live_' + 'b'.repeat(40), enabled: false },
  });
  const deleteWebhook = (key: string, id: string) => app.inject({ method: 'DELETE', url: `/v1/webhooks/${id}`, headers: auth(key) });
  const createLink = (key: string) => app.inject({
    method: 'POST', url: '/v1/payment-links', headers: { ...auth(key), 'idempotency-key': randomUUID() },
    payload: { description: 'Audit link', amount: '12.50', currency: 'USDC' },
  });
  const patchLink = (key: string, id: string, enabled: boolean) => app.inject({
    method: 'PATCH', url: `/v1/payment-links/${id}`, headers: auth(key), payload: { enabled },
  });
  const deleteLink = (key: string, id: string) => app.inject({ method: 'DELETE', url: `/v1/payment-links/${id}`, headers: auth(key) });

  beforeEach(async () => {
    db = await createDatabase();
    app = await buildApp({ db });
    alice = await createMerchant('Alice Store', 'alice@example.com', '0x1111111111111111111111111111111111111111');
    bob = await createMerchant('Bob Store', 'bob@example.com', '0x2222222222222222222222222222222222222222');
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('records every initial merchant action with actor, resource and safe metadata', async () => {
    expect((await updateSettings(alice.apiKey)).statusCode).toBe(200);
    expect((await updateNotifications(alice.apiKey)).statusCode).toBe(200);

    const createdKey = await createApiKey(alice.apiKey, 'Audit key');
    expect(createdKey.statusCode).toBe(201);
    const keyId = createdKey.json().apiKey.id as string;
    const apiKeySecret = createdKey.json().secret as string;
    expect((await revokeApiKey(alice.apiKey, keyId)).statusCode).toBe(204);

    const createdHook = await createWebhook(alice.apiKey);
    expect(createdHook.statusCode).toBe(201);
    const hookId = createdHook.json().endpoint.id as string;
    expect((await patchWebhook(alice.apiKey, hookId)).statusCode).toBe(200);
    expect((await deleteWebhook(alice.apiKey, hookId)).statusCode).toBe(204);

    const createdLink = await createLink(alice.apiKey);
    expect(createdLink.statusCode, createdLink.body).toBe(201);
    const paymentId = createdLink.json().payment.id as string;
    expect((await patchLink(alice.apiKey, paymentId, false)).statusCode).toBe(200);
    expect((await patchLink(alice.apiKey, paymentId, true)).statusCode).toBe(200);
    expect((await deleteLink(alice.apiKey, paymentId)).statusCode).toBe(204);

    const response = await merchantAudit(alice.apiKey);
    expect(response.statusCode, response.body).toBe(200);
    const { entries, pagination } = response.json();
    expect(pagination).toMatchObject({ limit: 50, offset: 0, hasMore: false });
    const byAction = new Map(entries.map((entry: { action: string }) => [entry.action, entry]));
    for (const action of ['settings.update', 'notification_preferences.update', 'api_key.create', 'api_key.revoke',
      'webhook.create', 'webhook.update', 'webhook.delete',
      'payment_link.disable', 'payment_link.enable', 'payment_link.delete']) {
      expect(byAction.has(action), `missing ${action}`).toBe(true);
    }
    for (const entry of entries) {
      expect(entry.actorType).toBe('merchant');
      expect(entry.actorId).toBe(alice.merchantId);
    }
    expect(byAction.get('settings.update').resourceType).toBe('settings');
    expect(byAction.get('settings.update').metadata.fields).toEqual(
      expect.arrayContaining(['displayName', 'supportEmail', 'defaultCurrency', 'timezone']));
    expect(byAction.get('api_key.create').metadata.name).toBe('Audit key');
    expect(byAction.get('api_key.create').metadata.prefix).toMatch(/^tf_live_/);
    expect(byAction.get('notification_preferences.update').metadata.preferences.paymentConfirmed).toBe(true);
    expect(byAction.get('notification_preferences.update').metadata.preferences.paymentFailed).toBe(false);
    expect(byAction.get('payment_link.enable').metadata.enabled).toBe(true);
    expect(byAction.get('payment_link.disable').metadata.enabled).toBe(false);

    // Newest-first ordering.
    const times = entries.map((entry: { createdAt: string }) => new Date(entry.createdAt).getTime());
    expect(times).toEqual([...times].sort((left: number, right: number) => right - left));

    // The API key secret is never part of the audit metadata.
    expect(response.body).not.toContain(apiKeySecret);
  });

  it('is append-only: prior entries are unchanged and no mutation route exists', async () => {
    expect((await updateSettings(alice.apiKey)).statusCode).toBe(200);
    const first = (await merchantAudit(alice.apiKey)).json().entries;
    expect(first).toHaveLength(1);
    const original = first[0];

    expect((await updateNotifications(alice.apiKey)).statusCode).toBe(200);
    const second = (await merchantAudit(alice.apiKey)).json().entries;
    expect(second).toHaveLength(2);
    const preserved = second.find((entry: { id: string }) => entry.id === original.id);
    expect(preserved).toEqual(original);

    for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) {
      const merchantMutation = await app.inject({ method: method as 'PUT', url: '/v1/audit-log', headers: auth(alice.apiKey), payload: {} });
      const adminMutation = await app.inject({ method: method as 'PUT', url: '/v1/admin/audit-log', headers: adminHeaders, payload: {} });
      expect([404, 405], merchantMutation.statusCode).toContain(merchantMutation.statusCode);
      expect([404, 405], adminMutation.statusCode).toContain(adminMutation.statusCode);
    }
  });

  it('isolates merchants so each sees only its own entries', async () => {
    expect((await updateSettings(alice.apiKey)).statusCode).toBe(200);
    expect((await createApiKey(alice.apiKey, 'Alice key')).statusCode).toBe(201);
    expect((await updateSettings(bob.apiKey)).statusCode).toBe(200);

    const aliceEntries = (await merchantAudit(alice.apiKey)).json().entries;
    const bobEntries = (await merchantAudit(bob.apiKey)).json().entries;
    expect(aliceEntries.length).toBe(2);
    expect(bobEntries.length).toBe(1);
    for (const entry of aliceEntries) expect(entry.actorId).toBe(alice.merchantId);
    for (const entry of bobEntries) expect(entry.actorId).toBe(bob.merchantId);
    expect(bobEntries.map((entry: { action: string }) => entry.action)).toEqual(['settings.update']);
  });

  it('lets admins read all entries and filter by actor, action and resource type', async () => {
    expect((await updateSettings(alice.apiKey)).statusCode).toBe(200);
    expect((await updateSettings(bob.apiKey)).statusCode).toBe(200);
    expect((await createApiKey(alice.apiKey, 'Admin-visible key')).statusCode).toBe(201);

    const all = await adminAudit();
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().entries.length).toBe(3);
    const actorIds = new Set(all.json().entries.map((entry: { actorId: string }) => entry.actorId));
    expect(actorIds.has(alice.merchantId)).toBe(true);
    expect(actorIds.has(bob.merchantId)).toBe(true);

    const byActor = await adminAudit('?actorType=merchant');
    expect(byActor.json().entries.every((entry: { actorType: string }) => entry.actorType === 'merchant')).toBe(true);

    const byAction = await adminAudit('?action=api_key.create');
    expect(byAction.json().entries).toHaveLength(1);
    expect(byAction.json().entries[0].action).toBe('api_key.create');

    const byResource = await adminAudit('?resourceType=settings');
    expect(byResource.json().entries).toHaveLength(2);
    expect(byResource.json().entries.every((entry: { resourceType: string }) => entry.resourceType === 'settings')).toBe(true);

    const combined = await adminAudit('?actorType=merchant&action=settings.update&resourceType=settings');
    expect(combined.json().entries).toHaveLength(2);

    const noMatch = await adminAudit('?action=does.not.exist');
    expect(noMatch.json().entries).toHaveLength(0);
  });

  it('paginates newest first with bounded limits', async () => {
    for (let index = 0; index < 4; index += 1) {
      expect((await updateSettings(alice.apiKey)).statusCode).toBe(200);
    }
    const firstPage = await merchantAudit(alice.apiKey, '?limit=2');
    expect(firstPage.json().pagination).toEqual({ limit: 2, offset: 0, count: 2, hasMore: true });
    expect(firstPage.json().entries).toHaveLength(2);

    const secondPage = await merchantAudit(alice.apiKey, '?limit=2&offset=2');
    expect(secondPage.json().pagination).toMatchObject({ limit: 2, offset: 2, count: 2, hasMore: false });
    const firstIds = new Set(firstPage.json().entries.map((entry: { id: string }) => entry.id));
    for (const entry of secondPage.json().entries) expect(firstIds.has(entry.id)).toBe(false);

    const clamped = await merchantAudit(alice.apiKey, '?limit=9999&offset=-5');
    expect(clamped.json().pagination).toMatchObject({ limit: 100, offset: 0 });

    const adminPage = await adminAudit('?limit=1');
    expect(adminPage.json().pagination).toMatchObject({ limit: 1, offset: 0, count: 1, hasMore: true });
  });

  it('never stores secrets, credentials, OTP codes or message content', async () => {
    const createdKey = await createApiKey(alice.apiKey, 'Secret test key');
    const apiKeySecret = createdKey.json().secret as string;
    await updateSettings(alice.apiKey);
    const hook = await createWebhook(alice.apiKey, 'Secret hook');
    const hookId = hook.json().endpoint.id as string;
    await patchWebhook(alice.apiKey, hookId);
    await deleteWebhook(alice.apiKey, hookId);

    const body = (await adminAudit()).body;
    expect(body).not.toContain(apiKeySecret);
    expect(body).not.toContain(webhookSecret);
    expect(body).not.toContain('whsec_live_' + 'b'.repeat(40));
    expect(body).not.toContain('audit@example.com');
    expect(body).not.toContain('Bearer ');
    for (const forbidden of ['password', 'secret', 'otp', 'ciphertext', 'macaroon', 'credential']) {
      expect(body.toLowerCase()).not.toContain(`"${forbidden}"`);
    }
    const entries = (await adminAudit()).json().entries;
    const webhookUpdate = entries.find((entry: { action: string }) => entry.action === 'webhook.update');
    expect(webhookUpdate.metadata.changed).toEqual(expect.arrayContaining(['name', 'enabled']));
    expect(webhookUpdate.metadata.changed).not.toContain('secret');
  });

  it('sanitizes metadata defensively before insertion', () => {
    const clean = sanitizeAuditMetadata({
      name: 'ok', secret: 'whsec_should_drop', apiKey: 'drop-me', password: 'drop-me',
      authorization: 'Bearer drop', otp: '123456', message: 'Hello', token: 'drop',
      long: 'x'.repeat(500), count: 3, enabled: true, nullable: null, list: ['a', 'b'],
    });
    expect(clean).toEqual({
      name: 'ok', message: 'Hello', long: 'x'.repeat(200), count: 3, enabled: true, nullable: null, list: ['a', 'b'],
    });
  });

  it('rejects unauthenticated and unauthorized audit access', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/audit-log' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/audit-log', headers: auth('tf_live_invalid') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/audit-log' })).statusCode).toBe(401);
    expect((await adminAudit('', { 'x-admin-api-key': 'wrong' })).statusCode).toBe(401);
    // A merchant credential cannot read the platform-wide admin audit log.
    expect((await app.inject({ method: 'GET', url: '/v1/admin/audit-log', headers: auth(alice.apiKey) })).statusCode).toBe(401);
  });
});
