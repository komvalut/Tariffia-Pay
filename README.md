# Tariffia Pay

Self-hosted, non-custodial merchant payment infrastructure. The payment core owns merchants, customers, orders, payments and the immutable transaction ledger. Chain-specific behavior belongs behind payment adapters; USDC on Base is the first adapter and is implemented in Phase 2.

## Phase 1-3 status

Implemented: PostgreSQL schema/migrations, admin-provisioned merchants, hashed merchant API keys, customers, idempotent order/payment creation, append-only ledger, Base USDC verification, hosted checkout, payment links and QR payments. Webhooks, credits, AI pricing, subscriptions and the admin dashboard are later phases.

## Run locally

Requirements: Node.js 20+ and Docker Compose.

```sh
cp .env.example .env
# Replace POSTGRES_PASSWORD, ADMIN_API_KEY and API_KEY_PEPPER with independent random secrets.
docker compose up --build
```

The API listens on `http://localhost:8080`. `GET /health` verifies API and database availability. PostgreSQL migrations run automatically on startup.

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
- Public checkout: `GET /p/:paymentId`
- Public checkout details/status: `GET /v1/public/payments/:paymentId`
- Public customer verification: `POST /v1/public/payments/:paymentId/verify`
- Checkout QR image: `GET /p/:paymentId/qr.png`

Create a shareable link from the merchant API:

```sh
curl -X POST http://localhost:8080/v1/payment-links \
  -H 'content-type: application/json' -H 'authorization: Bearer tf_live_REPLACE_ME' \
  -H 'idempotency-key: hosted-checkout-0001' \
  -d '{"description":"Digital item","amount":"12.00","currency":"USDC"}'
```

The response contains `checkoutUrl` and `qrUrl`. The QR encodes that same `checkoutUrl`; it resolves to the server-owned payment ID and canonical payment details. The hosted page is responsive and supports EIP-1193 wallets on Base.
- `GET /v1/customers/:customerId`
- `GET /v1/ledger?limit=50`
- `GET /v1/api-keys`, `POST /v1/api-keys`, `DELETE /v1/api-keys/:keyId`

Every merchant-owned read is scoped to the authenticated merchant. The ledger database trigger rejects updates and deletes.

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

## Security and custody

- The admin credential and API-key pepper are server-only environment secrets.
- Merchant API keys are shown once and stored only as HMAC-SHA256 hashes.
- Phase 1 does not hold or sign with customer or merchant private keys.
- The frontend never determines payment status. Only the configured chain adapter can confirm a payment after independent server-side verification.

## Architecture

`src/payment-adapter.ts` defines the chain boundary without coupling order/payment records to a chain SDK. `src/adapters/usdc/` contains the Base USDC implementation; `src/services/payment-core-service.ts` owns idempotent order/payment creation; `src/services/payment-verification-service.ts` coordinates atomic payment/order/ledger updates; transaction detection and checkout rendering are separate from merchant routes. `src/modules/` keeps merchant, customer, order, payment, payment-link, checkout, API-key and ledger routes separate; `src/app.ts` only composes them. PostgreSQL schema is versioned under `migrations/`.

## Development checks

```sh
npm test
npm run typecheck
npm run build
```

## License

MIT. See `LICENSE`.
