# Tariffia Pay — Merchant Integration Guide

A task-oriented guide from "I have a merchant account" to "I created a payment
and verified a webhook". It describes the **existing** API and SDK only; no new
routes or behavior are introduced.

- [0. Concepts](#0-concepts)
- [1. Provision a merchant and get an API key](#1-provision-a-merchant-and-get-an-api-key)
- [2. Authenticate and scope keys](#2-authenticate-and-scope-keys)
- [3. Create a customer](#3-create-a-customer)
- [4. Create an order or a payment link](#4-create-an-order-or-a-payment-link)
- [5. Present the hosted checkout and QR](#5-present-the-hosted-checkout-and-qr)
- [6. How payment verification works](#6-how-payment-verification-works)
- [7. Register a webhook and verify signatures](#7-register-a-webhook-and-verify-signatures)
- [8. Reconcile with payments, transactions and revenue](#8-reconcile-with-payments-transactions-and-revenue)
- [9. Test locally](#9-test-locally)
- [10. Go live](#10-go-live)

See [`QUICKSTART.md`](QUICKSTART.md) to run Tariffia locally and
[`../PRODUCTION.md`](../PRODUCTION.md) for deployment, backups and upgrades. The
official TypeScript SDK is documented in [`../sdk/README.md`](../sdk/README.md).

---

## 0. Concepts

- **Non-custodial.** Tariffia never holds or signs with private keys. A payment
  is an ERC-20 transfer sent directly from the customer's wallet to the
  merchant's `walletAddress`.
- **Adapter-based.** Chain behavior lives behind a payment adapter. USDC on Base
  is the first adapter; Lightning (LND REST) is available but disabled by
  default. Additional methods are separate adapters.
- **Payment Core owns records.** Merchants, customers, orders, payments and the
  append-only ledger are the source of truth. Invoices/receipts, revenue, usage
  and the audit log are read directly from those records.
- **Server-authoritative verification.** The browser never decides whether a
  payment succeeded. Only the configured adapter confirms a payment after
  independent server-side verification.

Roles:

- **Admin** uses the server-side `x-admin-api-key` header (never sent to a
  browser) to provision merchants.
- **Merchant** uses `Authorization: Bearer <merchant-api-key>` for all
  merchant-scoped calls.

---

## 1. Provision a merchant and get an API key

Merchants are created out of band by the operator with the admin credential:

```sh
curl -X POST "$TARIFFIA_BASE_URL/v1/admin/merchants" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"Example Store","email":"owner@example.com","walletAddress":"0x1111111111111111111111111111111111111111"}'
```

The response contains the merchant **and a merchant API key once**:

```json
{ "merchant": { "id": "...", "status": "active", "...": "..." },
  "apiKey": "tf_live_...", "warning": "Store this API key now. It will not be shown again." }
```

Store it securely (server-side secret store or environment variable). Tariffia
retains only a peppered HMAC hash, never the plaintext key.

`walletAddress` is the direct payment recipient for USDC on Base.

---

## 2. Authenticate and scope keys

Every merchant request uses:

```
Authorization: Bearer tf_live_...
```

Keys carry **scopes** of the form `<area>:<read|write>`, where a `write` scope
also grants the matching `read` scope. Areas: `orders`, `payments`, `customers`,
`credits`, `ai`, `sms`, `webhooks`, `subscriptions`, `revenue`, `settings`,
`notifications`, `usage`, `api-keys`, `documents`, `ledger`, `audit`,
`dashboard`. A key missing the scope required by a route gets
`403 insufficient_scope`.

- Create additional, narrower keys with `POST /v1/api-keys` and an optional
  `scopes` array. When omitted, the key receives the full default catalogue.
- Revoke a key immediately with `DELETE /v1/api-keys/:keyId`.
- Keys issued before scope enforcement are grandfathered as full access.

```sh
curl -X POST "$TARIFFIA_BASE_URL/v1/api-keys" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"checkout-server","scopes":["orders:write","customers:read"]}'
```

The plaintext secret is returned **once** in the response (`secret`). Never log
it or ship it to a browser.

---

## 3. Create a customer

`POST /v1/customers` is idempotent and merchant-scoped:

```sh
curl -X POST "$TARIFFIA_BASE_URL/v1/customers" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"externalId":"customer-42","email":"buyer@example.com","name":"Buyer"}'
```

Identity resolution: an explicit `externalId` match wins; otherwise the request
matches by normalized `email` (trimmed, lowercased). Repeating the same request
returns the existing customer instead of creating a duplicate.

---

## 4. Create an order or a payment link

Both go through the same Payment Core. A stable `Idempotency-Key` is required;
retrying the same request with the same key returns the original result, and
reusing a key with a different body returns `409`.

```sh
curl -X POST "$TARIFFIA_BASE_URL/v1/orders" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: checkout-order-0001' \
  -d '{"customerId":"CUSTOMER_UUID","description":"Coffee","amount":"4.50","currency":"USDC"}'
```

Response (idempotent):

```json
{ "order": { "id": "...", "status": "PENDING" },
  "payment": { "id": "...", "status": "PENDING", "network": "base", "recipientAddress": "0x..." },
  "checkoutUrl": "https://.../p/PAYMENT_UUID", "qrUrl": "https://.../p/PAYMENT_UUID/qr.png" }
```

Use `POST /v1/payment-links` for the same body when you want a hosted link
directly. Create minimum fields: `description` and `amount`.

---

## 5. Present the hosted checkout and QR

- `GET /p/:paymentId` — hosted checkout page (public, no auth).
- `GET /p/:paymentId/qr.png` — QR image encoding the same checkout URL.
- `GET /v1/public/payments/:paymentId` — a limited public payment view.

The hosted page supports an injected EIP-1193 browser wallet that sends the exact
ERC-20 transfer directly to the merchant, then polls for status. The browser
submits the transaction hash only as a hint; the server remains authoritative.
Never send merchant keys or private keys to the browser.

---

## 6. How payment verification works

1. The customer sends the ERC-20 transfer on-chain to the merchant wallet.
2. Your backend records/relays the transaction hash (never trust the browser).
3. `POST /v1/payments/:paymentId/verify` runs server-side verification:

```sh
curl -X POST "$TARIFFIA_BASE_URL/v1/payments/PAYMENT_UUID/verify" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"transactionHash":"0x..."}'
```

On success the payment moves through `DETECTED`/`VERIFYING` to `CONFIRMED` and,
in the same transaction, the order is marked `PAID`, the ledger records immutable
entries, and invoices/receipts are issued. Verification is idempotent: re-verifying
a confirmed payment reports `alreadyConfirmed`.

A payment can also self-confirm via the background USDC detector when a matching
transfer appears on-chain. Always treat `CONFIRMED` as the settled state.

> No real funds are needed to exercise this logic locally — the automated smoke
> test injects a mock adapter (see [Test locally](#9-test-locally)).

---

## 7. Register a webhook and verify signatures

Register an endpoint with the events you want. The signing `secret` (≥ 32 chars)
is stored encrypted and never returned.

```sh
curl -X POST "$TARIFFIA_BASE_URL/v1/webhooks" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"Order notifications","url":"https://merchant.example/hooks/tariffia","events":["payment.confirmed","payment.failed"],"secret":"merchant-owned-secret-at-least-32-chars"}'
```

Delivered requests carry:

- `x-tariffia-signature: t=<unix>,v1=<hex hmac-sha256>`
- `x-tariffia-timestamp: <unix>`

The signed input is `` `${timestamp}.${rawBody}` `` using HMAC-SHA256 with your
secret. **Verify against the exact raw body before parsing JSON**, apply a
timestamp tolerance, and deduplicate event IDs durably.

Webhook event payload shape:

```json
{ "id": "event-uuid", "type": "payment.confirmed", "createdAt": "ISO-8601", "data": { "paymentId": "...", "...": "..." } }
```

Verify with the SDK helper (`verifyWebhookSignature`) — see
[`../sdk/README.md`](../sdk/README.md#webhook-handler) and
[`merchant-flow.mjs`](../sdk/examples/merchant-flow.mjs). A runnable handler is in
[`webhook.mjs`](../sdk/examples/webhook.mjs).

Manage endpoints and inspect deliveries:

- `GET /v1/webhooks` (paginated), `PATCH /v1/webhooks/:endpointId`,
  `DELETE /v1/webhooks/:endpointId`
- `GET /v1/webhooks/:endpointId/deliveries` (paginated)

Delivery is signed, retried with backoff up to a configured maximum, and each
attempt is logged.

---

## 8. Reconcile with payments, transactions and revenue

- `GET /v1/payments/:paymentId` — payment status and identifiers.
- `GET /v1/payments/:paymentId/details` — payment + order + invoice/receipt.
- `GET /v1/transactions` — merchant-facing view over payments (filters:
  `status`, `network`).
- `GET /v1/revenue/summary` and `GET /v1/revenue/history` — read-only revenue.
- `GET /v1/invoices`, `GET /v1/receipts` — billing documents (and `.pdf`).
- `GET /v1/ledger` — append-only ledger entries.
- `GET /v1/audit-log` — append-only record of important account actions.

List endpoints use a shared pagination contract: `limit` (default 50, 1–100) and
`offset` (default 0), returning a `pagination` object
`{ limit, offset, count, hasMore }`. Invalid values return
`400 invalid_pagination`. All results are scoped to the authenticated merchant.

---

## 9. Test locally

- **No setup:** `npm test -- tests/production-smoke.test.ts` runs the complete
  payment flow on an in-memory database with a deterministic mock USDC adapter
  (no funds, no chain). See [`QUICKSTART.md`](QUICKSTART.md).
- **Hands-on:** run the server and use `scripts/smoke-demo.mjs`:
  `ADMIN_API_KEY=... BASE_URL=http://localhost:8080 node scripts/smoke-demo.mjs`.
- **SDK example:** [`../sdk/examples/merchant-flow.mjs`](../sdk/examples/merchant-flow.mjs)
  shows order creation + webhook verification end to end.

---

## 10. Go live

1. Set `PUBLIC_BASE_URL` to your public HTTPS origin.
2. Provision the production merchant with a real `walletAddress`.
3. Point `BASE_RPC_URL` at a trusted HTTPS Base endpoint; set
   `USDC_MIN_CONFIRMATIONS`.
4. Register production webhooks with a strong secret and durable deduplication.
5. Harden and operate per [`../PRODUCTION.md`](../PRODUCTION.md): secrets,
   TLS reverse proxy, migrations, backups/restore, health/readiness and upgrades.
6. Verify `/health` (liveness) and `/ready` (readiness) from your orchestrator.

---

## Appendix: Admin API (operator-only)

The operator endpoints under the v1/admin namespace are documented in the
same `GET /openapi.json` document (tagged **Admin**) so the API contract is
complete. They are **not** part of the merchant integration surface and are
**not** in the merchant SDK:

- Authenticate with the server-side `x-admin-api-key` header, never a merchant
  bearer key, and never from a browser.
- They cover merchant provisioning, platform dashboards, credits, AI/SMS
  provider administration, usage limits, webhook delivery inspection,
  subscriptions, invoices/receipts, the global audit log and payment-adapter
  status. Provider credentials are read from server environment only and are
  never accepted in request bodies or returned.
- See `GET /docs` for the rendered reference and filter by the **Admin** tag.
