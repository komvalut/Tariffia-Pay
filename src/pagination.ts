import { HttpError } from './errors.js';

/**
 * One shared pagination contract for merchant list endpoints.
 *
 * Query parameters: `limit` (integer, default 50, 1..100) and `offset` (integer, default 0, >= 0).
 * Invalid values are rejected with `400 invalid_pagination` rather than silently clamped. Responses
 * carry a `pagination` object with `{ limit, offset, count, hasMore }` alongside their existing
 * resource fields.
 */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const MAX_PAGE_OFFSET = 1_000_000;

export type PaginationQuery = { limit?: unknown; offset?: unknown };
export type Pagination = { limit: number; offset: number; count: number; hasMore: boolean };
export type PagedResult<T> = { items: T[]; pagination: Pagination; hasMore: boolean };

function invalidPagination(message: string): HttpError {
  return new HttpError(400, message, 'invalid_pagination');
}

function parseInteger(value: unknown, field: 'limit' | 'offset'): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw invalidPagination(`The "${field}" query parameter must be an integer.`);
  }
  const text = String(value);
  // Rejects negatives, decimals, signs, whitespace and non-numeric input in one place.
  if (!/^\d+$/.test(text)) {
    throw invalidPagination(`The "${field}" query parameter must be a non-negative integer.`);
  }
  return Number(text);
}

export function parsePagination(query: PaginationQuery = {}): { limit: number; offset: number } {
  const limit = parseInteger(query.limit, 'limit') ?? DEFAULT_PAGE_LIMIT;
  const offset = parseInteger(query.offset, 'offset') ?? 0;
  if (limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw invalidPagination(`The "limit" query parameter must be between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  if (offset < 0 || offset > MAX_PAGE_OFFSET) {
    throw invalidPagination(`The "offset" query parameter must be between 0 and ${MAX_PAGE_OFFSET}.`);
  }
  return { limit, offset };
}

/**
 * Slices a `limit + 1` result set into the page items and metadata. Callers query `limit + 1`
 * rows so `hasMore` is known without a second count query.
 */
export function paginate<T>(rows: T[], limit: number, offset: number): PagedResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, pagination: { limit, offset, count: items.length, hasMore }, hasMore };
}
