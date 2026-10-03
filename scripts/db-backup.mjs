#!/usr/bin/env node
// Tariffia Pay database backup/restore helper.
//
// Uses only the PostgreSQL client tooling that ships with PostgreSQL 16
// (pg_dump / pg_restore) plus the Node standard library. No npm dependencies.
//
// Safety:
//   - DATABASE_URL is read from the environment only, never from the command
//     line and never printed. Connection details are passed to the PostgreSQL
//     tools through PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE so the URL and
//     password never appear in argv or process listings.
//   - Runtime/cache table data is excluded from dumps by default and the
//     exclusion is verified after every backup.
//   - Restore refuses to run without --yes, and in production also requires
//     RESTORE_CONFIRM to equal the target database name.

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const BACKUP_DIR = 'backups';
export const CUSTOM_ARCHIVE_MAGIC = 'PGDMP';

// Ephemeral runtime state that is rebuilt automatically and must not be
// restored: fixed-window rate-limit counters and the block-scan cursor.
// The table definitions are still backed up; only their data is skipped.
export const RUNTIME_DATA_TABLES = ['merchant_request_counters', 'payment_scan_cursors'];

// Every application table that a complete backup must contain. Derived from
// migrations/*.sql (schema_migrations is created by the migration runner).
export const EXPECTED_TABLES = [
  'schema_migrations',
  'merchants',
  'api_keys',
  'customers',
  'orders',
  'payments',
  'idempotency_keys',
  'ledger_entries',
  'payment_scan_cursors',
  'webhook_endpoints',
  'webhook_events',
  'webhook_deliveries',
  'webhook_delivery_attempts',
  'credit_settings',
  'credit_accounts',
  'credit_transactions',
  'credit_topups',
  'ai_providers',
  'ai_models',
  'ai_usage_records',
  'invoices',
  'receipts',
  'subscription_plans',
  'subscriptions',
  'subscription_billing_cycles',
  'subscription_billing_attempts',
  'ai_provider_requests',
  'sms_providers',
  'sms_services',
  'sms_provider_requests',
  'sms_usage_records',
  'merchant_usage_limits',
  'merchant_request_counters',
  'payment_links',
  'merchant_settings',
  'merchant_notification_preferences',
];

export function parseDatabaseUrl(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('DATABASE_URL is required.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!database) {
    throw new Error('DATABASE_URL must include a database name.');
  }
  return {
    host: url.hostname || 'localhost',
    port: url.port ? Number(url.port) : 5432,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database,
  };
}

export function resolveDatabaseUrl(env = process.env) {
  return parseDatabaseUrl(env.DATABASE_URL);
}

// Human-readable target that never contains the password.
export function describeTarget(parsed) {
  const user = parsed.user ? `${parsed.user}@` : '';
  return `${user}${parsed.host}:${parsed.port}/${parsed.database}`;
}

export function redactDatabaseUrl(value) {
  try {
    return describeTarget(parseDatabaseUrl(value));
  } catch {
    return 'postgres://[redacted]';
  }
}

// Builds a clean environment for the PostgreSQL tools. The password travels
// only through PGPASSWORD, never through argv or any printed output.
export function connectionEnv(parsed, base = process.env) {
  const env = {
    ...base,
    PGHOST: parsed.host,
    PGPORT: String(parsed.port),
    PGDATABASE: parsed.database,
  };
  if (parsed.user) env.PGUSER = parsed.user;
  if (parsed.password) env.PGPASSWORD = parsed.password;
  return env;
}

// Removes credential material from arbitrary text before it is written to a
// terminal or log. Used for PostgreSQL tool output and unexpected errors.
export function sanitize(text, parsed, env = process.env) {
  if (text == null) return '';
  let out = String(text);
  if (parsed && parsed.password) out = out.split(parsed.password).join('[redacted]');
  if (env.DATABASE_URL) out = out.split(env.DATABASE_URL).join('[redacted]');
  return out.replace(/postgres(?:ql)?:\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, 'postgres://[redacted]@');
}

export function buildDumpArgs({ output, includeRuntimeData = false }) {
  const args = ['--format=custom', '--no-owner', '--no-privileges', '--file', output];
  if (!includeRuntimeData) {
    for (const table of RUNTIME_DATA_TABLES) {
      args.push('--exclude-table-data', `public.${table}`);
    }
  }
  return args;
}

export function buildRestoreArgs({ input }) {
  return ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', input];
}

export function isCustomFormatArchive(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, CUSTOM_ARCHIVE_MAGIC.length).toString('latin1') === CUSTOM_ARCHIVE_MAGIC;
}

// Parses `pg_restore --list` output. Entries look like:
//   216; 1259 16385 TABLE public merchants tariffia
//   3600; 0 0 TABLE DATA public merchant_request_counters tariffia
export function parseArchiveList(text) {
  const tables = new Set();
  const tableData = new Set();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    const dataMatch = line.match(/^\d+;\s+\d+\s+\d+\s+TABLE DATA\s+(\S+)\s+(\S+)/);
    if (dataMatch) {
      tableData.add(`${dataMatch[1]}.${dataMatch[2]}`);
      continue;
    }
    const tableMatch = line.match(/^\d+;\s+\d+\s+\d+\s+TABLE\s+(?!DATA\b)(\S+)\s+(\S+)/);
    if (tableMatch) {
      tables.add(`${tableMatch[1]}.${tableMatch[2]}`);
    }
  }
  return { tables, tableData };
}

// Integrity check run against a dump's archive listing. It confirms the
// expected application tables are present and that no runtime/cache table
// data leaked into the backup.
export function verifyArchiveList(text, options = {}) {
  const runtimeTables = options.runtimeDataTables ?? RUNTIME_DATA_TABLES;
  const expectedTables = options.expectedTables ?? EXPECTED_TABLES;
  const { tables, tableData } = parseArchiveList(text);
  const expectedQualified = expectedTables.map((name) => `public.${name}`);
  const missingTables = expectedQualified.filter((name) => !tables.has(name));
  const leakedRuntimeData = runtimeTables.filter((name) => tableData.has(`public.${name}`));
  const presentTableNames = [...tables].map((name) => name.split('.').pop());
  const unexpectedTables = presentTableNames.filter((name) => !expectedTables.includes(name));
  return {
    ok: tables.size > 0 && missingTables.length === 0 && leakedRuntimeData.length === 0,
    tableCount: tables.size,
    runtimeDataExcluded: leakedRuntimeData.length === 0,
    leakedRuntimeData,
    missingTables,
    unexpectedTables,
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

async function readMagic(file) {
  const buffer = await readFile(file);
  return { buffer, magic: buffer.subarray(0, CUSTOM_ARCHIVE_MAGIC.length).toString('latin1') };
}

async function runPg(command, args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { env, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? '',
    };
  }
}

async function runCommand(command, args, env, parsed, verbose) {
  const result = await runPg(command, args, env);
  if (result.code !== 0) {
    const detail = sanitize(`${result.stderr}\n${result.stdout}`.trim(), parsed);
    throw new Error(`${command} failed (exit ${result.code}).${detail && verbose ? `\n${detail}` : ''}`);
  }
  return result;
}

async function latestBackup() {
  const entries = await readdir(BACKUP_DIR).catch(() => []);
  const dumps = entries.filter((name) => name.endsWith('.dump')).sort();
  if (!dumps.length) {
    throw new Error(`No *.dump files found in ${BACKUP_DIR}/.`);
  }
  return path.join(BACKUP_DIR, dumps[dumps.length - 1]);
}

export async function commandBackup(args, env = process.env) {
  process.umask(0o077);
  const parsed = resolveDatabaseUrl(env);
  const output = args.output ? path.resolve(args.output) : path.resolve(BACKUP_DIR, `tariffia-${timestamp()}.dump`);
  if (!args.force) {
    const exists = await stat(output).then(() => true, () => false);
    if (exists) throw new Error(`Refusing to overwrite existing file ${output}. Use --force to replace it.`);
  }
  await mkdir(path.dirname(output), { recursive: true });
  const pgEnv = connectionEnv(parsed, env);
  await runCommand('pg_dump', buildDumpArgs({ output, includeRuntimeData: args.includeRuntimeData }), pgEnv, parsed, args.verbose);

  const { buffer, magic } = await readMagic(output);
  if (magic !== CUSTOM_ARCHIVE_MAGIC) {
    throw new Error('Backup did not produce a PostgreSQL custom-format archive.');
  }
  const listing = await runPg('pg_restore', ['--list', output], { ...pgEnv, PGPASSWORD: undefined });
  if (listing.code !== 0) {
    throw new Error(`Backup created but integrity listing failed (exit ${listing.code}).`);
  }
  const verification = verifyArchiveList(listing.stdout);
  if (!verification.ok) {
    throw new Error(`Backup integrity check failed: ${JSON.stringify(verification)}`);
  }
  process.stdout.write(`Backup written: ${output}\n`);
  process.stdout.write(`Target: ${describeTarget(parsed)} (password not shown)\n`);
  process.stdout.write(`Size: ${buffer.length} bytes\n`);
  process.stdout.write(`Tables: ${verification.tableCount}; runtime/cache data excluded: ${verification.runtimeDataExcluded}\n`);
  return verification;
}

export async function commandVerify(args, env = process.env) {
  const input = args.input ? path.resolve(args.input) : await latestBackup();
  const { magic } = await readMagic(input);
  if (magic !== CUSTOM_ARCHIVE_MAGIC) {
    throw new Error(`${input} is not a PostgreSQL custom-format archive.`);
  }
  const parsed = env.DATABASE_URL ? resolveDatabaseUrl(env) : undefined;
  const pgEnv = parsed ? connectionEnv(parsed, env) : { ...env };
  const listing = await runPg('pg_restore', ['--list', input], { ...pgEnv, PGPASSWORD: undefined });
  if (listing.code !== 0) {
    throw new Error(`Integrity check failed: unable to read archive listing (exit ${listing.code}).`);
  }
  const verification = verifyArchiveList(listing.stdout);
  process.stdout.write(`Archive: ${input}\n`);
  process.stdout.write(`Tables: ${verification.tableCount}\n`);
  process.stdout.write(`Runtime/cache data excluded: ${verification.runtimeDataExcluded}\n`);
  if (verification.missingTables.length) process.stdout.write(`Missing tables: ${verification.missingTables.join(', ')}\n`);
  if (verification.unexpectedTables.length) process.stdout.write(`Unexpected tables: ${verification.unexpectedTables.join(', ')}\n`);
  process.stdout.write(verification.ok ? 'Integrity check: OK\n' : 'Integrity check: FAILED\n');
  if (!verification.ok) throw new Error('Backup integrity check failed.');
  return verification;
}

export async function commandRestore(args, env = process.env) {
  const input = args.input ? path.resolve(args.input) : await latestBackup();
  const parsed = resolveDatabaseUrl(env);
  if (!args.yes) {
    throw new Error(`Restore of ${describeTarget(parsed)} aborted. Re-run with --yes to confirm.`);
  }
  if (env.NODE_ENV === 'production' && env.RESTORE_CONFIRM !== parsed.database) {
    throw new Error(`Production restore requires RESTORE_CONFIRM=${parsed.database} in the environment.`);
  }
  const { magic } = await readMagic(input);
  if (magic !== CUSTOM_ARCHIVE_MAGIC) {
    throw new Error(`${input} is not a PostgreSQL custom-format archive.`);
  }
  await runCommand('pg_restore', buildRestoreArgs({ input }), connectionEnv(parsed, env), parsed, args.verbose);
  process.stdout.write(`Restore complete into ${describeTarget(parsed)} (password not shown)\n`);
}

const USAGE = `Usage: node scripts/db-backup.mjs <command> [options]

Commands:
  backup [output]     Create a custom-format dump (default: backups/tariffia-<utc>.dump).
                      --output <path>         explicit output path (same as positional)
                      --force                 overwrite an existing output file
                      --include-runtime-data  also dump rate-limit counters and scan cursors
  verify [input]      Check archive integrity and that runtime/cache data is excluded
                      (default: newest backups/*.dump)
  restore [input]     Restore an archive into DATABASE_URL
                      --input <path>          explicit archive path (same as positional)
                      --yes                   required confirmation
                      --verbose               show sanitized PostgreSQL errors

DATABASE_URL must be set in the environment (never passed on the command line).
It is never printed; into a production restore, set RESTORE_CONFIRM=<database>.`;

function parseArgs(argv) {
  const args = { command: argv[0] };
  const rest = argv.slice(1);
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--force') args.force = true;
    else if (token === '--yes') args.yes = true;
    else if (token === '--verbose') args.verbose = true;
    else if (token === '--include-runtime-data') args.includeRuntimeData = true;
    else if (token === '--output') args.output = rest[++i];
    else if (token === '--input') args.input = rest[++i];
    else if (token.startsWith('--')) throw new Error(`Unknown option: ${token}`);
    else positional.push(token);
  }
  if (args.command === 'verify' || args.command === 'restore') args.input = args.input ?? positional[0];
  else if (args.output === undefined && positional[0]) args.output = positional[0];
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === 'help' || args.command === '--help' || args.command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.command === 'backup') await commandBackup(args);
  else if (args.command === 'verify') await commandVerify(args);
  else if (args.command === 'restore') await commandRestore(args);
  else throw new Error(`Unknown command: ${args.command}\n\n${USAGE}`);
}

let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  invokedDirectly = false;
}

if (invokedDirectly) {
  main().catch((error) => {
    const env = process.env;
    const parsed = env.DATABASE_URL ? (() => { try { return resolveDatabaseUrl(env); } catch { return undefined; } })() : undefined;
    process.stderr.write(`Tariffia Pay database tooling error: ${sanitize(error.message, parsed, env)}\n`);
    process.exitCode = 1;
  });
}
