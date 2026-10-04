import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildDumpArgs,
  buildRestoreArgs,
  connectionEnv,
  describeTarget,
  EXPECTED_TABLES,
  isCustomFormatArchive,
  parseArchiveList,
  parseDatabaseUrl,
  redactDatabaseUrl,
  resolveDatabaseUrl,
  RUNTIME_DATA_TABLES,
  sanitize,
  verifyArchiveList,
} from '../scripts/db-backup.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts/db-backup.mjs');
const databaseUrl = 'postgres://tariffia:sup3r-secret-value@db.internal:5432/tariffia';

function archiveListing({ includeRuntimeData = false, dropTable, extraTable }: {
  includeRuntimeData?: boolean; dropTable?: string; extraTable?: string;
} = {}) {
  const lines = [';', '; Archive created at 2026-01-01 00:00:00 UTC', ';'];
  let oid = 100;
  for (const table of EXPECTED_TABLES) {
    if (table === dropTable) continue;
    lines.push(`${oid}; 1259 ${oid} TABLE public ${table} tariffia`);
    if (includeRuntimeData || !RUNTIME_DATA_TABLES.includes(table)) {
      lines.push(`${oid + 5000}; 0 0 TABLE DATA public ${table} tariffia`);
    }
    oid += 1;
  }
  if (extraTable) {
    lines.push(`${oid}; 1259 ${oid} TABLE public ${extraTable} tariffia`);
  }
  return lines.join('\n');
}

async function readRepoFile(relative: string) {
  return readFile(path.join(repoRoot, relative), 'utf8');
}

describe('database backup URL handling', () => {
  it('parses DATABASE_URL and never surfaces the password', () => {
    const parsed = parseDatabaseUrl(databaseUrl);
    expect(parsed).toMatchObject({ host: 'db.internal', port: 5432, user: 'tariffia', database: 'tariffia' });
    expect(parsed.password).toBe('sup3r-secret-value');
    const described = describeTarget(parsed);
    expect(described).toBe('tariffia@db.internal:5432/tariffia');
    expect(described).not.toContain('sup3r-secret-value');
    expect(redactDatabaseUrl(databaseUrl)).toBe(described);
    expect(redactDatabaseUrl('not-a-url')).toBe('postgres://[redacted]');
  });

  it('decodes url-encoded credentials and defaults the port', () => {
    const parsed = parseDatabaseUrl('postgresql://us%40er:p%40ss%2Fword@localhost/mydb');
    expect(parsed).toMatchObject({ host: 'localhost', port: 5432, user: 'us@er', password: 'p@ss/word', database: 'mydb' });
  });

  it('rejects missing, malformed and non-postgres URLs', () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/required/);
    expect(() => parseDatabaseUrl('http://example.com/db')).toThrow(/postgres/);
    expect(() => parseDatabaseUrl('postgres://host/')).toThrow(/database name/);
  });

  it('passes the password to PostgreSQL tools only through PGPASSWORD', () => {
    const parsed = parseDatabaseUrl(databaseUrl);
    const env = connectionEnv(parsed, { PATH: '/usr/bin' });
    expect(env).toMatchObject({ PGHOST: 'db.internal', PGPORT: '5432', PGDATABASE: 'tariffia', PGUSER: 'tariffia', PGPASSWORD: 'sup3r-secret-value' });
    for (const args of [buildDumpArgs({ output: 'backups/x.dump' }), buildRestoreArgs({ input: 'backups/x.dump' })]) {
      expect(args.join(' ')).not.toContain('sup3r-secret-value');
      expect(args.join(' ')).not.toContain('DATABASE_URL');
      expect(args.join(' ')).not.toContain('postgres://');
    }
  });

  it('redacts credentials from arbitrary output', () => {
    const parsed = parseDatabaseUrl(databaseUrl);
    const noisy = sanitize(`pg_dump failed: could not connect to ${databaseUrl} (password sup3r-secret-value)`, parsed);
    expect(noisy).not.toContain('sup3r-secret-value');
    expect(noisy).not.toContain(databaseUrl);
    const embedded = sanitize('contact postgres://bob:hunter2@host:5432/db', undefined, {});
    expect(embedded).toContain('postgres://[redacted]@');
    expect(embedded).not.toContain('hunter2');
  });

  it('does not over-redact unrelated text for short passwords', () => {
    const parsed = parseDatabaseUrl('postgres://user:p@db:5432/tariffia');
    // A one-character password must not turn every occurrence of that letter into "[redacted]".
    const message = sanitize('No *.dump files found in backups/.', parsed, { DATABASE_URL: 'postgres://user:p@db:5432/tariffia' });
    expect(message).toBe('No *.dump files found in backups/.');
    expect(message).not.toContain('[redacted]');
    // The full connection URL is still redacted when present.
    expect(sanitize('connect postgres://user:p@db:5432/tariffia now', parsed, { DATABASE_URL: 'postgres://user:p@db:5432/tariffia' }))
      .not.toContain('user:p@');
  });
});

describe('database backup archive options and integrity checks', () => {
  it('excludes runtime/cache table data by default and can include it explicitly', () => {
    const args = buildDumpArgs({ output: 'backups/x.dump' });
    expect(args).toContain('--format=custom');
    expect(args).toContain('--no-owner');
    expect(args).toContain('--no-privileges');
    for (const table of RUNTIME_DATA_TABLES) {
      expect(args).toContain(`public.${table}`);
    }
    expect(args.filter((value) => value === '--exclude-table-data')).toHaveLength(RUNTIME_DATA_TABLES.length);
    const included = buildDumpArgs({ output: 'backups/x.dump', includeRuntimeData: true });
    expect(included).not.toContain('--exclude-table-data');
  });

  it('restores inside a single transaction without re-running destructive cleanups twice', () => {
    const args = buildRestoreArgs({ input: 'backups/x.dump' });
    expect(args).toEqual(expect.arrayContaining(['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', 'backups/x.dump']));
  });

  it('detects the PostgreSQL custom-format magic', () => {
    expect(isCustomFormatArchive(Buffer.from('PGDMP\x01\x0e\x00'))).toBe(true);
    expect(isCustomFormatArchive(Buffer.from('plain text dump'))).toBe(false);
    expect(isCustomFormatArchive(undefined as unknown as Buffer)).toBe(false);
  });

  it('parses table and table-data entries from pg_restore --list output', () => {
    const { tables, tableData } = parseArchiveList(archiveListing());
    expect(tables.has('public.merchants')).toBe(true);
    expect(tableData.has('public.payments')).toBe(true);
    expect(tableData.has('public.ledger_entries')).toBe(true);
    expect(tableData.has('public.merchant_request_counters')).toBe(false);
    expect(tableData.has('public.payment_scan_cursors')).toBe(false);
  });

  it('verifies a clean backup and flags runtime/cache data leaks', () => {
    const clean = verifyArchiveList(archiveListing());
    expect(clean).toMatchObject({ ok: true, runtimeDataExcluded: true, leakedRuntimeData: [] });
    expect(clean.tableCount).toBe(EXPECTED_TABLES.length);

    const leaked = verifyArchiveList(archiveListing({ includeRuntimeData: true }));
    expect(leaked.ok).toBe(false);
    expect(leaked.runtimeDataExcluded).toBe(false);
    expect(leaked.leakedRuntimeData.sort()).toEqual([...RUNTIME_DATA_TABLES].sort());
  });

  it('fails verification when an expected table is missing', () => {
    const result = verifyArchiveList(archiveListing({ dropTable: 'payments' }));
    expect(result.ok).toBe(false);
    expect(result.missingTables).toEqual(['public.payments']);
  });

  it('reports unexpected tables without failing the check', () => {
    const result = verifyArchiveList(archiveListing({ extraTable: 'unknown_cache_table' }));
    expect(result.ok).toBe(true);
    expect(result.unexpectedTables).toEqual(['unknown_cache_table']);
  });
});

describe('database backup tooling safety and documentation', () => {
  it('is valid JavaScript and ships backup/verify/restore commands', () => {
    expect(() => execFileSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' })).not.toThrow();
    const help = execFileSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
    expect(help).toContain('backup [output]');
    expect(help).toContain('verify [input]');
    expect(help).toContain('restore [input]');
  });

  it('wires the documented npm aliases and gitignores backup artefacts', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json'));
    expect(pkg.scripts.backup).toContain('scripts/db-backup.mjs backup');
    expect(pkg.scripts['backup:verify']).toContain('scripts/db-backup.mjs verify');
    expect(pkg.scripts['backup:restore']).toContain('scripts/db-backup.mjs restore');
    const gitignore = await readRepoFile('.gitignore');
    for (const entry of ['backups/', '*.dump', '*.dump.age']) {
      expect(gitignore).toContain(entry);
    }
  });

  it('documents backup, integrity check and restore procedures without credentials', async () => {
    const production = await readRepoFile('PRODUCTION.md');
    const readme = await readRepoFile('README.md');
    for (const command of ['npm run backup', 'npm run backup:verify', 'npm run backup:restore']) {
      expect(production, command).toContain(command);
    }
    for (const tool of ['pg_dump', 'pg_restore']) {
      expect(production, tool).toContain(tool);
    }
    for (const table of RUNTIME_DATA_TABLES) {
      expect(production, table).toContain(table);
    }
    for (const step of ['stop api migrate', 'dropdb', 'createdb', '--single-transaction', '--yes', 'RESTORE_CONFIRM']) {
      expect(production, step).toContain(step);
    }
    expect(production).toMatch(/never printed|never from the command line/i);
    expect(readme).toContain('npm run backup');
    // Documentation must not embed real credentials or the password placeholder value.
    expect(production).not.toMatch(/postgres(?:ql)?:\/\/[^/\s:@]+:[^@\s/]+@/);
    expect(production).not.toContain('sup3r-secret-value');
  });
});

const fakePgDump = `#!/bin/sh
: "\${CAPTURE_DIR:?}"
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--file" ]; then out="$a"; fi
  prev="$a"
done
printf '%s\\n' "$@" > "$CAPTURE_DIR/dump-args.txt"
printf '%s' "$PGPASSWORD" > "$CAPTURE_DIR/dump-password.txt"
printf 'PGDMPfakecustomarchive-bytes' > "$out"
`;

const fakePgRestore = `#!/bin/sh
: "\${CAPTURE_DIR:?}"
if [ "$1" = "--list" ]; then
  cat "$CAPTURE_DIR/listing.txt"
else
  printf '%s\\n' "$@" > "$CAPTURE_DIR/restore-args.txt"
fi
`;

const failingPgDump = `#!/bin/sh
echo "pg_dump: error: connection to \\"$DATABASE_URL\\" failed for password $PGPASSWORD" >&2
exit 1
`;

async function makeTools(dir: string, dumpScript: string) {
  const bin = path.join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'pg_dump'), dumpScript);
  await writeFile(path.join(bin, 'pg_restore'), fakePgRestore);
  await chmod(path.join(bin, 'pg_dump'), 0o755);
  await chmod(path.join(bin, 'pg_restore'), 0o755);
  return bin;
}

function cliEnv(dir: string, bin: string) {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    CAPTURE_DIR: dir,
    NODE_ENV: 'development',
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  } as NodeJS.ProcessEnv;
}

describe('database backup CLI end-to-end (fake PostgreSQL tools)', () => {
  it('backs up, verifies and restores without printing the password', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tariffia-backup-'));
    try {
      const bin = await makeTools(dir, fakePgDump);
      await writeFile(path.join(dir, 'listing.txt'), archiveListing());
      const env = cliEnv(dir, bin);
      const dumpPath = path.join(dir, 'backup.dump');

      const backup = execFileSync(process.execPath, [scriptPath, 'backup', '--output', dumpPath], { env, encoding: 'utf8' });
      expect(backup).toContain('runtime/cache data excluded: true');
      expect(backup).not.toContain('sup3r-secret-value');
      expect(await readFile(path.join(dir, 'dump-args.txt'), 'utf8')).toContain('public.merchant_request_counters');
      expect(await readFile(path.join(dir, 'dump-password.txt'), 'utf8')).toBe('sup3r-secret-value');

      const verify = execFileSync(process.execPath, [scriptPath, 'verify', dumpPath], { env, encoding: 'utf8' });
      expect(verify).toContain('Integrity check: OK');
      expect(verify).not.toContain('sup3r-secret-value');

      const restore = execFileSync(process.execPath, [scriptPath, 'restore', '--yes', dumpPath], { env, encoding: 'utf8' });
      expect(restore).not.toContain('sup3r-secret-value');
      expect(await readFile(path.join(dir, 'restore-args.txt'), 'utf8')).toContain('--single-transaction');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to restore without explicit confirmation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tariffia-backup-'));
    try {
      const bin = await makeTools(dir, fakePgDump);
      await writeFile(path.join(dir, 'listing.txt'), archiveListing());
      const dumpPath = path.join(dir, 'backup.dump');
      const env = cliEnv(dir, bin);
      execFileSync(process.execPath, [scriptPath, 'backup', '--output', dumpPath], { env, encoding: 'utf8' });
      let status = 0;
      let stderr = '';
      try {
        execFileSync(process.execPath, [scriptPath, 'restore', dumpPath], { env, encoding: 'utf8' });
      } catch (error) {
        status = (error as { status?: number }).status ?? 1;
        stderr = String((error as { stderr?: Buffer | string }).stderr ?? '');
      }
      expect(status).not.toBe(0);
      expect(stderr).toContain('aborted');
      expect(stderr).not.toContain('sup3r-secret-value');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('redacts credentials from PostgreSQL tool errors', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tariffia-backup-'));
    try {
      const bin = await makeTools(dir, failingPgDump);
      const env = cliEnv(dir, bin);
      let stderr = '';
      try {
        execFileSync(process.execPath, [scriptPath, 'backup', '--verbose', '--output', path.join(dir, 'fail.dump')], { env, encoding: 'utf8' });
      } catch (error) {
        stderr = String((error as { stderr?: Buffer | string }).stderr ?? '');
      }
      expect(stderr).toContain('[redacted]');
      expect(stderr).not.toContain('sup3r-secret-value');
      expect(stderr).not.toContain(databaseUrl);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
