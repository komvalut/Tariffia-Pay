import type { FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import type { Database } from './db.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { hashApiKey, secretEquals } from './security.js';
import {
  effectiveScopes,
  merchantScopeForRoute,
  scopeSatisfied,
  type MerchantScope,
} from './scopes.js';

export type MerchantContext = { id: string; name: string; wallet_address: string };

export function parseBody<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), 'validation_error');
  }
  return result.data;
}

export function requireAdmin(request: FastifyRequest): void {
  const adminKey = request.headers['x-admin-api-key'];
  if (typeof adminKey !== 'string' || !secretEquals(adminKey, config.ADMIN_API_KEY)) {
    throw new HttpError(401, 'Admin API key required', 'unauthorized');
  }
}

export async function requireMerchant(
  request: FastifyRequest,
  db: Database,
  requiredScope?: MerchantScope,
): Promise<MerchantContext> {
  const authorization = request.headers.authorization;
  const raw = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  if (!raw) throw new HttpError(401, 'Merchant API key required', 'unauthorized');
  const result = await db.query<MerchantContext & { key_id: string; scopes: string[] }>(
    `SELECT m.id, m.name, m.wallet_address, k.id AS key_id, k.scopes
       FROM api_keys k JOIN merchants m ON m.id = k.merchant_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND m.status = 'active'`,
    [hashApiKey(raw)],
  );
  const merchant = result.rows[0];
  if (!merchant) throw new HttpError(401, 'Invalid merchant API key', 'unauthorized');
  // Explicit per-route scope wins; otherwise the central policy maps the route template + method.
  const scope = requiredScope
    ?? merchantScopeForRoute(request.method, request.routeOptions?.url ?? request.url);
  if (scope && !scopeSatisfied(effectiveScopes(merchant.scopes), scope)) {
    throw new HttpError(403, `This API key is missing the required scope: ${scope}`, 'insufficient_scope');
  }
  void db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [merchant.key_id]).catch(() => undefined);
  return merchant;
}
