# Tariffia Pay

Self-hosted, non-custodial merchant payment infrastructure. The payment core owns merchants, customers, orders, payments and the immutable transaction ledger. Chain-specific behavior belongs behind payment adapters; USDC on Base is the first adapter and is implemented in Phase 2.

## Phase 1-15 status

Implemented: PostgreSQL schema/migrations, admin-provisioned merchants, hashed merchant API keys, customers, idempotent order/payment creation, append-only ledger, the formal payment-adapter contract and registry with Base USDC verification and a disabled-by-default LND REST Lightning provider, unified multi-method checkout, invoices and receipts, signed/retried merchant webhooks, an internal customer Credit Engine, configurable AI reseller pricing with usage metering, separate admin/merchant dashboards, the official TypeScript integration package, production security hardening, and self-hosted production deployment support. Configure Lightning only through server-side environment secrets. Additional payment methods are later phases.

Phase 16 added merchant subscription plans, billing cycles and lifecycle management on the same Payment Core. Phase 17 connected the AI pricing engine to a real OpenAI-compatible provider behind a server-side credential with credit authorization before every provider call. Phase 18 added the OTP/SMS charging service on the same credit, ledger and pricing architecture, plus streaming chat completions and tool-call support for the AI gateway. Phase 19 hardened the SMS provider architecture: multiple providers, capability validation, health gating, explicit primary/fallback selection with safe-retry-only fallback, stable provider idempotency keys and a full attempt audit trail. Phase 20 added TextBee as the first real SMS provider adapter (Android-device gateway, `x-api-key` authentication, disabled by default) behind the same contract; see [`SMS_PROVIDERS.md`](SMS_PROVIDERS.md). Phase 21 added a per-merchant request usage counter and configurable rate limits for general, AI and SMS requests on top of the existing global limiter.

## Run locally

Requirements: Node.js 20+ and Docker Compose.

```sh
cp .env.example .env
# Replace all placeholder secrets. WEBHOOK_ENCRYPTION_KEY must be 64 hex characters.
docker compose up --build
```

The API listens on `http://localhost:8080`. `GET /health` verifies API and database availability; `GET /ready` is the readiness probe. Compose applies migrations in a one-shot service before starting the API, which also checks migrations on startup.

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

- `GET /v1/orders/:orderId`
- `GET /v1/payments/:paymentId`
- `POST /v1/payments/:paymentId/verify` with `{ "transactionHash": "0x..." }`
- `POST /v1/payment-links` with the same order payload and `Idempotency-Key`
- `GET /v1/customers/:customerId`
- `GET /v1/ledger?limit=50`
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
- Dashboards: `/admin` and `/merchant`; collection reads are available under `/v1/admin/dashboard/*` and merchant-scoped `/v1/dashboard/*`
- TypeScript SDK: `sdk/` (`@tariffia/pay/server` and credential-free `@tariffia/pay/browser` exports)

Create a shareable link from the merchant API:

```sh
curl -X POST http://localhost:8080/v1/payment-links \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -H 'idempotency-key: hosted-checkout-0001' \
  -d '{"description":"Digital item","amount":"12.00","currency":"USDC"}'
```

The response contains `checkoutUrl` and `qrUrl`. The QR encodes that same `checkoutUrl`; it resolves to the server-owned payment ID and canonical payment details. The hosted page is responsive and supports EIP-1193 wallets on Base.

Every merchant-owned read is scoped to the authenticated merchant. The ledger database trigger rejects updates and deletes.

Production startup requires explicit database, admin, API-key pepper, public URL, and webhook encryption configuration. Admin and pepper secrets must be distinct random values of at least 32 characters; `PUBLIC_BASE_URL` and `BASE_RPC_URL` must use HTTPS. Configure `TRUST_PROXY` only with the IPs/CIDRs of trusted reverse proxies; forwarded client addresses are not trusted by default. API requests are rate-limited per client address, and responses include basic content-type, framing, referrer, permissions, and CSP protections. Production webhook delivery pins the validated DNS answer to the outbound connection to prevent DNS-rebinding SSRF.

For Compose-based deployment, migrations, readiness, upgrades, and PostgreSQL backup/restore procedures, see [`PRODUCTION.md`](PRODUCTION.md).

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

Endpoint management and logs are available at `GET/POST /v1/webhooks`, `PATCH/DELETE /v1/webhooks/:endpointId`, `GET /v1/webhooks/:endpointId/deliveries`, and `GET /v1/webhooks/:endpointId/deliveries/:deliveryId/attempts`. Admins use `GET /v1/admin/webhook-deliveries` and `GET /v1/admin/webhook-deliveries/:deliveryId/attempts` with the server-side admin key.

## Security and custody

- The admin credential and API-key pepper are server-only environment secrets.
- Merchant API keys are shown once and stored only as HMAC-SHA256 hashes.
- Tariffia does not hold or sign with customer or merchant private keys.
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

## License

MIT. See `LICENSE`.
