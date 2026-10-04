# Tariffia Pay

Self-hosted, non-custodial merchant payment infrastructure. Merchants accept
crypto payments directly to their own wallet, and every chain-specific behavior
sits behind a payment adapter. USDC on Base is the first adapter; Lightning
(LND REST) is available but disabled by default.

## What it does

- **Payments:** merchants, customers, orders, payments and an immutable ledger,
  with idempotent creation and server-authoritative on-chain verification.
- **Payment methods:** adapter-based (Base USDC, optional Lightning) with a
  unified multi-method hosted checkout, QR codes and payment links.
- **Billing:** invoices and receipts issued automatically on confirmed payments.
- **Webhooks:** signed, retried merchant event delivery.
- **Internal credits:** a non-withdrawable credit engine used for metered usage.
- **AI reseller:** OpenAI-compatible chat (streaming + tool calls) with
  configurable customer pricing and credit settlement.
- **SMS/OTP:** pluggable SMS providers with OTP generation and charging.
- **Subscriptions:** plans, billing cycles and automatic renewal on the same
  Payment Core.
- **Merchant + admin dashboards:** same-origin, no secrets displayed.
- **Self-service APIs:** customers, orders, transactions, payment links,
  revenue, usage, settings, notifications, API keys, webhooks, audit log.
- **Official TypeScript SDK:** server client (`@tariffia/pay/server`) and
  credential-free browser checkout helpers (`@tariffia/pay/browser`).
- **Operations:** health/readiness probes, hardened production config,
  backup/restore tooling, and documented upgrade/rollback procedures.

**Start here:** [`docs/INTEGRATION.md`](docs/INTEGRATION.md) (merchant
integration), [`docs/QUICKSTART.md`](docs/QUICKSTART.md) (run locally),
[`PRODUCTION.md`](PRODUCTION.md) (deploy and operate),
[`docs/RELEASING.md`](docs/RELEASING.md) (release readiness) and
[`CHANGELOG.md`](CHANGELOG.md). API reference:
`GET /openapi.json` and `GET /docs`. Adapters: [`PAYMENT_ADAPTERS.md`](PAYMENT_ADAPTERS.md).
SMS providers: [`SMS_PROVIDERS.md`](SMS_PROVIDERS.md).

## Run locally

For a step-by-step local walkthrough — zero-setup mock verification, a hands-on
no-Docker server, and Docker as an optional convenience — see
[`docs/QUICKSTART.md`](docs/QUICKSTART.md). The zero-setup path needs only Node.js
20+ and dependencies:

```sh
npm test -- tests/production-smoke.test.ts
```

The quickest Docker path is still just:

```sh
cp .env.example .env
# Replace all placeholder secrets. WEBHOOK_ENCRYPTION_KEY must be 64 hex characters.
docker compose up --build
```

The API listens on `http://localhost:8080`. `GET /health` verifies API and database availability; `GET /ready` is the readiness probe. Compose applies migrations in a one-shot service before starting the API, which also checks migrations on startup.

## API documentation

`GET /openapi.json` serves a hand-written OpenAPI 3.0 description of the existing public, merchant and admin API (authentication, orders, payments, payment links, transactions, customers, revenue, credits, AI, SMS/OTP, webhooks, subscriptions, settings, notification preferences, usage, merchant API keys, billing documents, public checkout/receipts, and the operator-only `/v1/admin/*` endpoints under the **Admin** tag), including request/response schemas, authentication requirements and common error responses. `GET /docs` serves a dependency-free viewer for that document. Both are read-only and document existing endpoints only; no credentials, private keys, provider secrets or merchant data are included. No Swagger UI package is added — the built-in viewer reuses the project's plain Fastify stack. Admin endpoints use the `x-admin-api-key` header and are never used by the merchant SDK or from a browser.

## Operations and health

`GET /health` is a public liveness probe (API status, service name, version and uptime). `GET /ready` is a public readiness probe that returns `200` only when the database is reachable and every enabled payment adapter finished initialization, and `503` otherwise (its response stays compatible with the original `{ status, service }` shape and adds a `checks` object). `GET /v1/health` is an admin-only operational summary reporting overall `healthy`/`degraded`/`unavailable` plus API version and uptime, database connectivity and latency, payment adapter status, the Lightning provider status (installed/enabled/non-secret provider type), and AI and SMS provider status (enabled/configured/lifecycle/bounded health). Disabled providers are reported but never degrade the status; an enabled provider that is unconfigured or unhealthy marks the service `degraded`. Health output is safe operational data only — secrets, credentials, keys and provider URLs are never exposed, and credential-bearing URLs or bearer tokens inside provider health messages are redacted. The admin dashboard "System health" page shows this summary.

For development without the API container:

```sh
npm install
npm run dev
```

Start PostgreSQL separately and set `DATABASE_URL` in `.env`.

## Phase 1 API

Create a merchant using the out-of-band admin secret. This secret belongs in server environment configuration, never in a dashboard field:

```sh
curl -X POST http://localhost:8080/v1/admin/merchants \
  -H 'content-type: application/json' \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"name":"Example Store","email":"owner@example.com","walletAddress":"0x1111111111111111111111111111111111111111"}'
```

The response contains a merchant API key once. Store it securely; only its peppered HMAC hash is retained by Tariffia.

Create a customer:

```sh
curl -X POST http://localhost:8080/v1/customers \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -d '{"externalId":"customer-42","email":"buyer@example.com","name":"Buyer"}'
```

Create an order and its payment atomically. Retrying the same request with the same idempotency key returns the original result; reusing the key with a different request returns `409`.

```sh
curl -X POST http://localhost:8080/v1/orders \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -H 'idempotency-key: checkout-order-0001' \
  -d '{"description":"Coffee","amount":"4.50","currency":"USDC"}'
```

Other merchant endpoints:

- `GET /v1/orders`, `GET /v1/orders/:orderId`
- `GET /v1/payments/:paymentId`, `GET /v1/payments/:paymentId/details`
- `GET /v1/transactions`, `GET /v1/transactions/:paymentId`
- `GET /v1/revenue/summary`, `GET /v1/revenue/history`
- `GET /v1/settings`, `PUT /v1/settings`
- `GET /v1/notification-preferences`, `PUT /v1/notification-preferences`
- `POST /v1/payments/:paymentId/verify` with `{ "transactionHash": "0x..." }`
- `POST /v1/payment-links`, `GET /v1/payment-links`, `GET /v1/payment-links/:paymentId`, `PATCH /v1/payment-links/:paymentId`, `DELETE /v1/payment-links/:paymentId`
- `GET /v1/customers`, `GET /v1/customers/:customerId`
- `GET /v1/ledger` (supports `limit`/`offset`)
- `GET /v1/api-keys`, `POST /v1/api-keys`, `DELETE /v1/api-keys/:keyId`
- `POST /v1/credits/topups`, `POST /v1/credits/deductions`
- `GET /v1/credits/:customerId/balance`, `/topups`, `/usage`
- `GET /v1/usage`
- Admin: `GET/PUT /v1/admin/credits/settings`, `GET /v1/admin/credits/accounts`, `GET /v1/admin/credits/transactions`
- AI: `GET /v1/ai/models`, `POST /v1/ai/chat/completions`, `POST /v1/ai/chat/stream`, `POST /v1/ai/usage`, `GET /v1/ai/usage`
- Admin AI: `GET/POST /v1/admin/ai/providers`, `PUT /v1/admin/ai/providers/:providerId`, `GET /v1/admin/ai/models`, `POST /v1/admin/ai/providers/:providerId/models`, `PUT /v1/admin/ai/models/:modelId`, `GET /v1/admin/ai/usage`, `GET /v1/admin/ai/requests`
- SMS: `GET /v1/sms/services`, `POST /v1/sms/send`, `POST /v1/sms/otp`
- Admin SMS: `GET/POST /v1/admin/sms/providers`, `PUT /v1/admin/sms/providers/:providerId`, `POST /v1/admin/sms/providers/:providerId/health`, `GET /v1/admin/sms/services`, `POST /v1/admin/sms/providers/:providerId/services`, `PUT /v1/admin/sms/services/:serviceId`, `GET /v1/admin/sms/requests`, `GET /v1/admin/sms/usage`
- Admin usage: `GET /v1/admin/usage/merchants`, `GET /v1/admin/usage/merchants/:merchantId`, `PUT /v1/admin/usage/merchants/:merchantId`
- Health: `GET /health`, `GET /ready`, `GET /v1/health` (admin), API docs at `GET /openapi.json` and `GET /docs`
- Dashboards: `/admin` and `/merchant`; collection reads are available under `/v1/admin/dashboard/*` and merchant-scoped `/v1/dashboard/*`
- TypeScript SDK: `sdk/` (`@tariffia/pay/server` and credential-free `@tariffia/pay/browser` exports)

### Pagination

Every merchant list endpoint uses one pagination contract: optional `limit` and `offset` query parameters with a default `limit` of 50, a maximum of 100, and an `offset` default of 0. Invalid values (non-integers, `limit` outside 1..100, or a negative `offset`) are rejected with `400 invalid_pagination` — values are never silently clamped. Each page returns a `pagination` object alongside the existing resource field:

```sh
curl 'http://localhost:8080/v1/orders?limit=25&offset=50' -H 'authorization: Bearer tf_live_REPLACE_ME'
# { "orders": [ ... ], "pagination": { "limit": 25, "offset": 50, "count": 25, "hasMore": true } }
```

The contract applies to `GET /v1/orders`, `/v1/customers`, `/v1/payment-links`, `/v1/transactions`, `/v1/ai/usage`, `/v1/webhooks`, `/v1/webhooks/:endpointId/deliveries`, `/v1/credits/:customerId/topups`, `/v1/credits/:customerId/usage`, `/v1/invoices`, `/v1/receipts`, `/v1/ledger`, `/v1/audit-log` and the merchant-scoped `/v1/dashboard/:collection`. Filtering, sorting (newest first), status filters and merchant isolation are unchanged, and only the `pagination` field was added to responses. Small configuration catalogues that are intentionally not paginated — `GET /v1/ai/models`, `GET /v1/sms/services`, `GET /v1/api-keys`, `GET /v1/subscription-plans`, `GET /v1/subscriptions`, `GET /v1/customers/:customerId/subscriptions`, `GET /v1/subscriptions/:subscriptionId/billing-cycles` and `GET /v1/webhooks/:endpointId/deliveries/:deliveryId/attempts` — are documented as such in `GET /openapi.json`. Admin list endpoints follow the same `limit`/`offset` contract.

Create a shareable link from the merchant API:

```sh
curl -X POST http://localhost:8080/v1/payment-links \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -H 'idempotency-key: hosted-checkout-0001' \
  -d '{"description":"Digital item","amount":"12.00","currency":"USDC"}'
```

The response contains `checkoutUrl` and `qrUrl`. The QR encodes that same `checkoutUrl`; it resolves to the server-owned payment ID and canonical payment details. The hosted page is responsive and supports EIP-1193 wallets on Base.

Every merchant-owned read is scoped to the authenticated merchant. The ledger database trigger rejects updates and deletes.

Merchant order visibility is available through `GET /v1/orders` (list, newest first, optional `status` filter, bounded `limit`) and `GET /v1/orders/:orderId` (detail). Each order reports its id, reference, description, amount, currency, order status (`CREATED`, `PENDING`, `PAID`, `FAILED`, `EXPIRED`, `CANCELLED`), the linked payment status, and creation/update timestamps; results are always scoped to the authenticated merchant. The merchant dashboard "Orders" page lists orders with the existing status filter and a **Details** action that opens the full order record. Order creation remains `POST /v1/orders` through the existing Payment Core; no new order system is introduced.

Payment and order status responses are consistent: every payment-facing response (payments, transactions, orders) exposes `status`, `statusLabel`, `createdAt`, `expiresAt`, `detectedAt` and `confirmedAt`, and order responses additionally expose `statusLabel` and `paymentStatusLabel`. The documented payment statuses are `CREATED`, `PENDING`, `DETECTED`, `VERIFYING`, `CONFIRMED`, `FAILED`, `EXPIRED` and `REFUNDED`, labelled Created, Pending, Detected, Verifying, Confirmed, Failed, Expired and Refunded; unknown or legacy values are returned unchanged. The dashboard renders status badges with these labels and shows the timestamp that matters for the current status (confirmed, detected, expiry, or creation) on the Transactions and Orders pages, with a clear empty state when a filter returns no rows.

Merchant customer visibility is available through `GET /v1/customers` (list, newest first, bounded `limit`) and `GET /v1/customers/:customerId` (detail). Each customer reports its id, name/email/external id and metadata when stored, creation time, and basic order/payment counts derived from the existing records. Results are always scoped to the authenticated merchant. Customer creation/update remains `POST /v1/customers`; the merchant dashboard "Customers" page adds a **Details** action next to the existing list and create form. No secrets or credentials are exposed.

`POST /v1/customers` is idempotent and merchant-scoped. Identity is resolved in this order: an explicit `externalId` match wins; otherwise the request matches an existing customer by normalized `email`. Email matching trims surrounding whitespace and lowercases, so `Buyer@Example.com`, `buyer@example.com` and `  BUYER@EXAMPLE.COM  ` resolve to one customer. Repeating the same request returns the existing customer (same id) instead of creating a duplicate — the response is still `201` with the existing record — and only provided fields change with `metadata` shallow-merged. A customer first created by email only is promoted in place (same id) when the same email is later supplied with an `externalId`; a *different* `externalId` with the same email remains a distinct customer so no identities are merged unsafely. Different merchants never share customers even for the same email. No schema change or migration was required.

Merchant transaction visibility is available through `GET /v1/transactions` (list, newest first, with optional `status` and `network` filters and a bounded `limit`) and `GET /v1/transactions/:paymentId` (detail). Each transaction is a merchant-facing view over an existing payment: payment id, order id, description, amount, currency, payment status, network, adapter, transaction id/hash (null until confirmed), and detected/confirmed/expires/created timestamps. Results are always scoped to the authenticated merchant and never expose private keys. The merchant dashboard "Transactions" page lists transactions with status and network filters and a **Details** action.

Payment details are available through `GET /v1/payments/:paymentId/details`, which connects the existing payment and order records with the existing invoice/receipt system: it returns the payment (amount, status, payment method/adapter, network, recipient, transaction id/hash, confirmed time) plus order information and, for a confirmed payment, the issued invoice number and receipt (`publicId`, `publicUrl`, `issuedAt`) or `null` when no documents exist yet. Results are scoped to the authenticated merchant. The dashboard transaction **Details** modal shows the payment and order information with an **Open receipt** link and an authenticated **Download invoice PDF** action when the documents are available. No secrets or private keys are exposed.

A read-only revenue summary is available through `GET /v1/revenue/summary`, with optional `from`/`to` ISO date filters (applied to payment creation time). It returns `totalConfirmed` (sum of confirmed payments, `currency` is the single confirmed currency or `MIXED`, with a `totalsByCurrency` breakdown) and the `confirmedPaymentCount`, `pendingPaymentCount`, `failedPaymentCount` and `expiredPaymentCount` status buckets. It reads existing payment records only, never mutates them, and is scoped to the authenticated merchant. The merchant dashboard Overview shows a **Revenue** section with confirmed revenue and the payment status counts.

Daily confirmed revenue is available through `GET /v1/revenue/history` with optional `from`/`to` ISO date filters (applied to the confirmation time) and a `currency` filter. It uses only `CONFIRMED` payments and returns one entry per UTC day — and per currency when a merchant settles in more than one — with `date`, `currency`, `confirmedAmount` and `confirmedPaymentCount`, oldest first. It is read-only, scoped to the authenticated merchant, and the Overview shows a daily revenue history table beneath the Revenue section.

Merchant self-service settings are available through `GET /v1/settings` and `PUT /v1/settings`, limited to four non-sensitive preferences: display name, support email, default currency and timezone. Display name and support email fall back to the merchant account name/email when unset; default currency and timezone fall back to `USDC` and `UTC`. The request schema is strict, so API keys, wallet addresses, webhook secrets, provider credentials, private keys and status are rejected (400) and never returned. Settings are scoped to the authenticated merchant and stored separately from the merchant account record. The merchant dashboard has a **Settings** page with a simple form and Save button.

Merchant notification preferences are available through `GET /v1/notification-preferences` and `PUT /v1/notification-preferences`, covering `paymentConfirmed`, `paymentFailed`, `paymentExpired`, `creditTopup`, `aiRequestFailed`, `smsRequestFailed` and `webhookFailed`. Every preference defaults to enabled; `PUT` sets all seven explicitly and the strict schema rejects unknown fields. Preferences are scoped to the authenticated merchant and store configuration only — this phase does not send email or SMS, does not change payment/AI/SMS/webhook delivery logic, and stores no secrets. The merchant dashboard has a **Notifications** page with toggle switches and a Save button.

An append-only audit log records important admin and merchant actions: merchant settings and notification-preferences updates, API key creation/revocation, webhook endpoint creation/update/deletion, and payment link enable/disable/deletion. Each entry stores the actor type (`admin`/`merchant`), actor ID, action, resource type, resource ID, timestamp and bounded safe metadata. API keys, secrets, private keys, passwords, webhook secrets, provider credentials, OTP codes and message content are never written — metadata is sanitized again before insert and only non-sensitive fields such as changed field names or a key's public prefix are kept. Entries are only ever inserted and read; the API exposes no update or delete path, and a database trigger (`reject_audit_log_mutation`, migration `0016_audit_log_append_only.sql`) rejects every `UPDATE`/`DELETE` on `audit_log` while still allowing `INSERT`, so the log is append-only at the database level and cannot be altered even through direct SQL. Merchants read their own entries through `GET /v1/audit-log` (newest first, `limit`/`offset` pagination, capped at 100 per page); administrators read every entry through `GET /v1/admin/audit-log` with `actorType`, `action` and `resourceType` filters plus the same pagination. The merchant dashboard has an **Activity** page and the admin dashboard an **Audit log** table.

Production startup requires explicit database, admin, API-key pepper, public URL, and webhook encryption configuration. Admin and pepper secrets must be distinct random values of at least 32 characters; `PUBLIC_BASE_URL` and `BASE_RPC_URL` must use HTTPS. Configure `TRUST_PROXY` only with the IPs/CIDRs of trusted reverse proxies; forwarded client addresses are not trusted by default. API requests are rate-limited per client address, and responses include basic content-type, framing, referrer, permissions, and CSP protections. Production webhook delivery pins the validated DNS answer to the outbound connection to prevent DNS-rebinding SSRF.

For Compose-based deployment, health/readiness, the upgrade and rollback procedure, database migrations, backup/restore, a backup automation example (cron/systemd), and a restore drill, see [`PRODUCTION.md`](PRODUCTION.md). Database backups use `npm run backup` / `npm run backup:verify` / `npm run backup:restore` (`scripts/db-backup.mjs`), which wrap the stock PostgreSQL 16 `pg_dump`/`pg_restore` tools, read `DATABASE_URL` from the environment without printing it, and exclude and verify out ephemeral runtime/cache data. Continuous integration (`.github/workflows/ci.yml`) runs `npm test`, `npm run typecheck`, `npm run build`, `npm audit`, and `git diff --check` on every push and pull request; it is test-only and has no deploy step.

## Invoices and Receipts

Confirmed payments receive a unique invoice number and one receipt in the same database transaction as payment confirmation. Merchants can list and download invoices/receipts with `GET /v1/invoices`, `GET /v1/receipts`, and their `.pdf` endpoints. Public receipts use a separate random URL identifier at `/r/:publicId`; the deterministic PDF is generated server-side. The SDK exposes invoice/receipt retrieval and PDF download methods.

## USDC on Base

Set `BASE_RPC_URL` to a trusted Base mainnet JSON-RPC endpoint (a self-operated node is supported). `USDC_TOKEN_ADDRESS` defaults to Circle's Base USDC contract, and `USDC_MIN_CONFIRMATIONS` defaults to 12. Merchant `walletAddress` is the direct payment recipient; Tariffia never holds or signs with merchant keys.

The API's payment detector scans configured USDC `Transfer` logs. `POST /v1/payments/:paymentId/verify` accepts a transaction hash as a hint, not proof. The server independently checks its RPC chain ID, token contract and token decimals, successful receipt, exact recipient, exact six-decimal amount, payment creation time and confirmation depth. Only then does one database transaction set the payment `CONFIRMED`, set its order `PAID`, store the transaction hash and append `PAYMENT_CONFIRMED` to the ledger. The hash is unique per network and a repeated confirmation cannot create a second ledger entry.

```sh
curl -X POST http://localhost:8080/v1/payments/PAYMENT_ID/verify \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -d '{"transactionHash":"0xTRANSACTION_HASH"}'
```

The endpoint responds with `202` while the transfer is unmined or below the configured confirmation depth, and `200` once independently verified and recorded.

An unmined or under-confirmed payment remains `PENDING`/`DETECTED` and is not recorded as paid. The detector resumes from its persisted block cursor after restarts. Invalid or mismatched transfers never update the order or ledger.

## Hosted Checkout, Links and QR

`POST /v1/payment-links` creates an order and payment through the same Payment Core as `POST /v1/orders`; it does not create a second payment record or balance system. The idempotent response includes `checkoutUrl` and `qrUrl`. `PUBLIC_BASE_URL` must be the externally reachable HTTPS origin when merchants share links publicly.

Merchants manage their links with `GET /v1/payment-links` (list, newest first, with status, amount/currency, enabled state and the checkout/QR URLs), `GET /v1/payment-links/:paymentId` (detail), `PATCH /v1/payment-links/:paymentId` (`{ "enabled": false }` pauses the link; `true` re-enables it) and `DELETE /v1/payment-links/:paymentId` (soft-deletes the link). A payment link is the existing payment/order; the management row stores only the reversible enabled/deleted state and never touches payment processing or verification. A paused or deleted link's public checkout view and QR stop resolving (404) while on-chain verification of an already-sent transfer remains available. Results are always scoped to the authenticated merchant; payment links created through `POST /v1/orders` behave identically (active by default). The merchant dashboard "Payment links" page lists links with status, amount/currency and checkout link, and offers enable/disable and delete actions.

The hosted page at `/p/:paymentId` fetches a limited public view of the existing payment: merchant, description, amount, USDC token, Base network, recipient and status. It supports an injected EIP-1193 browser wallet to send the exact ERC-20 transfer directly to the merchant, and polls the server for status. The browser submits a transaction hash only as a hint; server-side verification remains authoritative. Merchant API keys and private keys are never sent to the browser.

The QR image encodes the same hosted checkout URL and payment ID, so scanning it resolves to the same server-owned payment request rather than a second payment or client-defined amount. Customers without an injected wallet can still scan/open the page and review or copy the payment details for a Base wallet.

Checkout routes are `GET /p/:paymentId`, `GET /p/:paymentId/qr.png`, `GET /v1/public/payments/:paymentId` and `POST /v1/public/payments/:paymentId/verify`.

## Webhooks

Merchants configure an endpoint URL, a set of event types and a secret they already control. Supported events are `payment.created`, `payment.detected`, `payment.confirmed`, `payment.failed`, `payment.expired`, `order.paid`, `credit.topup`, `credit.deducted`, `ai.usage.recorded`, `invoice.issued` and `receipt.issued`, plus the subscription, AI provider request (`ai.request.completed`/`ai.request.failed`) and SMS request (`sms.request.completed`/`sms.request.failed`) lifecycle events. Events are recorded in a transactional outbox alongside the corresponding payment/order/ledger/credit/AI-usage/SMS-usage/document transition, then delivered asynchronously.

Payments expire after `PAYMENT_EXPIRATION_MINUTES` only when no transaction hash has been submitted. A submitted or on-chain-detected transfer is not expired while verification is pending. `payment.failed` is emitted only when the configured USDC contract receipt proves that the matching transfer call reverted; an arbitrary invalid hash does not fail the payment.

Create an endpoint; the secret is sent only in the request and is never returned:

```sh
curl -X POST http://localhost:8080/v1/webhooks \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -d '{"name":"Store events","url":"https://merchant.example/webhooks/tariffia","events":["payment.confirmed","order.paid"],"secret":"REPLACE_WITH_A_LONG_RANDOM_SECRET"}'
```

Webhook secrets are AES-256-GCM encrypted at rest using `WEBHOOK_ENCRYPTION_KEY`; create, update, list and admin log responses never return either the secret or its encrypted value. The encryption key must be stable across restarts and deployments; back it up securely and use a unique 32-byte random key (64 hex characters) in production. Rotate an endpoint's HMAC secret through `PATCH /v1/webhooks/:endpointId` by sending a new `secret`; Tariffia will not echo it. Endpoint URLs are existing plaintext configuration; do not embed API credentials in URL paths or query strings, and use the HMAC signing secret instead.

Each JSON event has a unique UUID `id`, `type`, `createdAt` and `data`. Deliveries include `X-Tariffia-Event-Id`, `X-Tariffia-Timestamp` and `X-Tariffia-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>`. The signature is HMAC-SHA256 over `<timestamp>.<exact raw request body>`. Receivers should verify the signature with a bounded timestamp tolerance and deduplicate by event ID. The helper in `src/webhooks/signature.ts` implements verification.

Non-2xx responses, timeouts and connection failures are retried with exponential backoff and jitter up to `WEBHOOK_MAX_ATTEMPTS`. Every attempt and the latest delivery status/error are visible to the merchant; the admin API can inspect delivery status across merchants. Production endpoints must use HTTPS and resolve to public IPs. Redirects are not followed.

Endpoint management and logs are available at `GET/POST /v1/webhooks`, `PATCH/DELETE /v1/webhooks/:endpointId`, `GET /v1/webhooks/:endpointId/deliveries`, and `GET /v1/webhooks/:endpointId/deliveries/:deliveryId/attempts`. Admins use `GET /v1/admin/webhook-deliveries` and `GET /v1/admin/webhook-deliveries/:deliveryId/attempts` with the server-side admin key. Merchants manage endpoints self-service with the same API — create, select events, update the URL/events/name, enable/disable (pausing cancels queued deliveries) and delete — and always see only their own endpoints and delivery history; the signing secret is shown only in the create/update request and never returned or stored in plaintext. The merchant dashboard has a combined **Webhooks** page with the endpoint list (status and events) and recent deliveries. Admin webhook log views omit URL paths and query strings.

## Security and custody

- The admin credential and API-key pepper are server-only environment secrets.
- Merchant API keys are shown once and stored only as HMAC-SHA256 hashes.
- Merchants manage their own keys in self-service: `GET /v1/api-keys` lists their keys (active and revoked, with status, scopes and last-used time) without ever returning a secret or hash, `POST /v1/api-keys` returns the full secret exactly once, and `DELETE /v1/api-keys/:keyId` revokes a key immediately. A merchant can never see or revoke another merchant's key. The merchant dashboard has an **API keys** page for the same list/create/revoke flow with a one-time secret display.
- Merchant API keys are scoped. Each scope is `<area>:<read|write>` (for example `orders:read`, `payments:write`, `webhooks:write`, `ai:write`), where a `write` scope also grants the matching `read` scope. The full catalogue is `orders`, `payments`, `customers`, `credits`, `ai`, `sms`, `webhooks`, `subscriptions`, `revenue`, `settings`, `notifications`, `usage`, `api-keys`, `documents`, `ledger`, `audit` and `dashboard` with `read`/`write` where applicable (revenue, usage, documents, ledger, audit and dashboard are read-only). `POST /v1/api-keys` accepts an optional `scopes` array; when omitted the key receives the full default catalogue. A key that lacks the scope required by a route receives `403 insufficient_scope`. Keys issued before scope enforcement (the historical default set `payments:write`, `orders:write`, `customers:write`, `ledger:read`) are grandfathered as full access so existing integrations keep working. Scope names are listed in `GET /openapi.json`. Admin authentication (`x-admin-api-key`) is separate and unaffected.
- Tariffia does not hold or sign with customer or merchant private keys.
- The append-only `audit_log` is enforced by a PostgreSQL trigger (`BEFORE UPDATE OR DELETE`, migration `0016_audit_log_append_only.sql`), so entries cannot be modified or removed even by direct SQL; `INSERT` remains allowed. The `ledger_entries` table has an equivalent immutability trigger.
- USDC payments and internal `CREDITS` balances use different records and currency labels; credits cannot be withdrawn or cashed out.
- The frontend never determines payment status. Only the configured chain adapter can confirm a payment after independent server-side verification.

## Production Hardening

Production startup now requires explicit PostgreSQL, admin key, API-key pepper, public origin and webhook-encryption settings. Admin and pepper keys must be distinct, non-placeholder secrets of at least 32 characters; database, admin, pepper and encryption secrets cannot be reused. The public origin and Base RPC URL must use HTTPS. `TRUST_PROXY` defaults to `false`; behind a reverse proxy, set it only to constrained trusted proxy IPs/CIDRs. Blanket or wildcard proxy trust is rejected in production.

API requests have a configurable per-client-address limit (`API_RATE_LIMIT_PER_MINUTE`, default 300). Responses include content-type, clickjacking, referrer, permissions and CSP protections, plus HSTS in production. CORS remains disabled so credential-bearing APIs are same-origin by default. Production webhook delivery re-resolves and validates the destination immediately before sending, then pins the validated public address for the HTTP/TLS connection to prevent DNS-rebinding SSRF. Admin webhook logs return only endpoint origins; transport errors are normalized so URL query credentials are not persisted or returned. API logs redact credential headers and omit arbitrary error messages/stacks. The API maps rate-limit, malformed-body and oversized-body errors to bounded 429/400/413 responses instead of internal errors. The unused CORS dependency was removed.

## Credit Engine

USDC top-ups create real Base USDC payment requests through the existing Payment Core. Credits are not USDC: they are an internal, non-withdrawable usage balance held in per-merchant/per-customer credit accounts. The default conversion is `1 USDC = 100 CREDITS`; the default top-up range is `1` to `1000 USDC`. Environment values seed settings when the database is initialized; admins can update the stored conversion rate and bounds through `/v1/admin/credits/settings`.

Credits are issued only inside the same database transaction that confirms the USDC payment, records the credit transaction, updates the account, and appends the separate `CREDIT_TOPUP` CREDITS ledger entry. Deductions use an atomic `balance >= amount` database update, a non-negative balance constraint, and `Idempotency-Key`; concurrent attempts cannot spend the same balance twice. `CREDIT_DEDUCTION` entries use currency `CREDITS`, separate from `PAYMENT_CONFIRMED` entries in USDC. The ledger is an event record, not a wallet-balance calculation.

The `credit.topup` and `credit.deducted` webhook events report internal credit changes. Credits remain non-withdrawable internal units and are not a second payment system.

```sh
# Create a USDC payment link that will top up this merchant customer after payment verification.
curl -X POST http://localhost:8080/v1/credits/topups \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -H 'idempotency-key: customer-42-credit-topup-0001' \
  -d '{"customerId":"CUSTOMER_UUID","amount":"1.00"}'

# Spend 25 internal credits; this never creates or transfers a USDC payment.
curl -X POST http://localhost:8080/v1/credits/deductions \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -H 'idempotency-key: ai-request-0001' \
  -d '{"customerId":"CUSTOMER_UUID","amount":"25.00","reference":"request-0001","metadata":{"request_id":"request-0001"}}'
```

## AI Reseller Pricing and Usage

Admins configure provider names and model pricing through the `/v1/admin/ai` endpoints. Each model can charge per request, per 1,000 input/output tokens, or both. Provider cost and customer price are recorded separately; a customer price can be set explicitly per pricing component or derived from the configured markup basis points. Prices use USD with eight decimal places internally, while the customer's charge is converted using the existing `credits_per_usdc_rate` and deducted from the same credit account as other usage.

This phase does not connect to AI providers or store provider API keys. Merchant backends report completed usage to `POST /v1/ai/usage`; the API calculates the charge from the active model configuration, atomically deducts credits, writes the existing credit ledger, stores provider cost/customer price/profit and emits `credit.deducted` plus `ai.usage.recorded`. Disabled providers or models are rejected. `requestId` is the idempotency key: repeating it with the same payload replays the original result, while changing the payload returns `409`.

Treat usage reporting as a trusted server-to-server operation. Do not call it from a customer-controlled browser: reported token counts are supplied by the merchant and are not independently verified against a provider. `GET /v1/ai/models` exposes active model names and customer prices without provider costs; merchant usage history is scoped to the authenticated merchant. Provider secrets are neither accepted nor returned by these endpoints.

Configure a provider and token-priced model:

```sh
curl -X POST http://localhost:8080/v1/admin/ai/providers \
  -H 'content-type: application/json' -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"slug":"example-ai","name":"Example AI"}'

# Use the returned provider ID in the model path. A null/omitted customer rate derives from markupBps.
curl -X POST http://localhost:8080/v1/admin/ai/providers/PROVIDER_UUID/models \
  -H 'content-type: application/json' -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"slug":"text-small","name":"Text Small","enabled":true,"pricingMode":"PER_1K_TOKENS","providerInputCostPer1kUsd":"0.01000000","providerOutputCostPer1kUsd":"0.02000000","markupBps":1000}'
```

Record usage using the merchant API key. The customer must have enough credits, topped up through the existing USDC flow or credited through the existing credit engine:

```sh
curl -X POST http://localhost:8080/v1/ai/usage \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -d '{"requestId":"ai-request-0001","customerId":"CUSTOMER_UUID","provider":"example-ai","model":"text-small","inputTokens":1200,"outputTokens":450,"metadata":{}}'
```

Admins can inspect configured costs and margins with `GET /v1/admin/ai/models` and `GET /v1/admin/ai/usage`; merchant-facing model and usage endpoints do not expose provider cost or markup.

### Streaming Completions and Tool Calls

`POST /v1/ai/chat/stream` accepts the same body as `POST /v1/ai/chat/completions` and returns a server-sent events stream: `{"type":"chunk"}` events as content is generated, `{"type":"tool_call"}` events for normalized provider tool calls, a final `{"type":"finish"}` event, and a terminal `{"type":"done"}` event carrying the settled usage and charge. Pre-stream failures (validation, insufficient credits, unknown model, duplicate `requestId`) return ordinary bounded JSON errors with proper HTTP status codes; provider failures after the stream started are reported as a terminal `{"type":"error"}` event with a canonical code such as `ai_provider_timeout`.

```sh
curl -N -X POST http://localhost:8080/v1/ai/chat/stream \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -d '{"requestId":"stream-request-0001","customerId":"CUSTOMER_UUID","provider":"openai-compatible","model":"text-small","messages":[{"role":"user","content":"Count to three"}],"maxOutputTokens":128}'
```

Both completion endpoints accept optional `tools` (OpenAI-style function definitions) and `toolChoice`. Tool definitions and provider tool-call results (including the provider-supplied JSON arguments string) are normalized and returned to the merchant only: Tariffia never interprets, follows or executes tool calls — shell commands, URLs, code or any server action stay the merchant's responsibility. Multi-turn conversations may send back `assistant` messages with `toolCalls` and `tool` role messages with `toolCallId`.

Billing rules for streams: chunks are never treated as authoritative billing data. When the provider reports final token usage (OpenAI-compatible `stream_options.include_usage`), it settles the charge; without it, Tariffia estimates from the verified received content plus the original prompt estimate (`usageSource: "estimated"`). The final settlement never exceeds the amount authorized before the provider call: if actual usage exceeds it, the charge is capped at the authorized maximum (`chargeCapped: true`) and never grows unbounded. If the merchant's client disconnects, Tariffia aborts the provider request, marks the request `FAILED` with `client_disconnected` and creates no usage charge. Provider streams that fall silent are aborted after `OPENAI_REQUEST_TIMEOUT_MS` of inactivity (an idle deadline, not a total-stream limit). Request records keep identifiers, statuses, token counts, latencies and tool-call counts only — never prompt or completion content.

## Merchant Usage Limits

Tariffia keeps a per-merchant request counter and enforces a per-merchant request rate limit in each of three categories: **general** API requests, **AI** requests (`/v1/ai/*`) and **SMS** requests (`/v1/sms/*`). Every authenticated merchant request is counted in exactly one category; admin, public and unauthenticated requests are not counted or limited here. This sits on top of the existing global per-client-address limiter, which still applies.

Counts use fixed one-minute windows. The window row is seeded idempotently and incremented with a single conditional `UPDATE ... WHERE request_count < limit`, so concurrent requests for the same merchant and window cannot overshoot the limit. When the effective limit is exceeded, the merchant API returns `429` with the error code `merchant_rate_limited`, a clear message naming the category, and a `Retry-After` header for the current window; the request is not passed to the route handler.

Limits are configurable per deployment (`MERCHANT_GENERAL_REQUESTS_PER_MINUTE` default `300`, `MERCHANT_AI_REQUESTS_PER_MINUTE` default `60`, `MERCHANT_SMS_REQUESTS_PER_MINUTE` default `60`) and per merchant: a per-merchant override value `0` means unlimited, a positive value is the limit, and no override uses the configured default. Administrators can inspect and change limits with `GET /v1/admin/usage/merchants`, `GET /v1/admin/usage/merchants/:merchantId` and `PUT /v1/admin/usage/merchants/:merchantId` (body `{ "generalRequestsPerMinute": 300, "aiRequestsPerMinute": 60, "smsRequestsPerMinute": 60 }`; `null` clears an override). Counters record only merchant, category, window and count — never prompts, completions, SMS content or OTP codes.

Merchants can see their own usage with `GET /v1/usage`, which returns each category's current-window usage, effective limit (`null` and `unlimited: true` when the merchant override is `0`), remaining requests and the window reset time — scoped to the authenticated merchant only. The merchant dashboard has a matching **API usage** page with a used/limit progress indicator, remaining requests and the reset time.

## SMS and OTP Services
Tariffia's second metered V1 service is OTP/SMS delivery, built on the same provider abstraction, pricing engine, credit accounts and ledger as the AI service. A formal `SmsProvider` contract (`src/sms-provider.ts`) with capabilities, health checks and normalized errors is registered in a server-side registry (`src/sms-providers/`). The bundled integration is an HTTP SMS provider configured exclusively through environment secrets (`SMS_HTTP_BASE_URL`, `SMS_HTTP_API_KEY`, `SMS_HTTP_TIMEOUT_MS`, `SMS_HTTP_SEND_PATH`, `SMS_HTTP_HEALTH_PATH`); the provider API key is never stored in the database, returned by any endpoint, or written to logs. Disable the integration entirely with `SMS_PROVIDER_ENABLED=false`.

Administrators register provider rows and define Tariffia-owned services (initial type: `otp_sms`) with per-message customer pricing, optional provider cost, markup basis points, OTP length/expiry and a `{code}` message template. The customer never selects a provider: they select a Tariffia service, and Tariffia chooses the configured provider. Each service has an explicit primary provider and an optional explicit fallback provider; disabled, unconfigured or unhealthy providers never receive requests, and a fallback is attempted only after a provably safe-to-retry failure (a timeout only when the provider guarantees idempotent retries). Every attempt is audited, and the request identifies the provider that actually accepted the message. See [`SMS_PROVIDERS.md`](SMS_PROVIDERS.md) for the provider contract, selection, health, idempotency, safe-retry rules and how a future real provider adapter plugs in.

```sh
curl -X POST http://localhost:8080/v1/admin/sms/providers \
  -H 'content-type: application/json' -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"slug":"http-sms","name":"Primary SMS gateway"}'

# Use the returned provider ID in the service path. A null customer price derives from markupBps.
curl -X POST http://localhost:8080/v1/admin/sms/providers/PROVIDER_UUID/services \
  -H 'content-type: application/json' -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"slug":"otp_sms","name":"OTP SMS","type":"otp_sms","enabled":true,"providerCostPerSmsUsd":"0.00400000","customerPricePerSmsUsd":"0.00500000","markupBps":0,"otpLength":6,"otpExpirySeconds":300,"maxMessageLength":480}'
```

Send an SMS or request an OTP delivery with the merchant API key. `requestId` is the idempotency key scoped to the merchant: a duplicate identifier returns `409 sms_request_conflict` without calling the provider or charging again. `customerId` is optional; when omitted, usage bills the merchant's own account (an internal `merchant-self` billing customer). Insufficient credits for the maximum cost of the request return `409 insufficient_credits` before any provider call. Long messages are priced per segment (GSM-7/UCS-2 estimation bounds the authorization; provider-reported segments settle the charge).

```sh
curl -X POST http://localhost:8080/v1/sms/send \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -d '{"requestId":"sms-request-0001","service":"otp_sms","to":"+381601234567","message":"Your package has shipped"}'

curl -X POST http://localhost:8080/v1/sms/otp \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -d '{"requestId":"otp-request-0001","service":"otp_sms","to":"+381601234567"}'
```

`POST /v1/sms/otp` generates the code server side when the provider has no native OTP capability, renders the configured template and delivers it through the provider. The OTP code is never stored, logged, returned in the API response, included in webhook payloads, or kept in the provider request record; only identifiers, statuses, segment counts and latencies are recorded. `GET /v1/sms/services` lists enabled services with customer pricing only.

Successful delivery settles atomically in one transaction: credit deduction, `CREDIT_DEDUCTION` ledger entry, SMS usage record (customer price, provider cost when reported, profit) and the `credit.deducted` plus `sms.request.completed` webhooks. Provider failures never charge: the request is marked `FAILED` with a canonical error category, `sms.request.failed` is emitted, and provider errors are normalized (`504 sms_provider_timeout` for timeouts, plus rate-limited, unauthorized, invalid-request and unavailable categories) so raw provider text, credentials and message content are never exposed. OTP delivery has a stricter per-route rate limit in addition to the global API limit. Admin SMS endpoints expose provider health/capabilities/configuration status and the request/usage trails without credentials.

## TypeScript Integration Layer

The publishable SDK package is in `sdk/`. `@tariffia/pay/server` wraps the existing `/v1` API with merchant bearer authentication, typed responses and errors, explicit idempotency keys, and webhook signature verification. It does not contain payment, credit, or pricing logic. See [`sdk/README.md`](sdk/README.md) for REST, TypeScript, checkout, webhook, credit, and AI usage examples.

Import `@tariffia/pay/server` only in trusted Node.js server code. Never bundle a merchant API key into browser code. Browser checkout pages may import only `@tariffia/pay/browser`, which provides hosted-checkout navigation helpers without API authentication. Payment status and verification remain server-side Tariffia responsibilities.

## Admin and Merchant Dashboards

Open `/admin` for the platform console or `/merchant` for the merchant workspace. The admin console requires `ADMIN_API_KEY`; the merchant workspace requires that merchant's API key. Credentials are held in browser-tab memory only and are cleared when signing out, reloading or closing the tab. The light/dark theme preference is the only dashboard value stored locally.

Dashboard collection and summary endpoints are read-only views over the existing payment, credit, AI usage and webhook tables. Admin data routes require the admin header; merchant routes authenticate with the merchant API key and scope every result to that merchant. Search, status filters and bounded pagination are supported for collection views. Payment-link creation, credit top-ups, customer creation, AI pricing and webhook management continue to use their existing APIs and services rather than dashboard-specific business logic.

Merchant dashboards show the configured customer price and credits charged for AI usage, but not provider costs or platform margins. Admin webhook endpoint views omit URL paths and query strings; webhook secrets, encrypted webhook secrets, API keys and private keys are never displayed by the dashboard. The admin health screen uses the basic `/health` response and operational counts only.

## Architecture

`src/payment-adapter.ts` defines the common rail contract; `src/payment-adapters/registry.ts` owns adapter registration, lifecycle, configuration status, selection, capabilities and normalized results. `src/adapters/usdc/` contains the Base USDC implementation. The admin-only `/v1/admin/payment-adapters` endpoint exposes installed method status without exposing settings. See [`PAYMENT_ADAPTERS.md`](PAYMENT_ADAPTERS.md) to add an adapter. `src/services/payment-core-service.ts` owns idempotent order/payment creation; `src/services/payment-verification-service.ts` coordinates atomic payment/order/ledger updates; `src/services/credit-engine.ts` owns internal balances and atomic deductions; `src/services/ai-pricing-engine.ts` prices and records metered usage; `src/services/usage-settlement.ts` is the shared atomic usage settlement core used by both metered services; `src/services/webhook-delivery-worker.ts` handles expiry and asynchronous signed delivery. `src/ai-provider.ts` and `src/sms-provider.ts` define the AI and SMS provider contracts with their registries under `src/ai-providers/` and `src/sms-providers/`; `src/services/ai-gateway-service.ts` and `src/services/sms-gateway-service.ts` own the authorize-call-settle request flow, including the streaming `prepare`/`run` lifecycle. `src/webhooks/` contains secret encryption, signatures and transactional outbox helpers. `src/modules/` separates merchant, admin, dashboard, payment, credit, AI, SMS, webhook, API-key and ledger routes. Dashboard HTML, CSS and JavaScript are in `web/`; PostgreSQL schema is versioned under `migrations/`.

## Development checks

```sh
npm test
npm run typecheck
npm run build
```

The normal `npm test` suite runs on pg-mem (in-memory PostgreSQL), which cannot execute PL/pgSQL triggers; the harness therefore strips the ledger immutability and audit append-only guards, emulating them where tested. To exercise those database-level guarantees on real PostgreSQL 16 (including the real migration runner and the production triggers), run the opt-in lane against a **disposable** database — never production:

```sh
TEST_DATABASE_URL='postgres://tariffia:tariffia@localhost:5432/tariffia_test' npm run test:postgres
```

If `TEST_DATABASE_URL` is unset the lane skips cleanly and `npm test` is unaffected. See [`docs/QUICKSTART.md`](docs/QUICKSTART.md#real-postgresql-validation-optional) for details.

## License

MIT. See `LICENSE`.
