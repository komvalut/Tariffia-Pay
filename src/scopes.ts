/**
 * Merchant API key scopes.
 *
 * Keys are always stored as peppered HMAC hashes; scopes are non-secret authorization labels.
 * A scope is `<area>:<action>`, where action is `read` or `write`. A `write` scope implies the
 * matching `read` scope. Keys issued before scope enforcement existed carry exactly the legacy
 * default set and are treated as full access so existing integrations keep working.
 */

export const MERCHANT_SCOPES = [
  'orders:read', 'orders:write',
  'payments:read', 'payments:write',
  'customers:read', 'customers:write',
  'credits:read', 'credits:write',
  'ai:read', 'ai:write',
  'sms:read', 'sms:write',
  'webhooks:read', 'webhooks:write',
  'subscriptions:read', 'subscriptions:write',
  'revenue:read',
  'settings:read', 'settings:write',
  'notifications:read', 'notifications:write',
  'usage:read',
  'api-keys:read', 'api-keys:write',
  'documents:read',
  'ledger:read',
  'audit:read',
  'dashboard:read',
] as const;

export type MerchantScope = (typeof MERCHANT_SCOPES)[number];

const MERCHANT_SCOPE_SET: ReadonlySet<string> = new Set(MERCHANT_SCOPES);

/** The scopes a newly created key receives when the caller does not request a narrower set. */
export const DEFAULT_MERCHANT_SCOPES: MerchantScope[] = [...MERCHANT_SCOPES];

/** The scopes carried by keys minted before scope enforcement; grandfathered as full access. */
export const LEGACY_DEFAULT_SCOPES = ['payments:write', 'orders:write', 'customers:write', 'ledger:read'];

// Areas that are read-only: every method maps to `<area>:read`.
const READ_ONLY_AREAS: ReadonlySet<string> = new Set(['revenue', 'usage', 'documents', 'ledger', 'audit', 'dashboard']);
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export function isMerchantScope(value: unknown): value is MerchantScope {
  return typeof value === 'string' && MERCHANT_SCOPE_SET.has(value);
}

export function isLegacyDefaultScopes(scopes: readonly string[]): boolean {
  return scopes.length === LEGACY_DEFAULT_SCOPES.length
    && LEGACY_DEFAULT_SCOPES.every((scope) => scopes.includes(scope));
}

/**
 * Expands a stored scope list into the effective grant. Legacy keys (exactly the pre-scope
 * default set) are treated as having every scope, preserving existing integrations.
 */
export function effectiveScopes(scopes: readonly string[] | null | undefined): Set<string> {
  const stored = Array.isArray(scopes) ? scopes : [];
  if (isLegacyDefaultScopes(stored)) return new Set(MERCHANT_SCOPES);
  return new Set(stored);
}

/** A `write` scope implies its `read` counterpart; `*` would grant everything (not issued by default). */
export function scopeSatisfied(granted: ReadonlySet<string>, required: string): boolean {
  if (granted.has('*') || granted.has(required)) return true;
  if (required.endsWith(':read')) return granted.has(`${required.slice(0, -':read'.length)}:write`);
  return false;
}

/**
 * Central scope policy for merchant routes. It maps the registered route template and HTTP method
 * to the scope a key must hold. `undefined` means the route is not a scoped merchant route.
 */
export function merchantScopeForRoute(method: string, routeUrl: string): MerchantScope | undefined {
  const path = (routeUrl.split('?')[0] ?? '').trim();
  let area: string | undefined;
  if (path.startsWith('/v1/orders')) area = 'orders';
  else if (path.startsWith('/v1/payments') || path.startsWith('/v1/payment-links') || path.startsWith('/v1/transactions')) area = 'payments';
  else if (path.startsWith('/v1/customers')) area = 'customers';
  else if (path.startsWith('/v1/credits')) area = 'credits';
  else if (path.startsWith('/v1/ai')) area = 'ai';
  else if (path.startsWith('/v1/sms')) area = 'sms';
  else if (path.startsWith('/v1/webhooks')) area = 'webhooks';
  else if (path.startsWith('/v1/subscription-plans') || path.startsWith('/v1/subscriptions')) area = 'subscriptions';
  else if (path.startsWith('/v1/revenue')) area = 'revenue';
  else if (path.startsWith('/v1/settings')) area = 'settings';
  else if (path.startsWith('/v1/notification-preferences')) area = 'notifications';
  else if (path.startsWith('/v1/usage')) area = 'usage';
  else if (path.startsWith('/v1/api-keys')) area = 'api-keys';
  else if (path.startsWith('/v1/invoices') || path.startsWith('/v1/receipts')) area = 'documents';
  else if (path.startsWith('/v1/ledger')) area = 'ledger';
  else if (path.startsWith('/v1/audit-log')) area = 'audit';
  else if (path.startsWith('/v1/dashboard')) area = 'dashboard';
  if (!area) return undefined;
  const action = READ_ONLY_AREAS.has(area) || READ_METHODS.has(method.toUpperCase()) ? 'read' : 'write';
  const scope = `${area}:${action}`;
  return MERCHANT_SCOPE_SET.has(scope) ? (scope as MerchantScope) : undefined;
}

/** Formats the scope catalogue for documentation output. */
export function describeMerchantScopes(): Array<{ name: MerchantScope; description: string }> {
  return MERCHANT_SCOPES.map((name) => ({
    name,
    description: name.endsWith(':write')
      ? `Write access to the ${name.slice(0, -':write'.length)} area (also grants read).`
      : `Read access to the ${name.slice(0, -':read'.length)} area.`,
  }));
}
