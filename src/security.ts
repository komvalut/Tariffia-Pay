import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export function newId(): string {
  return randomUUID();
}

export function createApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `tf_live_${randomBytes(32).toString('base64url')}`;
  return { raw, prefix: raw.slice(0, 15), hash: hashApiKey(raw) };
}

export function hashApiKey(raw: string): string {
  return createHmac('sha256', config.API_KEY_PEPPER).update(raw).digest('hex');
}

export function hashRequest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const sorted = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${sorted.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function secretEquals(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
