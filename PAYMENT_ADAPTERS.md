# Payment Adapter Architecture

Payment rails plug in at `PaymentAdapterRegistry`. Payment Core selects an enabled adapter, passes it a stable idempotency key, and persists its normalized payment details. Verification dispatches back to the adapter recorded on that payment. Orders, ledger entries, credit lifecycle hooks, and webhooks consume common currency, network, state, and transaction fields; they do not call rail SDKs.

## Contract

Implement `PaymentAdapter` from `src/payment-adapter.ts`:

- `manifest` declares a stable lowercase ID, display name, version, supported currencies/networks, capabilities, and idempotency guarantees.
- `initialize(settings)` validates adapter-only configuration and opens resources. `shutdown()` releases them. Both run through registry lifecycle handling.
- `health()` returns only a bounded health state/message. Do not include URLs, credentials, provider responses, or configuration values.
- `createRequest()` returns the adapter ID, network, currency, canonical recipient, nullable token address, positive integer `amountBaseUnits`, and private `adapterData`.
- `verifyTransaction()` returns `not_found`, `rejected`, `pending`, `failed`, or `verified`. Pending/failed/verified results carry the common `PaymentReceipt`: transaction ID, network, state, amount, currency, recipient, confirmations, and nullable decimal-string block number.

The payment lifecycle states are `PENDING`, `DETECTED`, `CONFIRMED`, and `FAILED`. The API/database additionally retain existing order/payment lifecycle values such as `EXPIRED` and `REFUNDED`. Adapters must not invent new payment states.

Payment creation receives a server-generated stable `idempotencyKey`, derived from the merchant request's idempotency key and scope. Use it for any external resource creation. Repeating creation with that key must not create a second external payment. `normalizeTransactionId()` defines each adapter's canonical identifier representation; the canonical value is used for persistence, idempotency checks and verification, with uniqueness enforced by network and transaction ID. Base USDC lowercases EVM hashes; case-sensitive rails can preserve case. Adapter-specific retry/error details should be normalized to `PaymentAdapterError` codes, and raw provider messages must not be returned to callers.

`adapterData` and runtime `settings` are server-side only. The registry's admin summary exposes installed/enabled status, manifest capabilities, idempotency guarantees, lifecycle, and bounded health; it never serializes settings. Normal payment/API responses omit `adapterData`.

## Adding An Adapter

1. Add an implementation under `src/adapters/<rail>/` and validate its configuration in `initialize()`. Keep credentials in server configuration/secret storage, not in manifests or payment responses.
2. Declare only the currencies, networks, and operations the implementation supports. Return integer amount units and normalized receipts, and throw/return normalized failures without leaking provider details.
3. Register it in the composition root (`src/payment-adapters/default-registry.ts` or the deployment-specific registry setup) with an explicit enabled flag, a settings object, and `isDefault` only if it should receive requests that omit `adapter`.
4. Add adapter tests for configuration, request details, receipt normalization, health, errors, and stable idempotency. Add integration tests for selection and the disabled state.
5. Build and run the existing checks. Inspect `GET /v1/admin/payment-adapters` with the admin key to confirm the manifest and health summary; no adapter settings are returned.

`GET /v1/public/payment-methods` returns only enabled, healthy methods suitable for checkout. Select one on order/payment-link creation with the optional `adapter` field; omitting it selects the configured default. The hosted checkout renders the chosen method's presentation (wallet transfer or invoice) and does not switch an already-created payment to a second rail. Unknown or disabled methods cannot create new payments. Disabling a method does not remove its registration: existing payments remain readable, and verification of existing non-terminal payments can continue while the adapter is installed and initialized.

## Base USDC

Base USDC remains the default and retains its Base RPC, six-decimal amount checks, exact token/recipient/amount verification, confirmation-depth checks, reverted-transfer handling, and automatic transfer scanner. Set `USDC_ADAPTER_ENABLED=false` to stop new Base USDC payment requests; re-enable it to accept new requests again. This does not disable verification/reading for existing payments.

## Lightning Provider

Bitcoin Lightning is registered and disabled by default (`LIGHTNING_ADAPTER_ENABLED=false`). `src/adapters/lightning-provider.ts` defines the backend boundary; `src/adapters/lnd-rest-provider.ts` implements LND REST invoice creation and lookup. The default composition installs LND REST only when `LIGHTNING_PROVIDER_TYPE=lnd-rest`; no credentials or URLs are hard-coded. Core Lightning or another compatible backend can be added behind the same interface.

For an LND REST node, configure these values only in the server environment or secret manager:

- `LIGHTNING_ADAPTER_ENABLED=true`
- `LIGHTNING_PROVIDER_TYPE=lnd-rest`
- `LIGHTNING_PROVIDER_URL=https://<private-node-or-proxy>/`
- `LIGHTNING_PROVIDER_MACAROON=<hex-encoded-restricted-invoice-and-info-macaroon>`
- `LIGHTNING_PROVIDER_IDEMPOTENCY_SECRET=<independent-random-32-byte-hex-secret>`
- `LIGHTNING_PROVIDER_TIMEOUT_MS=5000`

Keep the idempotency secret stable across restarts; it derives a deterministic invoice preimage so a retry after a lost response looks up the existing invoice rather than creating another. Use a least-privilege macaroon with only the required invoice and node-info permissions. Production remote endpoints require HTTPS; credentials in provider URLs, query strings, and fragments are rejected. Local loopback HTTP is allowed for a node on the same host. Provider credentials are never included in adapter summaries, payment responses, or provider error messages. Keep `.env.production` mode `0600` and do not commit it.

Payment amounts are whole SAT and `amountBaseUnits` is millisatoshis. The BOLT11 payment request is returned through the generic `recipientAddress` field; the normalized transaction ID is the invoice payment hash. LND `OPEN`/`ACCEPTED` maps to pending, `SETTLED` is verified only after matching invoice hash, invoice amount, paid amount and expiry, and `CANCELED` is rejected. No Lightning payout/send operation is implemented. The in-memory provider exists only under `tests/`.

The adapter maps provider `pending` status to the common pending state and `settled` to verified only when the paid millisatoshi amount matches the invoice. Expired/cancelled invoices are rejected without confirming the payment. Provider exceptions are normalized and their messages are not returned to API clients.

The admin endpoint is `GET /v1/admin/payment-adapters`. It requires the existing admin API key.
