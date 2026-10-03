import { readFileSync } from 'node:fs';

let version = '0.1.0';
try {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof pkg.version === 'string' && pkg.version.trim()) version = pkg.version;
} catch {
  // The package manifest is not present in every runtime layout; keep the fallback.
}

export const serviceVersion = version;
