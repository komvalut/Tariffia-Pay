import { describe, expect, it } from 'vitest';
import { createApiKey, hashApiKey, hashRequest, secretEquals } from '../src/security.js';

describe('security helpers', () => {
  it('creates a one-time API key whose stored representation is only a hash', () => {
    const key = createApiKey();
    expect(key.raw.startsWith('tf_live_')).toBe(true);
    expect(key.prefix).toBe(key.raw.slice(0, 15));
    expect(key.hash).not.toContain(key.raw);
    expect(hashApiKey(key.raw)).toBe(key.hash);
  });

  it('hashes object requests independent of property order', () => {
    expect(hashRequest({ amount: '1.00', description: 'Coffee' }))
      .toBe(hashRequest({ description: 'Coffee', amount: '1.00' }));
  });

  it('compares admin secrets without accepting different values', () => {
    expect(secretEquals('same-secret', 'same-secret')).toBe(true);
    expect(secretEquals('wrong', 'same-secret')).toBe(false);
  });
});
