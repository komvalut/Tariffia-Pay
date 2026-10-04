# Tariffia Pay — Local Quickstart

Get from a clean checkout to a visible, end-to-end payment flow locally — no
Docker required, no VPS, no SSH, no blockchain and no real money.

- [A. Zero-setup verification (fastest)](#a-zero-setup-verification-fastest)
- [B. Hands-on local server](#b-hands-on-local-server)
- [C. Docker (optional)](#c-docker-optional)
- [Simulated vs real locally](#simulated-vs-real-locally)

---

## A. Zero-setup verification (fastest)

The quickest way to see the **complete mock payment flow** is the existing
production smoke test. It needs only Node.js 20+ and installed dependencies;
there is no database, no Docker and no network access.

```sh
npm install        # if you have not already
npm test -- tests/production-smoke.test.ts
```

What it does: it runs the real Fastify routes over an in-memory PostgreSQL
(`pg-mem`) with a deterministic **mock USDC adapter**, covering:

- merchant creation and a one-time merchant API key
- customer creation
- order + payment creation (PENDING) and the hosted checkout link/QR
- reading payment status
- payment confirmation through the existing verification path (mock adapter)
- merchant isolation (one merchant cannot see another's records)
- revenue summary, per-merchant usage, and the audit log
- `/health`, `/ready` and `/openapi.json`

No real funds, no Base RPC, no testnet. This is the safest first step.

---

## B. Hands-on local server

Run the actual HTTP server plus a real PostgreSQL so you can drive the flow with
`curl`, the SDK, or the dashboards.

### Requirements

- **Node.js 20+** and `npm install`
- **PostgreSQL 16** reachable over TCP (a local install or any database you
  control; it does **not** have to be Docker)
- A `.env` file (see below)

### Steps

```sh
# 1. Configuration
cp .env.example .env
# Edit .env:
#   - set DATABASE_URL to your local PostgreSQL
#   - set WEBHOOK_ENCRYPTION_KEY to 64 hex characters, e.g.:
#       openssl rand -hex 32
#   - set ADMIN_API_KEY and API_KEY_PEPPER to any long random strings
#     (development mode accepts simple local values; production validates strictly)

# 2. Apply migrations
npm run migrate

# 3. Run the API (hot reload) on http://localhost:8080
npm run dev
# or, for the built server:
# npm run build && npm start
```

Confirm it is up:

```sh
curl --fail http://localhost:8080/health          # liveness
curl --fail http://localhost:8080/ready           # readiness (database reachable)
curl --fail http://localhost:8080/openapi.json    # OpenAPI document
open http://localhost:8080/docs                   # dependency-free API viewer
open http://localhost:8080/admin                  # admin dashboard
open http://localhost:8080/merchant               # merchant dashboard
```

### One-command demo

With the server running and `.env` loaded, the demo script walks the merchant
flow against the live server (it prints the base URL and never prints secrets):

```sh
# The script reads credentials from the environment.
ADMIN_API_KEY=... \
BASE_URL=http://localhost:8080 \
node scripts/smoke-demo.mjs
```

See [scripts/smoke-demo.mjs](../scripts/smoke-demo.mjs) for exactly what it does.
It uses only existing Tariffia endpoints and refuses to run against a
production-looking URL.

---

## C. Docker (optional)

Docker Compose is a convenience, not a requirement. If you have Docker Engine
and Docker Compose v2, the repository ships a `docker-compose.yml` that runs
PostgreSQL 16, a one-shot migration job, and the API with healthchecks.

```sh
cp .env.example .env
# Replace all placeholder secrets; WEBHOOK_ENCRYPTION_KEY must be 64 hex chars.
docker compose up --build
```

The API listens on `http://localhost:8080`. For a full production deployment,
security hardening, backups, upgrades and operations, see
[`../PRODUCTION.md`](../PRODUCTION.md).

---

## Simulated vs real locally

Locally you can exercise the **entire application logic**. Only the final
on-chain settlement check is simulated when you use the mock adapter (the
zero-setup smoke test).

**SIMULATED (in the zero-setup smoke test):**

- Payment verification (`verifyTransaction`)
- USDC settlement
- Blockchain confirmation

**REAL locally (actual code paths you exercise):**

- Fastify HTTP routes
- Authentication (admin key and merchant API-key scopes)
- Merchant isolation (tenant scoping)
- Orders and payments
- Hosted checkout page and QR
- The append-only ledger
- Invoices and receipts
- Revenue summary and history
- Per-merchant usage and rate limits
- Append-only audit log
- Webhook delivery logic (signed, retried)
- Credit engine, AI reseller, SMS/OTP and subscriptions logic

### Important limitation when running the live server

`npm run dev` / `npm start` wire the **real Base USDC adapter**, which verifies
transactions against a live Base RPC. There is deliberately **no HTTP endpoint
that fakes a payment confirmation** — the mock adapter is only injected inside
the automated tests. That means:

- Against a live local server you can create a merchant, customer, order,
  payment and checkout link, and read their status (PENDING) — everything except
  reaching CONFIRMED without a real transfer.
- To reach CONFIRMED locally with no funds and no chain, use the zero-setup
  smoke test above (option A), which swaps in the mock adapter.
- To reach CONFIRMED against a live server you would need to send a real USDC
  transfer (testnet or mainnet) and submit its transaction hash — that is a
  separate, deliberate step and is not part of this quickstart.

Do not treat a PENDING payment or a mock confirmation as a real settlement.
