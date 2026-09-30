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

Create restricted custom-format dumps outside the database container, encrypt them before retaining or transferring them off-host, and periodically verify restores. The database contains payment/ledger records and encrypted webhook signing secrets. Preserve `WEBHOOK_ENCRYPTION_KEY` separately: without the matching key, stored webhook secrets cannot be decrypted after restore.

For example, stream a custom-format dump through `age` so plaintext is not written to disk. `age` and a configured recipient are required for this example; use an equivalent approved encryption tool if preferred.

```sh
umask 077
set -o pipefail
docker compose --env-file .env.production exec -T db \
  pg_dump -U tariffia -d tariffia --format=custom \
  | age -r "$BACKUP_AGE_RECIPIENT" > "tariffia-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
```

Restore by stopping application writers, recreating the database, and streaming a verified encrypted dump through decryption into PostgreSQL:

```sh
docker compose --env-file .env.production stop api migrate
docker compose --env-file .env.production exec -T db dropdb -U tariffia --if-exists --force tariffia
docker compose --env-file .env.production exec -T db createdb -U tariffia tariffia
set -o pipefail
age -d -i "$BACKUP_AGE_IDENTITY" tariffia-backup.dump.age \
  | docker compose --env-file .env.production exec -T db \
      pg_restore -U tariffia -d tariffia --no-owner
docker compose --env-file .env.production up -d
```

After restoring, confirm `/ready`, inspect API logs, and verify recent payments, credit accounts, webhook settings, and schema migration versions. Test restore procedures periodically; do not treat a successful dump command as a verified backup.

## Upgrades

1. Back up the PostgreSQL database and protect the webhook encryption key.
2. Fetch the intended release/tag and inspect its migration files and release notes.
3. Build and start with `docker compose --env-file .env.production up --build -d`.
4. Compose waits for the migration job to exit successfully before starting the API. The API startup migration is an idempotent second check.
5. Verify `docker compose ps`, `/health`, `/ready`, dashboard access, and API logs.

Do not remove the named PostgreSQL volume during upgrades. There is no automatic down-migration; restoring the pre-upgrade backup is the rollback procedure.

## Deployment Limitations

The included rate limiter uses per-process memory. Multiple API replicas do not share rate-limit counters; use an edge/shared rate limiter if scaling horizontally. Payment detection and webhook delivery are in-process workers, so deploy a single API replica unless worker coordination is added. Docker Compose provides single-node PostgreSQL persistence, not high availability. Database backups, off-host retention, TLS reverse proxying, firewall policy, and secret-manager integration remain operator responsibilities.
