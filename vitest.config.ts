import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The integration suites build an in-memory database and app per test; the whole suite
    // runs in parallel, so give tests and hooks headroom to avoid load-induced flakiness.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
