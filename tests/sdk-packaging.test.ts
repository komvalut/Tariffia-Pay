import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkDir = path.join(repoRoot, 'sdk');

type PackFile = { path: string };
type PackResult = { name: string; version: string; files: PackFile[]; entryCount: number };

// The SDK builds on pack via `prepack`, so a clean checkout still produces a
// complete tarball. This test verifies two things without publishing:
//   1. `prepack`/`prepare` are configured to build the SDK, and
//   2. a real `npm pack --dry-run` of the built SDK contains the expected files
//      and nothing sensitive.
// To stay deterministic under the parallel suite, the build is run explicitly
// once here and packing uses --ignore-scripts (so no heavy tsc runs mid-suite).

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: sdkDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
});

function packDryRun(): PackResult {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: sdkDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(output) as PackResult[];
  return parsed[0]!;
}

describe('SDK packaging readiness', () => {
  const result = packDryRun();
  const paths = result.files.map((file) => file.path);

  it('is configured to build before packing or publishing', () => {
    const pkg = JSON.parse(readFileSync(path.join(sdkDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.prepack).toMatch(/build/);
    expect(pkg.scripts?.prepare).toMatch(/build/);
  });

  it('packs the published name and version', () => {
    expect(result.name).toBe('@tariffia/pay');
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('includes the built SDK entry points required by "exports"', () => {
    const required = [
      'dist/server.js',
      'dist/server.d.ts',
      'dist/browser.js',
      'dist/browser.d.ts',
      'package.json',
      'README.md',
    ];
    for (const file of required) {
      expect(paths, `package must include ${file}`).toContain(file);
    }
  });

  it('never ships secrets, environment files, tests or backups', () => {
    for (const file of paths) {
      expect(file.startsWith('.env'), `${file} must not be packed`).toBe(false);
      expect(file.startsWith('tests/'), `${file} must not be packed`).toBe(false);
      expect(file.includes('node_modules')).toBe(false);
      expect(file.endsWith('.dump') || file.endsWith('.dump.age')).toBe(false);
    }
    expect(paths.every((file) => /^(dist\/|examples\/|README\.md$|package\.json$)/.test(file))).toBe(true);
  });
});
