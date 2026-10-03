# Production Deployment

Tariffia Pay runs as an API/dashboard container and a PostgreSQL container. Compose also runs a one-shot migration job before starting the API. The API container serves `/admin`, `/merchant`, checkout pages, dashboards, and `/v1` APIs; no separate web server is required.

## Requirements

- Docker Engine and Docker Compose v2.
- A public HTTPS reverse proxy for the API. The Compose port is bound to `127.0.0.1` by default so the application does not expose plain HTTP directly to the public network.
- A trusted HTTPS Base JSON-RPC endpoint.
- Persistent host storage for the named PostgreSQL volume.

## Configure and Start

Copy `.env.production.example` to `.env.production`. Generate independent secrets with `openssl rand -hex 32` and assign separate values to `POSTGRES_PASSWORD`, `ADMIN_API_KEY`, `API_KEY_PEPPER`, and `WEBHOOK_ENCRYPTION_KEY`. Use distinct random values; the production validator rejects defaults, placeholders, short/reused keys, and non-HTTPS public/RPC URLs. Keep `.env.production` out of version control and restrict its filesystem permissions.

Set `PUBLIC_BASE_URL` to the externally reachable HTTPS origin, with no path, query string, or credentials. Keep `BIND_ADDRESS=127.0.0.1` when the TLS reverse proxy runs on the Docker host. If a proxy runs in another container, bind only to a private interface, limit access with firewall/network policy, and set `TRUST_PROXY` to that proxy's exact IP or constrained CIDR list. Do not set blanket `TRUST_PROXY=true`.

Lightning is registered but disabled by default. To enable the LND REST provider, configure `LIGHTNING_PROVIDER_TYPE=lnd-rest`, a private `LIGHTNING_PROVIDER_URL`, a least-privilege hex macaroon, a separate stable `LIGHTNING_PROVIDER_IDEMPOTENCY_SECRET`, and then `LIGHTNING_ADAPTER_ENABLED=true`. Keep all credentials in `.env.production`/a secret manager, never in API fields. Remote production providers require HTTPS. See `PAYMENT_ADAPTERS.md` for the provider permissions and supported LND operations. No live node connectivity is assumed by the automated test suite.

The Compose database URL uses `POSTGRES_PASSWORD` and the internal `db` service name. Use URL-safe hex for that password. `DATABASE_URL` in the production environment file is for running the Node process directly on the host; Compose overrides it for container networking.

```sh
cp .env.production.example .env.production
# Edit .env.production and populate the independent secret values and public URLs.
chmod 600 .env.production
docker compose --env-file .env.production up --build -d
docker compose --env-file .env.production ps
curl --fail http://127.0.0.1:8080/health
curl --fail http://127.0.0.1:8080/ready
```

Configure the reverse proxy to terminate TLS and forward to the host-bound API port. Preserve the client's address only through a trusted proxy configuration. Dashboards and hosted checkout are served by the same API origin, so CORS remains disabled.

## Services and Probes

- `db`: PostgreSQL 16 with SCRAM host authentication, persistent `tariffia-postgres` volume, restart policy, and `pg_isready` healthcheck. It is not published on a host port.
- `migrate`: one-shot `node dist/migrate.js` job. It waits for PostgreSQL readiness and must complete successfully before the API starts. It receives only `NODE_ENV` and `DATABASE_URL`.
- `api`: non-root Node container, read-only root filesystem, dropped Linux capabilities, no-new-privileges, restart policy, and Compose healthcheck against `/ready`.
- `/health`: existing API/database health endpoint, retained for compatibility.
- `/ready`: readiness probe that returns `200` only while the database is reachable; otherwise returns a bounded `503` response.

The API also runs the migration runner before listening, making direct non-Compose startup safe. Migration application is serialized with a PostgreSQL advisory transaction lock and tracked in `schema_migrations`; applied files are skipped on subsequent starts. Migration files are forward-only. Back up before deploying a version containing a new migration.

Useful operations:

```sh
docker compose --env-file .env.production logs --tail=100 db migrate api
docker compose --env-file .env.production run --rm migrate
npm run migrate
npm run migrate:production
```

`npm run migrate` is for a host development environment with `DATABASE_URL` set. `npm run migrate:production` runs the built migration entrypoint. Neither command starts the API.

## Backups and Restore

The database holds payment/ledger records and encrypted webhook signing secrets. Create restricted custom-format dumps, encrypt them before retaining or transferring them off-host, and periodically verify restores. Preserve `WEBHOOK_ENCRYPTION_KEY` separately: without the matching key, stored webhook secrets cannot be decrypted after restore.

`scripts/db-backup.mjs` wraps the stock PostgreSQL 16 client tools (`pg_dump`/`pg_restore`) with the safety rails below. It adds no npm dependencies. Run it from the repository root on the host (or any host with the PostgreSQL 16 client installed and network access to the database) with `DATABASE_URL` in the environment. The npm aliases are `npm run backup`, `npm run backup:verify`, and `npm run backup:restore`.

Safety properties of the tooling:

- `DATABASE_URL` is read from the environment only, never from the command line, and is never printed. Connection details reach `pg_dump`/`pg_restore` through `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`, so neither the URL nor the password appears in argv or process listings.
- Credentials are redacted from all command output and errors; only `user@host:port/database` is shown.
- Runtime/cache table data is excluded from dumps and the exclusion is verified after every backup. The ephemeral tables are `merchant_request_counters` (per-minute rate-limit counters) and `payment_scan_cursors` (block-scan position). Both rebuild automatically; their table definitions are still backed up.
- Dumps default to `backups/tariffia-<UTC>.dump` with `umask 077`. The `backups/` directory and `*.dump` / `*.dump.age` files are gitignored and must never be committed.
- `restore` refuses to run without `--yes`, and in production also requires `RESTORE_CONFIRM=<database name>`.

### Create a backup

```sh
umask 077
DATABASE_URL=... npm run backup -- --output backups/tariffia.dump
```

The command writes a custom-format archive, then immediately lists it with `pg_restore --list` to confirm the expected application tables are present and that no runtime/cache table data was included. To also capture the runtime tables (for diagnostics only), pass `--include-runtime-data`.

Encrypt before it leaves the host; this example streams a fresh dump through `age` so plaintext is not retained. `age` and a configured recipient are required for this example; use an equivalent approved encryption tool if preferred.

```sh
umask 077
set -o pipefail
docker compose --env-file .env.production exec -T db \
  pg_dump -U tariffia -d tariffia --format=custom --no-owner --no-privileges \
    --exclude-table-data public.merchant_request_counters \
    --exclude-table-data public.payment_scan_cursors \
  | age -r "$BACKUP_AGE_RECIPIENT" > "backups/tariffia-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
```

### Check backup integrity

Run this before every restore and on a schedule against retained archives (it needs no database connection; it only reads the archive):

```sh
DATABASE_URL=... npm run backup:verify -- backups/tariffia-20260101T000000Z.dump
```

A non-zero exit status or `Integrity check: FAILED` means the archive is truncated/corrupt, is missing an expected application table, or contains runtime/cache data. Do not restore a failed archive.

### Restore procedure

Restore during a maintenance window. Stop application writers first, verify the archive, recreate an empty database, restore inside a single transaction, then restart and confirm readiness and recent records.

```sh
# 1. Stop writers so no new data lands during the restore.
docker compose --env-file .env.production stop api migrate

# 2. Verify the archive before touching the database.
DATABASE_URL=... npm run backup:verify -- backups/tariffia-20260101T000000Z.dump

# 3. Recreate an empty database.
docker compose --env-file .env.production exec -T db dropdb -U tariffia --if-exists --force tariffia
docker compose --env-file .env.production exec -T db createdb -U tariffia tariffia

# 4. Restore the decrypted dump (single transaction; aborts cleanly on error).
set -o pipefail
age -d -i "$BACKUP_AGE_IDENTITY" backups/tariffia.dump.age \
  | docker compose --env-file .env.production exec -T db \
      pg_restore -U tariffia -d tariffia --clean --if-exists --no-owner --no-privileges --single-transaction

# 5. Restart and verify.
docker compose --env-file .env.production up -d
curl --fail http://127.0.0.1:8080/ready
```

When running `npm run backup:restore` directly against a host `DATABASE_URL`, pass `--yes` after verifying the target, and in production set `RESTORE_CONFIRM` to the database name:

```sh
NODE_ENV=production RESTORE_CONFIRM=tariffia DATABASE_URL=... \
  npm run backup:restore -- --yes backups/tariffia.dump
```

After restoring, confirm `/ready`, inspect API logs, and verify recent payments, credit accounts, webhook settings, and schema migration versions. Runtime/cache tables are intentionally empty after restore and repopulate on their own. Test restore procedures periodically; do not treat a successful dump command as a verified backup.


## Upgrades

1. Back up the PostgreSQL database and protect the webhook encryption key.
2. Fetch the intended release/tag and inspect its migration files and release notes.
3. Build and start with `docker compose --env-file .env.production up --build -d`.
4. Compose waits for the migration job to exit successfully before starting the API. The API startup migration is an idempotent second check.
5. Verify `docker compose ps`, `/health`, `/ready`, dashboard access, and API logs.

Do not remove the named PostgreSQL volume during upgrades. There is no automatic down-migration; restoring the pre-upgrade backup is the rollback procedure.

## Deployment Limitations

The included rate limiter uses per-process memory. Multiple API replicas do not share rate-limit counters; use an edge/shared rate limiter if scaling horizontally. Payment detection and webhook delivery are in-process workers, so deploy a single API replica unless worker coordination is added. Docker Compose provides single-node PostgreSQL persistence, not high availability. Database backups, off-host retention, TLS reverse proxying, firewall policy, and secret-manager integration remain operator responsibilities.
