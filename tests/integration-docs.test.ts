import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/openapi.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationPath = path.join(repoRoot, 'docs/INTEGRATION.md');
const examplePath = path.join(repoRoot, 'sdk/examples/merchant-flow.mjs');

async function readRepoFile(relative: string) {
  return readFile(path.join(repoRoot, relative), 'utf8');
}

// Documented endpoint paths in the guide look like `/v1/...` or `/p/:paymentId`.
// Normalize the guide's `:param` form to the OpenAPI `{param}` form.
function normalizeDocPath(docPath: string): string {
  return docPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

describe('integration guide and example accuracy', () => {
  it('the example is valid JavaScript and imports only existing SDK entry points', async () => {
    expect(() => execFileSync(process.execPath, ['--check', examplePath], { encoding: 'utf8' })).not.toThrow();
    const source = await readFile(examplePath, 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      // Relative/other specifiers are not expected in SDK examples.
      expect(['node:crypto', '@tariffia/pay/server', '@tariffia/pay/browser']).toContain(specifier);
    }
    // It documents that no confirmation/blockchain happens here.
    expect(source).toMatch(/NO payment confirmation/i);
  });

  it('the example never hard-codes a credential and reads keys from the environment', async () => {
    const source = await readFile(examplePath, 'utf8');
    expect(source).toContain('process.env.TARIFFIA_API_KEY');
    // No literal API keys, webhook secrets or private keys.
    expect(source).not.toMatch(/tf_live_[A-Za-z0-9_-]{8,}/);
    expect(source).not.toMatch(/whsec[_-][A-Za-z0-9]{8,}/);
    expect(source).not.toMatch(/-----BEGIN/);
  });

  it('the guide documents only endpoints that exist in the API', async () => {
    const guide = await readFile(integrationPath, 'utf8');
    const documented = new Set(Object.keys(openApiDocument.paths));

    // Collect `/v1/...`, `/openapi.json`, `/docs`, `/p/...` style paths from
    // inline code spans and fenced examples.
    const candidates = [...guide.matchAll(/`(\/(?:v1\/|p\/|r\/|openapi\.json|docs|health|ready)[^`\s()]*)`/g)]
      .map((match) => match[1]!
        // Strip the method-agnostic query strings and trailing punctuation.
        .replace(/[.,;:]$/, '')
        .split('?')[0]!);

    const missing = [...new Set(candidates)]
      .filter((candidate) => !candidate.endsWith('.pdf'))
      .map((candidate) => candidate.replace(/\/$/, ''))
      .filter((candidate) => candidate.length > 0)
      .filter((candidate) => !documented.has(normalizeDocPath(candidate)));

    expect(missing, `Guide references unknown paths: ${missing.join(', ')}`).toEqual([]);
  });

  it('the guide and README link to the integration material', async () => {
    const readme = await readRepoFile('README.md');
    expect(readme).toContain('docs/INTEGRATION.md');
    const guide = await readFile(integrationPath, 'utf8');
    for (const link of ['QUICKSTART.md', 'PRODUCTION.md', 'sdk/README.md', 'merchant-flow.mjs']) {
      expect(guide, `guide should reference ${link}`).toContain(link);
    }
  });
});
