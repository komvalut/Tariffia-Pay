import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../scripts/smoke-demo.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts/smoke-demo.mjs');

function runScript(env: Record<string, string>) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, BASE_URL: '', ADMIN_API_KEY: '', MERCHANT_API_KEY: '', ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? '') };
  }
}

describe('smoke-demo script safety', () => {
  it('accepts local base URLs and returns a normalized origin', () => {
    expect(validateConfig({ baseUrl: 'http://localhost:8080/', adminApiKey: 'admin' })).toBe('http://localhost:8080');
    expect(validateConfig({ baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin' })).toBe('http://127.0.0.1:8080');
    expect(validateConfig({ baseUrl: 'http://api.local:8080', adminApiKey: 'admin' })).toBe('http://api.local:8080');
  });

  it('refuses missing, malformed, credential-bearing and production-like URLs', () => {
    expect(() => validateConfig({ baseUrl: '', adminApiKey: 'admin' })).toThrow(/BASE_URL/);
    expect(() => validateConfig({ baseUrl: 'not a url', adminApiKey: 'admin' })).toThrow(/valid URL/);
    expect(() => validateConfig({ baseUrl: 'http://user:pass@localhost:8080', adminApiKey: 'admin' })).toThrow(/embedded credentials/);
    expect(() => validateConfig({ baseUrl: 'https://pay.example.com', adminApiKey: 'admin' })).toThrow(/refusing/);
    expect(() => validateConfig({ baseUrl: 'https://api.tariffia.com', adminApiKey: 'admin' })).toThrow(/refusing/);
    expect(() => validateConfig({ baseUrl: 'http://192.168.1.10:8080', adminApiKey: 'admin' })).toThrow(/refusing/);
  });

  it('requires an admin API key', () => {
    expect(() => validateConfig({ baseUrl: 'http://localhost:8080', adminApiKey: '' })).toThrow(/ADMIN_API_KEY/);
  });

  it('is valid JavaScript and its --help/exec path fails safely without configuration', () => {
    expect(() => execFileSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' })).not.toThrow();
    const result = runScript({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke-demo:');
    expect(result.stderr).toContain('BASE_URL');
  });

  it('never prints a merchant secret when refusing a production-like URL', () => {
    const result = runScript({
      BASE_URL: 'https://pay.example.com',
      ADMIN_API_KEY: 'dev-admin-key-change-this-before-deploy',
      MERCHANT_API_KEY: 'tf_live_should_never_appear',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing');
    expect(result.stderr).not.toContain('dev-admin-key-change-this-before-deploy');
    expect(result.stderr).not.toContain('tf_live_should_never_appear');
    expect(result.stdout).not.toContain('tf_live_should_never_appear');
  });
});
