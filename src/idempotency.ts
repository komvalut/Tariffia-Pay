import type { PoolClient } from 'pg';
import type { Database } from './db.js';
import { HttpError } from './errors.js';
import { hashRequest } from './security.js';

export async function runIdempotently<T>(input: {
  db: Database;
  scope: string;
  key: string;
  request: unknown;
  work: (client: PoolClient) => Promise<{ status: number; body: T }>;
}): Promise<{ status: number; body: T; replayed: boolean }> {
  if (input.key.length < 8 || input.key.length > 128) {
    throw new HttpError(400, 'Idempotency-Key must be 8-128 characters', 'invalid_idempotency_key');
  }
  const requestHash = hashRequest(input.request);
  return input.db.transaction(async (client) => {
    const existing = await client.query(
      'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2 FOR UPDATE',
      [input.scope, input.key],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        throw new HttpError(409, 'Idempotency key was already used with a different request', 'idempotency_conflict');
      }
      if (existing.rows[0].response_status == null || existing.rows[0].response_body == null) {
        throw new HttpError(409, 'A request with this idempotency key is still processing', 'idempotency_in_progress');
      }
      return { status: existing.rows[0].response_status as number, body: existing.rows[0].response_body as T, replayed: true };
    }

    await client.query(
      'INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [input.scope, input.key, requestHash],
    );
    const claimed = await client.query(
      'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2 FOR UPDATE',
      [input.scope, input.key],
    );
    const row = claimed.rows[0];
    if (!row || row.request_hash !== requestHash) {
      throw new HttpError(409, 'Idempotency key was already used with a different request', 'idempotency_conflict');
    }
    if (row.response_status != null && row.response_body != null) {
      return { status: row.response_status as number, body: row.response_body as T, replayed: true };
    }

    const result = await input.work(client);
    await client.query(
      'UPDATE idempotency_keys SET response_status = $3, response_body = $4::jsonb WHERE scope = $1 AND key = $2',
      [input.scope, input.key, result.status, JSON.stringify(result.body)],
    );
    return { ...result, replayed: false };
  });
}
