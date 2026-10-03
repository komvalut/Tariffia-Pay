import type { Database } from '../db.js';
import { parsePagination, paginate } from '../pagination.js';
import { newId } from '../security.js';

export type AuditActorType = 'admin' | 'merchant';
export type AuditMetadata = Record<string, unknown>;

export type AuditEntryInput = {
  actorType: AuditActorType;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: AuditMetadata;
};

export type AuditEntry = {
  id: string;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: AuditMetadata;
  createdAt: Date;
};

export type AuditPageQuery = { limit?: unknown; offset?: unknown };
export type AuditFilters = { actorType?: unknown; action?: unknown; resourceType?: unknown };
export type AuditPage = {
  entries: AuditEntry[];
  pagination: { limit: number; offset: number; count: number; hasMore: boolean };
};

// Defense in depth: metadata keys that could carry credentials or secrets are dropped before
// anything is written, and remaining string values are length-bounded. Callers still pass only
// non-sensitive data in the first place.
const SENSITIVE_KEY = /secret|password|passwd|token|credential|api[_-]?key|private|macaroon|otp|authorization|ciphertext|nonce|auth[_-]?tag|signature|hash/i;
const MAX_STRING_LENGTH = 200;
const MAX_ARRAY_LENGTH = 50;
const MAX_DEPTH = 3;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return [];
    return value.slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return undefined;
    return sanitizeObject(value as Record<string, unknown>, depth + 1);
  }
  return String(value).slice(0, MAX_STRING_LENGTH);
}

function sanitizeObject(input: Record<string, unknown>, depth: number): AuditMetadata {
  const clean: AuditMetadata = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key) || value === undefined) continue;
    const sanitized = sanitizeValue(value, depth);
    if (sanitized !== undefined) clean[key] = sanitized;
  }
  return clean;
}

export function sanitizeAuditMetadata(metadata: AuditMetadata | undefined): AuditMetadata {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return sanitizeObject(metadata, 0);
}

function mapRow(row: AuditEntry): AuditEntry {
  let metadata = row.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
  }
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    metadata: metadata ?? {},
    createdAt: row.createdAt,
  };
}

const selectColumns = `id, actor_type AS "actorType", actor_id AS "actorId", action,
  resource_type AS "resourceType", resource_id AS "resourceId", metadata, created_at AS "createdAt"`;

export class AuditLogService {
  constructor(private readonly db: Database) {}

  /** Append-only: the log exposes inserts and reads, never updates or deletes. */
  async record(input: AuditEntryInput): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        newId(),
        input.actorType,
        input.actorId,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        JSON.stringify(sanitizeAuditMetadata(input.metadata)),
      ],
    );
  }

  async listForMerchant(merchantId: string, query: AuditPageQuery = {}): Promise<AuditPage> {
    const { limit, offset } = parsePagination(query);
    const result = await this.db.query<AuditEntry>(
      `SELECT ${selectColumns} FROM audit_log
        WHERE actor_type = 'merchant' AND actor_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [merchantId, limit + 1, offset],
    );
    return this.page(result.rows, limit, offset);
  }

  async listAll(filters: AuditFilters = {}, query: AuditPageQuery = {}): Promise<AuditPage> {
    const { limit, offset } = parsePagination(query);
    const where: string[] = [];
    const values: unknown[] = [];
    const actorType = typeof filters.actorType === 'string' ? filters.actorType.slice(0, 32) : undefined;
    const action = typeof filters.action === 'string' ? filters.action.slice(0, 80) : undefined;
    const resourceType = typeof filters.resourceType === 'string' ? filters.resourceType.slice(0, 80) : undefined;
    if (actorType) { values.push(actorType); where.push(`actor_type = $${values.length}`); }
    if (action) { values.push(action); where.push(`action = $${values.length}`); }
    if (resourceType) { values.push(resourceType); where.push(`resource_type = $${values.length}`); }
    values.push(limit + 1, offset);
    const result = await this.db.query<AuditEntry>(
      `SELECT ${selectColumns} FROM audit_log
        WHERE ${where.length ? where.join(' AND ') : 'TRUE'}
        ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return this.page(result.rows, limit, offset);
  }

  private page(rows: AuditEntry[], limit: number, offset: number): AuditPage {
    const { items, pagination } = paginate(rows, limit, offset);
    return { entries: items.map(mapRow), pagination };
  }
}
