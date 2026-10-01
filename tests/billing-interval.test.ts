import { describe, expect, it } from 'vitest';
import { addBillingInterval } from '../src/services/billing-interval.js';

describe('subscription billing intervals', () => {
  it('adds daily and weekly intervals in UTC', () => {
    const start = new Date('2025-12-29T18:30:15.250Z');
    expect(addBillingInterval(start, 'DAY', 1).toISOString()).toBe('2025-12-30T18:30:15.250Z');
    expect(addBillingInterval(start, 'DAY', 14).toISOString()).toBe('2026-01-12T18:30:15.250Z');
    expect(addBillingInterval(start, 'WEEK', 2).toISOString()).toBe('2026-01-12T18:30:15.250Z');
  });

  it('clamps month-end and leap-day billing dates instead of overflowing', () => {
    expect(addBillingInterval(new Date('2025-01-31T12:00:00Z'), 'MONTH', 1).toISOString())
      .toBe('2025-02-28T12:00:00.000Z');
    expect(addBillingInterval(new Date('2024-02-29T12:00:00Z'), 'YEAR', 1).toISOString())
      .toBe('2025-02-28T12:00:00.000Z');
  });

  it('rejects invalid intervals and counts', () => {
    expect(() => addBillingInterval(new Date(), 'MONTH', 0)).toThrow('Invalid billing interval');
    expect(() => addBillingInterval(new Date(Number.NaN), 'DAY', 1)).toThrow('Invalid billing interval');
  });
});
