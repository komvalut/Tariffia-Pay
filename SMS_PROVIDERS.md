# SMS Provider Architecture

SMS providers plug in at `SmsProviderRegistry` (`src/sms-providers/registry.ts`) behind the formal `SmsProvider` contract (`src/sms-provider.ts`). The SMS gateway (`src/services/sms-gateway-service.ts`) owns provider selection, health gating, safe-retry fallback, idempotency, normalization and settlement. Merchants select a Tariffia **service** (`otp_sms`); they never select, see, or configure a provider. Tariffia decides which provider handles a service.

## Contract

Implement `SmsProvider` from `src/sms-provider.ts`:

- `manifest` declares a stable lowercase ID, display name, version, kind (`http-sms` today) and capabilities: `sendSms`, `sendOtp`, `maxMessageLength` (1–1600), `reportsSegments`, `reportsProviderCost` and `idempotentRetries`.
- `initialize(settings)` validates adapter-only configuration and opens resources; `shutdown()` releases them. Both run through registry lifecycle handling. Provider credentials come from the process environment only — never from the database, admin API, URLs or logs.
- `health()` returns a bounded state (`healthy`, `degraded`, `unavailable`) and message. Never include URLs, credentials or provider response bodies.
- `isConfigured()` reports whether a usable server-side credential/endpoint exists, without exposing it.
- `sendSms(request)` / `sendOtp(request)` receive the destination, the message (OTP code rendered server-side when the provider has no native OTP), and a **stable idempotency key derived from the Tariffia request**. They return the normalized `SmsDeliveryResult`: `providerRequestId`, `providerMessageId`, `status: 'sent'`, `segments`, `segmentsAuthoritative`, `providerCostUsd` (nullable) and `currency: 'USD'`.
- Failures must be thrown as `SmsProviderError` (or normalized through `normalizeSmsProviderError`) with one of the canonical kinds: `timeout`, `rate_limited`, `unauthorized`, `invalid_request`, `not_found`, `unavailable`, `invalid_response`. A rate-limited response may carry `retryAfterMs`, parsed from the provider's `Retry-After` header. Raw provider messages, message content and credentials must never be returned or stored.

### The `idempotentRetries` capability

`idempotentRetries: true` declares that the provider **guarantees server-side deduplication** of retries carrying the same stable idempotency key. This single flag decides whether a timeout is safe to retry: without it, a timeout is an ambiguous outcome (the message may already have been accepted upstream) and Tariffia never retries or falls back from it. The bundled generic HTTP provider sends the key but cannot guarantee upstream deduplication, so it declares `false`.

## Provider selection

A service is configured with a **primary provider** and an optional, **explicit fallback provider** (`fallbackProviderId` on `sms_services`, administered through `POST/PUT /v1/admin/sms/*`). Fallback is explicit configuration, never random selection, and the fallback must be an enabled provider different from the primary. There is no silent switching: without a configured fallback, a provider failure fails the request safely with no charge.

For every request the gateway evaluates candidates in order (primary, then fallback):

1. **Disabled** providers (database flag or registry) never receive the request — a service whose primary is disabled is not routable at all.
2. **Unconfigured** providers (no usable server-side credential) never receive the request.
3. **Unhealthy** providers never receive the request. The gateway performs a dispatch-time health check for each candidate and records the result in `sms_providers.last_status` for administrators. Implementations may cache health results internally for a short TTL.
4. The remaining candidate receives the delivery attempt with the same stable idempotency key on every attempt.

If no candidate is available, the request fails **before any SMS is sent**: it is marked `FAILED` (`sms_provider_unavailable` to the merchant) and the customer is never charged.

## Safe retry and fallback rules

Fallback happens **only after a provider failure that is provably safe to retry**:

- `unavailable` (temporary) — safe: the request was not accepted.
- `rate_limited` — safe: the provider explicitly rejected the request before acceptance. The `retryAfterMs` hint is preserved in the attempt trail; Tariffia never hammers a rate-limited provider back immediately.
- `timeout` — safe **only** when the failing provider declares `idempotentRetries` (duplicate delivery can be ruled out upstream). Otherwise a timeout is ambiguous and the request fails with no fallback and no charge.

Never retried (no fallback, request fails safely): `invalid_request`, `not_found` (invalid destination), `unauthorized`, and `invalid_response` — an accepted-but-unparseable response is ambiguous (the SMS may already have been accepted) and must not be re-sent.

No SMS request is ever blindly retried: the same Tariffia `requestId` is rejected by the existing idempotency system (`409 sms_request_conflict`), and the same stable idempotency key is used across all attempts of one request, so a provider honoring it can never deliver duplicates.

## Attempt audit trail

Every pre-acceptance attempt is recorded on `sms_provider_requests.attempts`: provider slug, outcome (`skipped_unconfigured`, `skipped_unhealthy`, `failed`), failure kind, `retryAfterMs`, latency and timestamp. The row's `provider_id` is updated to the provider that actually accepted the message, usage records attribute the accepting provider, and merchant/admin responses identify that provider plus `fallbackUsed`. The trail contains no message content and no OTP codes.

## Billing

SMS billing is unchanged and uses the single shared settlement core (`src/services/usage-settlement.ts`) and the existing pricing engine: provider cost → configured Tariffia customer price → profit → atomic credit deduction → `CREDIT_DEDUCTION` ledger entry → `sms_usage_records` usage record, in one transaction, after the provider accepted the message. Credits are never deducted before authorization, never when the provider rejected the request before acceptance, and never twice. Provider cost may be unknown until the provider responds: when the accepting provider reports it, that cost is recorded; otherwise the service's configured provider cost estimates it.

## OTP and content security

OTP codes are generated server-side (or by the provider when it supports native OTP), delivered only inside the provider request, and never persisted, logged, returned in API responses, included in webhook payloads or kept in provider request records. Message content is never stored or logged. Provider credentials never enter the database, URLs, admin APIs or logs.

## The bundled generic HTTP provider

`src/sms-providers/http-sms-provider.ts` implements the documented generic contract: bearer-authenticated `POST {SMS_HTTP_BASE_URL}{SMS_HTTP_SEND_PATH}` with `{to, message, idempotency_key}`, expecting `{id, status?, segments?, cost?}`; `GET {SMS_HTTP_HEALTH_PATH}` for health; `Retry-After` parsing on 429. Configure it only through environment secrets (`SMS_HTTP_*`, `SMS_PROVIDER_ENABLED=false` disables it). A real commercial provider adapter (TextBee, Twilio, Vonage or another) should be added as a new implementation behind this same contract, declaring its real capabilities — including `idempotentRetries` only if the upstream API truly deduplicates retries.

## TextBee

`src/sms-providers/textbee-sms-provider.ts` implements the first real provider adapter against the official TextBee API ([API reference](https://textbee.dev/docs/api-reference), [OpenAPI specification](https://textbee.dev/openapi.json)). TextBee turns an Android phone you own into an SMS gateway; the API key comes from the TextBee dashboard and messages are delivered by the paired Android device. Only documented API behavior is implemented.

### Configuration (environment only)

- `TEXTBEE_ENABLED` — default `false`; the adapter is registered only when explicitly enabled.
- `TEXTBEE_BASE_URL` — default `https://api.textbee.dev/api/v1`.
- `TEXTBEE_API_KEY` — the TextBee dashboard API key; sent only as the documented `x-api-key` header. Never stored in the database, admin UI, dashboard, SDK responses, logs or webhooks; production rejects an enabled adapter without a real key.
- `TEXTBEE_TIMEOUT_MS` — request timeout, default 30000.
- `TEXTBEE_DEVICE_ID` — optional; sent as the documented `deviceId` to pin sends to one Android device. Without it TextBee selects the default device or the enabled device with the most recent heartbeat (documented behavior).
- `TEXTBEE_SIM_SUBSCRIPTION_ID` — optional; sent as the documented numeric `simSubscriptionId` to choose the SIM.

Admins register a matching `textbee` provider row (`POST /v1/admin/sms/providers`) and reference it from services as primary and/or fallback. The admin provider view shows enabled/configured status, health, capabilities, timeout, request statistics and the non-secret device/SIM configuration status (`deviceIdConfigured`, `simSubscriptionConfigured`).

### Capabilities (documented, not assumed)

- `sendSms: true` — mapped from Tariffia's destination and rendered message to the documented `POST /gateway/send-sms` body `{recipients: [to], message}` plus the optional configured `deviceId`/`simSubscriptionId`. Nothing else is sent; the documented API has no idempotency-key field.
- `sendOtp: false` — TextBee documents a plain send endpoint only, so Tariffia renders OTP messages server-side and delivers them as ordinary SMS through the same flow.
- `reportsSegments: false` — the send response documents no segment count (long messages are split by the carrier), so Tariffia's own GSM-7/UCS-2 segment estimate settles the charge and usage is marked `estimated`.
- `reportsProviderCost: false` — the API reports no per-message provider cost, so the service's configured provider cost is recorded and no cost is invented.
- `idempotentRetries: false` — the documented send request accepts no idempotency key and the API documents no request deduplication. A timeout is therefore an ambiguous outcome: Tariffia never automatically retries or falls back from it, and the same SMS is never sent twice because of an uncertain TextBee response. Phase 19 fallback still applies after provably safe failures (`rate_limited` with the parsed `Retry-After` hint, `unavailable`, or definitive non-acceptance).

### Response normalization

The documented queued send outcome `{ data: { success, message, smsBatchId, recipientCount } }` is normalized with `smsBatchId` as the provider message identifier (stored as `provider_message_id` for auditing; it can be used against TextBee's documented batch endpoints out of band). The documented immediate-dispatch shape (`successCount`/`failureCount`, no batch identifier) is accepted without inventing an identifier. `success: false` or a definitive `successCount: 0, failureCount: 1` maps to a safe rejection; any other shape is an ambiguous `invalid_response` and is never retried.

### Error mapping (documented statuses)

- 401 → `unauthorized` (missing/invalid/revoked API key)
- 400 → `invalid_request` (no enabled device, device disabled, email not verified, or the message could not be pushed — never retried, so no duplicate risk; configure a fallback provider if this recurs)
- 429 → `rate_limited` with the parsed `Retry-After` hint preserved in the attempt trail (documented rate limit: 60 sends/min, plus daily/monthly plan limits)
- 404 → `not_found`
- 5xx → `unavailable`
- Timeout → `timeout` (ambiguous, never retried for TextBee)
- Malformed/undocumented response → `invalid_response` (ambiguous, never retried)

Raw TextBee error bodies, the API key and message content are never exposed to merchants or persisted.

### Health check

Health uses the documented read-only `GET /gateway/devices` endpoint — it never sends an SMS. It verifies the credential (401 detection), reachability, and device usability: with `TEXTBEE_DEVICE_ID` configured, the device must exist and be enabled on the account; without it, at least one enabled device must exist. Heartbeat recency is deliberately not judged (TextBee documents it only as a "likely offline" hint); a reachable-but-unhealthy account is reported to administrators through the existing provider health status and request statistics.

## Adding a provider

1. Implement `SmsProvider` under `src/sms-providers/`, validating configuration in `initialize()`. Keep credentials in server environment/secret storage; never in manifests, database rows or responses. See `src/sms-providers/textbee-sms-provider.ts` for a complete real-adapter example.
2. Declare exactly the capabilities you implement. Declare `idempotentRetries` only for a provable upstream deduplication guarantee, and `sendOtp` only for native OTP delivery.
3. Normalize every failure into `SmsProviderError` kinds with canonical messages; never surface raw provider text, message content or credentials.
4. Register it in the process registry (`src/sms-providers/default-registry.ts` or a deployment-specific setup) with an explicit enabled flag and a settings object.
5. Create a matching `sms_providers` row through `POST /v1/admin/sms/providers` (slug = registry ID) and reference it from services as primary and/or fallback.
6. Add provider tests for configuration, health, normalization, timeout handling and idempotency, plus integration tests for selection, disabled/unhealthy/unconfigured gating and the fallback rules above.

The admin surface is `GET/POST /v1/admin/sms/providers`, `POST /v1/admin/sms/providers/:id/health`, `GET /v1/admin/sms/services`, `GET /v1/admin/sms/requests` and `GET /v1/admin/sms/usage`. Providers expose name, enabled, configured, health, capabilities, timeout, last health result, request/success/failure counts, average latency and attempt trails — never API keys, bearer tokens, secrets, OTP codes or message content.
