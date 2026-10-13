# Changelog

All notable changes to Tariffia Pay are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

## Status

Tariffia Pay is at approximately **v0.1.0 — pre-1.0 / release candidate**. The
core is feature-complete and well-tested (unit/integration suite plus a
production-style mock payment smoke test).

The opt-in real-PostgreSQL lane has been run against a real engine and passes
6/6 (see [`docs/QUICKSTART.md`](docs/QUICKSTART.md#real-postgresql-validation-optional)).
That run used PostgreSQL 18.6 through a pooled endpoint, so it is evidence that
the migrations and the ledger/audit append-only triggers behave correctly on a
real server, but it is **not** yet evidence for PostgreSQL 16. A run against a
16.x direct endpoint remains a prerequisite for a 1.0 release.

## [Unreleased]

### Added

- Release readiness: SDK packaging now builds automatically on pack/publish
  (`prepack`/`prepare`), a `CHANGELOG.md`, and a `docs/RELEASING.md` release
  procedure. No runtime behavior changes.

### Fixed

- Real-PostgreSQL lane: the cleanup step no longer fails on a real engine.
  Deleting a merchant whose ledger row is immutable by design raised
  `foreign_key_violation` (`23503`); it now tolerates only that code and
  rethrows anything else.

### Changed

- Bumped `source-map-js` to 1.2.2 (dev-only transitive dependency), resolving
  GHSA-68fv-2mgg-jv7q; `npm audit` reports 0 vulnerabilities.
- Documented the real-PostgreSQL validation run and its caveats.

## [0.1.0]

Initial pre-release. Everything below is delivered and covered by the automated
test suite unless noted.

### Payments

- Self-hosted, non-custodial payment core: merchants, customers, orders,
  payments and an append-only ledger.
- Idempotent order and payment-link creation (`Idempotency-Key`).
- Server-authoritative payment verification; the browser never decides status.
- Adapter contract and registry with a Base USDC adapter and a disabled-by-default
  LND REST Lightning provider.
- Unified multi-method hosted checkout, QR codes and managed payment links.

### Billing and money flow

- Invoices and receipts issued atomically on confirmed payments, including
  public receipt links and server-generated PDFs.
- Read-only revenue summary and daily revenue history.
- Internal, non-withdrawable credit engine backed by the immutable ledger.

### Integrations

- Signed, retried merchant webhooks with per-attempt delivery logs.
- AI reseller gateway (OpenAI-compatible) with streaming, tool calls,
  configurable customer pricing and credit settlement.
- SMS/OTP service with pluggable providers, health gating and safe fallback.
- Subscriptions: plans, billing cycles, trials and automatic renewal on the
  same Payment Core.

### Platform and security

- Merchant and admin dashboards (same-origin, no secrets displayed).
- Merchant self-service APIs: customers, orders, transactions, payment links,
  revenue, usage, settings, notifications, API keys, webhooks and an append-only
  audit log.
- Merchant API-key scopes (`<area>:<read|write>`), constant-time authentication,
  tenant isolation, and a hardened production configuration validator.
- Database-level guarantees: ledger immutability and audit append-only triggers,
  serialized forward-only migrations.
- Shared pagination contract across list endpoints.

### SDK

- `@tariffia/pay` TypeScript SDK: `@tariffia/pay/server` (server client with
  typed requests, errors, pagination, idempotency and webhook verification) and
  credential-free `@tariffia/pay/browser` checkout helpers.

### Operations

- Health (`/health`), readiness (`/ready`) and admin operational summary
  (`/v1/health`) probes.
- PostgreSQL backup/restore tooling with integrity checks and secret-safe
  handling.
- Documented deployment, upgrade, rollback, migration and restore-drill
  procedures; optional backup automation examples (cron/systemd).
- GitHub Actions CI (test, typecheck, build, audit, diff-check) — test-only.

### Documentation

- Merchant integration guide (`docs/INTEGRATION.md`), local quickstart
  (`docs/QUICKSTART.md`), API reference (`/openapi.json`, `/docs`), and adapter
  and provider guides.

[Unreleased]: https://github.com/komvalut/Tariffia-Pay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/komvalut/Tariffia-Pay/releases/tag/v0.1.0
