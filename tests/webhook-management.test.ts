import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };
const secret = 'whsec-merchant-secret-that-is-long-enough-123456';

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
    '0010_sms_provider_hardening.sql', '0011_merchant_usage_limits.sql']) {
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

describe('merchant self-service webhook management', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let apiKey: string;
  let merchantId: string;

  async function createMerchant(name: string, email: string, wallet: string) {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return { apiKey: response.json().apiKey as string, merchantId: response.json().merchant.id as string };
  }

  const list = (key: string) => app.inject({ method: 'GET', url: '/v1/webhooks', headers: { authorization: `Bearer ${key}` } });
  const create = (key: string, payload: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/v1/webhooks', headers: { authorization: `Bearer ${key}` }, payload,
  });
  const patch = (key: string, id: string, payload: Record<string, unknown>) => app.inject({
    method: 'PATCH', url: `/v1/webhooks/${id}`, headers: { authorization: `Bearer ${key}` }, payload,
  });
  const remove = (key: string, id: string) => app.inject({
    method: 'DELETE', url: `/v1/webhooks/${id}`, headers: { authorization: `Bearer ${key}` },
  });

  beforeEach(async () => {
    db = await createDatabase();
    app = await buildApp({ db });
    const merchant = await createMerchant('Hook Store', 'hooks@example.com', '0xffffffffffffffffffffffffffffffffffffffff');
    apiKey = merchant.apiKey;
    merchantId = merchant.merchantId;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('creates, lists, updates and deletes an endpoint', async () => {
    const created = await create(apiKey, {
      name: 'Primary hook', url: 'https://hooks.example.test/events', secret, events: ['payment.confirmed', 'order.paid'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const endpointId = created.json().endpoint.id as string;
    expect(created.json().endpoint).toMatchObject({
      name: 'Primary hook', url: 'https://hooks.example.test/events',
      events: ['payment.confirmed', 'order.paid'], enabled: true,
    });
    expect(created.body).not.toContain(secret);
    expect(created.json().endpoint).not.toHaveProperty('secret');

    const listed = await list(apiKey);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().endpoints).toHaveLength(1);
    expect(listed.body).not.toContain(secret);

    const updated = await patch(apiKey, endpointId, {
      name: 'Renamed hook', url: 'https://hooks.example.test/v2', events: ['invoice.issued'],
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().endpoint).toMatchObject({
      name: 'Renamed hook', url: 'https://hooks.example.test/v2', events: ['invoice.issued'], enabled: true,
    });
    expect(updated.body).not.toContain(secret);

    const deleted = await remove(apiKey, endpointId);
    expect(deleted.statusCode).toBe(204);
    const afterDelete = await list(apiKey);
    expect(afterDelete.json().endpoints).toHaveLength(0);
  });

  it('selects events and rejects unknown or empty event sets', async () => {
    const created = await create(apiKey, {
      name: 'Scoped', url: 'https://hooks.example.test/scoped', secret, events: ['credit.deducted', 'sms.request.completed'],
    });
    expect(created.statusCode).toBe(201);
    const endpointId = created.json().endpoint.id as string;
    expect(created.json().endpoint.events).toEqual(['credit.deducted', 'sms.request.completed']);

    const changed = await patch(apiKey, endpointId, { events: ['payment.confirmed', 'payment.failed'] });
    expect(changed.json().endpoint.events).toEqual(['payment.confirmed', 'payment.failed']);

    const invalid = await create(apiKey, {
      name: 'Bad', url: 'https://hooks.example.test/bad', secret, events: ['not.an.event'],
    });
    expect(invalid.statusCode).toBe(400);
    const empty = await create(apiKey, {
      name: 'Empty', url: 'https://hooks.example.test/empty', secret, events: [],
    });
    expect(empty.statusCode).toBe(400);
    const duplicates = await create(apiKey, {
      name: 'Dupes', url: 'https://hooks.example.test/dupes', secret, events: ['order.paid', 'order.paid'],
    });
    expect(duplicates.statusCode).toBe(400);
  });

  it('enables and disables an endpoint and cancels queued deliveries when paused', async () => {
    const created = await create(apiKey, {
      name: 'Toggle', url: 'https://hooks.example.test/toggle', secret, events: ['payment.confirmed'],
    });
    const endpointId = created.json().endpoint.id as string;
    const eventId = '11111111-1111-4111-8111-111111111111';
    const deliveryId = '22222222-2222-4222-8222-222222222222';
    await db.query(
      `INSERT INTO webhook_events (id, merchant_id, event_type, resource_id, payload)
       VALUES ($1, $2, 'payment.confirmed', $3, '{}'::jsonb)`,
      [eventId, merchantId, '33333333-3333-4333-8333-333333333333'],
    );
    await db.query(
      `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, attempts, next_attempt_at)
       VALUES ($1, $2, $3, 'QUEUED', 0, now())`,
      [deliveryId, endpointId, eventId],
    );

    const paused = await patch(apiKey, endpointId, { enabled: false });
    expect(paused.json().endpoint.enabled).toBe(false);
    const cancelled = await db.query<{ status: string }>(
      'SELECT status FROM webhook_deliveries WHERE id = $1', [deliveryId],
    );
    expect(cancelled.rows[0].status).toBe('CANCELLED');
    expect((await list(apiKey)).json().endpoints[0].enabled).toBe(false);

    const resumed = await patch(apiKey, endpointId, { enabled: true });
    expect(resumed.json().endpoint.enabled).toBe(true);
  });

  it('never exposes the secret and stores it encrypted at rest', async () => {
    const created = await create(apiKey, {
      name: 'Secretive', url: 'https://hooks.example.test/secret', secret, events: ['order.paid'],
    });
    const endpointId = created.json().endpoint.id as string;
    const row = await db.query<{ secret_ciphertext: string; secret_nonce: string; secret_auth_tag: string }>(
      'SELECT secret_ciphertext, secret_nonce, secret_auth_tag FROM webhook_endpoints WHERE id = $1', [endpointId],
    );
    expect(row.rows[0].secret_ciphertext).not.toBe(secret);
    expect(Object.values(row.rows[0]).map((value) => String(value))).not.toContain(secret);
    expect(JSON.stringify(row.rows[0])).not.toContain(secret);
    expect(row.rows[0].secret_ciphertext.length).toBeGreaterThan(0);

    // Rotating the secret re-encrypts it and still never returns it.
    const rotated = await patch(apiKey, endpointId, { secret: `${secret}-rotated` });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.body).not.toContain(secret);
    expect(rotated.body).not.toContain(`${secret}-rotated`);
    const rotatedRow = await db.query<{ secret_ciphertext: string }>(
      'SELECT secret_ciphertext FROM webhook_endpoints WHERE id = $1', [endpointId],
    );
    expect(rotatedRow.rows[0].secret_ciphertext).not.toBe(row.rows[0].secret_ciphertext);
  });

  it('returns delivery history and attempts to the owning merchant only', async () => {
    const created = await create(apiKey, {
      name: 'History', url: 'https://hooks.example.test/history', secret, events: ['payment.confirmed'],
    });
    const endpointId = created.json().endpoint.id as string;
    const other = await createMerchant('Other Hooks', 'other-hooks@example.com', '0xabababababababababababababababababababab');

    const eventId = '44444444-4444-4444-8444-444444444444';
    const deliveryId = '55555555-5555-4555-8555-555555555555';
    await db.query(
      `INSERT INTO webhook_events (id, merchant_id, event_type, resource_id, payload)
       VALUES ($1, $2, 'payment.confirmed', $3, '{"amount":"1.00"}'::jsonb)`,
      [eventId, merchantId, '66666666-6666-4666-8666-666666666666'],
    );
    await db.query(
      `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, attempts, next_attempt_at, last_http_status, last_error)
       VALUES ($1, $2, $3, 'FAILED', 2, now(), 503, 'receiver down')`,
      [deliveryId, endpointId, eventId],
    );
    await db.query(
      `INSERT INTO webhook_delivery_attempts (id, delivery_id, attempt_number, request_timestamp, started_at, finished_at, http_status, error)
       VALUES ($1, $2, 1, 1, now(), now(), 503, 'receiver down')`,
      ['77777777-7777-4777-8777-777777777777', deliveryId],
    );

    const deliveries = await app.inject({
      method: 'GET', url: `/v1/webhooks/${endpointId}/deliveries`, headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(deliveries.statusCode).toBe(200);
    expect(deliveries.json().deliveries).toHaveLength(1);
    expect(deliveries.json().deliveries[0]).toMatchObject({ event: 'payment.confirmed', status: 'FAILED', attempts: 2, lastHttpStatus: 503 });
    // Stored errors are normalized; raw transport detail and secrets are never returned.
    expect(deliveries.json().deliveries[0].lastError).toBe('Webhook receiver returned HTTP 503');
    expect(deliveries.body).not.toContain(secret);

    const attempts = await app.inject({
      method: 'GET', url: `/v1/webhooks/${endpointId}/deliveries/${deliveryId}/attempts`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(attempts.statusCode).toBe(200);
    expect(attempts.json().attempts).toHaveLength(1);
    expect(attempts.json().attempts[0]).toMatchObject({ attemptNumber: 1, httpStatus: 503 });

    // Another merchant cannot read this endpoint's deliveries or attempts.
    for (const url of [
      `/v1/webhooks/${endpointId}/deliveries`,
      `/v1/webhooks/${endpointId}/deliveries/${deliveryId}/attempts`,
    ]) {
      const forbidden = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${other.apiKey}` } });
      expect(forbidden.statusCode, url).toBe(200);
      const body = forbidden.json();
      expect((body.deliveries ?? body.attempts ?? []).length, url).toBe(0);
    }
  });

  it('keeps endpoints isolated between merchants', async () => {
    const created = await create(apiKey, {
      name: 'Mine', url: 'https://hooks.example.test/mine', secret, events: ['order.paid'],
    });
    const endpointId = created.json().endpoint.id as string;
    const other = await createMerchant('Isolated', 'isolated@example.com', '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd');
    const otherCreated = await create(other.apiKey, {
      name: 'Theirs', url: 'https://hooks.example.test/theirs', secret, events: ['order.paid'],
    });
    const otherEndpointId = otherCreated.json().endpoint.id as string;

    const myList = await list(apiKey);
    expect(myList.json().endpoints.map((endpoint: { name: string }) => endpoint.name)).toEqual(['Mine']);
    expect(myList.body).not.toContain(otherEndpointId);

    // Cross-merchant patch and delete are 404 and do not affect the endpoint.
    expect((await patch(apiKey, otherEndpointId, { name: 'Hijacked' })).statusCode).toBe(404);
    expect((await remove(apiKey, otherEndpointId)).statusCode).toBe(404);
    const otherList = await list(other.apiKey);
    expect(otherList.json().endpoints[0]).toMatchObject({ name: 'Theirs', enabled: true });
  });

  it('rejects unauthenticated requests and missing endpoints', async () => {
    for (const request of [
      { method: 'GET', url: '/v1/webhooks' },
      { method: 'POST', url: '/v1/webhooks', payload: { name: 'x', url: 'https://hooks.example.test/x', secret, events: ['order.paid'] } },
      { method: 'PATCH', url: '/v1/webhooks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', payload: { enabled: false } },
      { method: 'DELETE', url: '/v1/webhooks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    ]) {
      const anonymous = await app.inject(request as never);
      expect(anonymous.statusCode).toBe(401);
    }
    expect((await patch(apiKey, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { enabled: false })).statusCode).toBe(404);
    expect((await remove(apiKey, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).statusCode).toBe(404);
    const shortSecret = await create(apiKey, {
      name: 'Short', url: 'https://hooks.example.test/short', secret: 'too-short', events: ['order.paid'],
    });
    expect(shortSecret.statusCode).toBe(400);
  });
});
