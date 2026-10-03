import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { hashApiKey } from '../src/security.js';
import { createMigratedDatabase } from './fixtures/pg-mem-database.js';

const adminHeaders = { 'x-admin-api-key': 'dev-admin-key-change-this-before-deploy' };

async function createDatabase(): Promise<Database> {
  return createMigratedDatabase();
}

describe('merchant self-service API keys', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let merchantId: string;
  let apiKey: string;

  async function createMerchant(name: string, email: string, wallet: string) {
    const response = await app.inject({
      method: 'POST', url: '/v1/admin/merchants', headers: adminHeaders,
      payload: { name, email, walletAddress: wallet },
    });
    expect(response.statusCode, response.body).toBe(201);
    return { merchantId: response.json().merchant.id as string, apiKey: response.json().apiKey as string };
  }

  const list = (key: string) => app.inject({ method: 'GET', url: '/v1/api-keys', headers: { authorization: `Bearer ${key}` } });
  const create = (key: string, name: string) => app.inject({
    method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${key}` }, payload: { name },
  });
  const revoke = (key: string, id: string) => app.inject({
    method: 'DELETE', url: `/v1/api-keys/${id}`, headers: { authorization: `Bearer ${key}` },
  });

  beforeEach(async () => {
    db = await createDatabase();
    app = await buildApp({ db });
    const merchant = await createMerchant('Key Store', 'keys@example.com', '0xdddddddddddddddddddddddddddddddddddddddd');
    merchantId = merchant.merchantId;
    apiKey = merchant.apiKey;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('creates a key, shows the secret once, and the new key authenticates', async () => {
    const created = await create(apiKey, 'CI deploy');
    expect(created.statusCode).toBe(201);
    const secret = created.json().secret as string;
    expect(secret.startsWith('tf_live_')).toBe(true);
    expect(created.json().apiKey).toMatchObject({ name: 'CI deploy' });
    expect(created.json().warning).toContain('shown again');

    // The freshly created key works for authenticated merchant requests.
    const authenticated = await app.inject({
      method: 'GET', url: '/v1/api-keys', headers: { authorization: `Bearer ${secret}` },
    });
    expect(authenticated.statusCode).toBe(200);

    // Later reads never return the secret or the stored hash.
    const later = await list(apiKey);
    expect(later.statusCode).toBe(200);
    expect(later.body).not.toContain(secret);
    expect(later.body).not.toContain('key_hash');
    expect(later.body).not.toContain('keyHash');
    const createdEntry = later.json().apiKeys.find((key: { name: string }) => key.name === 'CI deploy');
    expect(createdEntry).toMatchObject({ status: 'active' });
    // The new key was used above, so its last-used timestamp is tracked and returned.
    expect(typeof createdEntry.lastUsedAt).toBe('string');
  });

  it('stores only a peppered hash, never the plaintext secret', async () => {
    const created = await create(apiKey, 'Hashed key');
    const secret = created.json().secret as string;
    const rows = await db.query<Record<string, unknown>>('SELECT * FROM api_keys', []);
    const stored = rows.rows.find((row) => row.name === 'Hashed key');
    expect(stored).toBeTruthy();
    expect(stored?.key_hash).toBe(hashApiKey(secret));
    expect(stored?.key_hash).not.toBe(secret);
    // No column in the row holds the raw secret.
    expect(Object.values(stored ?? {}).map((value) => String(value))).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it('revokes a key and immediately invalidates it', async () => {
    const created = await create(apiKey, 'Temporary');
    const secret = created.json().secret as string;
    const keyId = created.json().apiKey.id as string;
    expect((await app.inject({ method: 'GET', url: '/v1/api-keys', headers: { authorization: `Bearer ${secret}` } })).statusCode).toBe(200);

    const revoked = await revoke(apiKey, keyId);
    expect(revoked.statusCode).toBe(204);

    // The revoked key is rejected immediately and cannot be used to create or revoke.
    for (const request of [
      { method: 'GET', url: '/v1/api-keys' },
      { method: 'POST', url: '/v1/api-keys', payload: { name: 'Another' } },
      { method: 'DELETE', url: `/v1/api-keys/${keyId}` },
    ]) {
      const rejected = await app.inject({ ...request, headers: { authorization: `Bearer ${secret}` } } as never);
      expect(rejected.statusCode).toBe(401);
    }

    const after = await list(apiKey);
    expect(after.json().apiKeys.find((key: { id: string }) => key.id === keyId)).toMatchObject({ status: 'revoked' });
    expect(after.body).not.toContain(secret);
  });

  it('keeps keys isolated per merchant and never lets one revoke another', async () => {
    const other = await createMerchant('Other Store', 'other-keys@example.com', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    const otherCreated = await create(other.apiKey, 'Other key');
    const otherKeyId = otherCreated.json().apiKey.id as string;
    const otherSecret = otherCreated.json().secret as string;

    const mine = await create(apiKey, 'My key');
    const myKeyId = mine.json().apiKey.id as string;

    // My list contains only my keys.
    const myList = await list(apiKey);
    expect(myList.json().apiKeys.map((key: { name: string }) => key.name)).toEqual(['Primary', 'My key']);
    expect(myList.body).not.toContain(otherKeyId);
    expect(myList.body).not.toContain(otherSecret);

    // Revoking another merchant's key is a 404 and does not affect it.
    const crossRevoke = await revoke(apiKey, otherKeyId);
    expect(crossRevoke.statusCode).toBe(404);
    expect((await app.inject({
      method: 'GET', url: '/v1/api-keys', headers: { authorization: `Bearer ${otherSecret}` },
    })).statusCode).toBe(200);

    // My own revoke still works and does not touch the other merchant's key.
    expect((await revoke(apiKey, myKeyId)).statusCode).toBe(204);
    const otherList = await list(other.apiKey);
    expect(otherList.json().apiKeys.find((key: { id: string }) => key.id === otherKeyId)).toMatchObject({ status: 'active' });
    expect(otherList.json().apiKeys.find((key: { id: string }) => key.id === myKeyId)).toBeUndefined();
    void merchantId;
  });

  it('rejects unauthenticated requests and handles missing or invalid input', async () => {
    for (const request of [
      { method: 'GET', url: '/v1/api-keys' },
      { method: 'POST', url: '/v1/api-keys', payload: { name: 'Nope' } },
      { method: 'DELETE', url: '/v1/api-keys/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    ]) {
      const anonymous = await app.inject(request as never);
      expect(anonymous.statusCode).toBe(401);
    }

    const unknown = await revoke(apiKey, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('not_found');

    const missingName = await app.inject({
      method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${apiKey}` }, payload: {},
    });
    expect(missingName.statusCode).toBe(400);
    const blankName = await create(apiKey, '   ');
    expect(blankName.statusCode).toBe(400);
    const longName = await create(apiKey, 'x'.repeat(81));
    expect(longName.statusCode).toBe(400);
  });
});
