import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { LEGACY_DEFAULT_SCOPES, MERCHANT_SCOPES } from '../src/scopes.js';
import { createMigratedDatabase } from './fixtures/pg-mem-database.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };

async function createDatabase(): Promise<Database> {
  return createMigratedDatabase();
}

type Merchant = { apiKey: string; merchantId: string };

describe('merchant API key scopes', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let alice: Merchant;
  let bob: Merchant;

  async function provision(name: string, email: string, wallet: string): Promise<Merchant> {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return { apiKey: response.json().apiKey as string, merchantId: response.json().merchant.id as string };
  }

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  const createKey = (key: string, payload: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/v1/api-keys', headers: auth(key), payload,
  });

  beforeEach(async () => {
    db = await createDatabase();
    app = await buildApp({ db });
    alice = await provision('Alice Store', 'alice@example.com', '0x1111111111111111111111111111111111111111');
    bob = await provision('Bob Store', 'bob@example.com', '0x2222222222222222222222222222222222222222');
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('grants newly provisioned keys the full default scope catalogue', async () => {
    for (const url of ['/v1/settings', '/v1/orders', '/v1/customers', '/v1/ai/models', '/v1/usage', '/v1/audit-log']) {
      const response = await app.inject({ method: 'GET', url, headers: auth(alice.apiKey) });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    }
    const keys = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: auth(alice.apiKey) });
    expect(keys.json().apiKeys[0].scopes.sort()).toEqual([...MERCHANT_SCOPES].sort());
  });

  it('allows a scoped key only on routes its scopes cover and returns 403 otherwise', async () => {
    const created = await createKey(alice.apiKey, { name: 'Customers reader', scopes: ['customers:read'] });
    expect(created.statusCode, created.body).toBe(201);
    const scopedKey = created.json().secret as string;
    expect(created.json().apiKey.scopes).toEqual(['customers:read']);

    expect((await app.inject({ method: 'GET', url: '/v1/customers', headers: auth(scopedKey) })).statusCode).toBe(200);
    const forbidden = await app.inject({ method: 'GET', url: '/v1/settings', headers: auth(scopedKey) });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: 'insufficient_scope' });
    expect(forbidden.json().message).toContain('settings:read');
    expect((await app.inject({ method: 'GET', url: '/v1/orders', headers: auth(scopedKey) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/ai/models', headers: auth(scopedKey) })).statusCode).toBe(403);
    // A read scope does not grant the matching write route.
    expect((await app.inject({
      method: 'POST', url: '/v1/customers', headers: auth(scopedKey), payload: { externalId: 'x', email: 'x@example.com' },
    })).statusCode).toBe(403);
    expect(forbidden.body).not.toContain(scopedKey);
  });

  it('treats a write scope as implying its read scope', async () => {
    const created = await createKey(alice.apiKey, { name: 'Customers writer', scopes: ['customers:write'] });
    const scopedKey = created.json().secret as string;
    // Read is implied by write.
    expect((await app.inject({ method: 'GET', url: '/v1/customers', headers: auth(scopedKey) })).statusCode).toBe(200);
    const write = await app.inject({
      method: 'POST', url: '/v1/customers', headers: auth(scopedKey),
      payload: { externalId: 'writer-1', email: 'writer@example.com' },
    });
    expect(write.statusCode, write.body).toBe(201);
    // Unrelated area is still denied.
    expect((await app.inject({ method: 'GET', url: '/v1/settings', headers: auth(scopedKey) })).statusCode).toBe(403);
  });

  it('supports multiple scopes and enforces each area independently', async () => {
    const created = await createKey(alice.apiKey, { name: 'Orders reader, settings writer', scopes: ['orders:read', 'settings:write'] });
    const scopedKey = created.json().secret as string;
    expect((await app.inject({ method: 'GET', url: '/v1/orders', headers: auth(scopedKey) })).statusCode).toBe(200);
    const settings = await app.inject({
      method: 'PUT', url: '/v1/settings', headers: auth(scopedKey),
      payload: { displayName: 'Scoped', supportEmail: null, defaultCurrency: 'USDC', timezone: 'UTC' },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/ai/models', headers: auth(scopedKey) })).statusCode).toBe(403);
  });

  it('rejects unknown or empty scope sets at creation', async () => {
    expect((await createKey(alice.apiKey, { name: 'bad', scopes: ['not-a-scope'] })).statusCode).toBe(400);
    expect((await createKey(alice.apiKey, { name: 'empty', scopes: [] })).statusCode).toBe(400);
    expect((await createKey(alice.apiKey, { name: 'unknown field', scopes: ['orders:read'], extra: true })).statusCode).toBe(400);
  });

  it('rejects revoked keys with 401', async () => {
    const created = await createKey(alice.apiKey, { name: 'Revocable', scopes: ['orders:read'] });
    const scopedKey = created.json().secret as string;
    const keyId = created.json().apiKey.id as string;
    expect((await app.inject({ method: 'GET', url: '/v1/orders', headers: auth(scopedKey) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/v1/api-keys/${keyId}`, headers: auth(alice.apiKey) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/orders', headers: auth(scopedKey) })).statusCode).toBe(401);
  });

  it('grandfathers keys issued before scope enforcement as full access', async () => {
    const created = await createKey(alice.apiKey, { name: 'Legacy shape', scopes: ['orders:read'] });
    const keyId = created.json().apiKey.id as string;
    // Simulate a pre-scope-enforcement key by writing the historical default set directly.
    await db.query('UPDATE api_keys SET scopes = $1 WHERE id = $2', [LEGACY_DEFAULT_SCOPES, keyId]);
    const legacyKey = created.json().secret as string;
    for (const url of ['/v1/settings', '/v1/ai/models', '/v1/usage', '/v1/orders']) {
      expect((await app.inject({ method: 'GET', url, headers: auth(legacyKey) })).statusCode, url).toBe(200);
    }
  });

  it('keeps merchants isolated when using scoped keys', async () => {
    const createdCustomer = await app.inject({
      method: 'POST', url: '/v1/customers', headers: auth(alice.apiKey),
      payload: { externalId: 'alice-customer', email: 'buyer@example.com' },
    });
    expect(createdCustomer.statusCode).toBe(201);
    const customerId = createdCustomer.json().customer.id as string;
    const bobScoped = await createKey(bob.apiKey, { name: 'Bob reader', scopes: ['customers:read'] });
    const bobKey = bobScoped.json().secret as string;
    expect((await app.inject({ method: 'GET', url: `/v1/customers/${customerId}`, headers: auth(bobKey) })).statusCode).toBe(404);
    const bobList = await app.inject({ method: 'GET', url: '/v1/customers', headers: auth(bobKey) });
    expect(bobList.json().customers).toEqual([]);
  });
});
