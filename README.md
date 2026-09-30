# Tariffia Pay

Self-hosted, non-custodial merchant payment infrastructure. The payment core owns merchants, customers, orders, payments and the immutable transaction ledger. Chain-specific behavior belongs behind payment adapters; USDC on Base is the first adapter and is implemented in Phase 2.

## Phase 1 status

Implemented: project foundation, PostgreSQL schema/migrations, admin-provisioned merchants, hashed merchant API keys, customers, idempotent order/payment creation, payment and order lookup, and an append-only ledger. On-chain verification, checkout, links, QR, webhooks, credits, AI pricing and dashboard are later phases.

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
- `GET /v1/customers/:customerId`
- `GET /v1/ledger?limit=50`
- `GET /v1/api-keys`, `POST /v1/api-keys`, `DELETE /v1/api-keys/:keyId`

Every merchant-owned read is scoped to the authenticated merchant. The ledger database trigger rejects updates and deletes.

## Security and custody

- The admin credential and API-key pepper are server-only environment secrets.
- Merchant API keys are shown once and stored only as HMAC-SHA256 hashes.
- Phase 1 does not hold or sign with customer or merchant private keys.
- Phase 1 payment status is only `PENDING`; frontend claims cannot confirm a payment. Independent chain verification arrives in Phase 2.

## Architecture

`src/payment-adapter.ts` defines the chain boundary without coupling order/payment records to a chain SDK. `src/modules/` keeps merchant, customer, order, payment, API-key and ledger routes separate; `src/app.ts` only composes them. PostgreSQL schema is versioned under `migrations/`.

## Development checks

```sh
npm test
npm run typecheck
npm run build
```

## License

MIT. See `LICENSE`.
