#!/usr/bin/env sh
set -eu

: "${TARIFFIA_BASE_URL:=http://localhost:8080}"
: "${TARIFFIA_API_KEY:?Set TARIFFIA_API_KEY in the server environment}"
: "${CUSTOMER_ID:?Set CUSTOMER_ID to an existing customer UUID}"

# Create an order and payment atomically. Reuse the same key only for retries.
curl -sS -X POST "$TARIFFIA_BASE_URL/v1/orders" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: sdk-order-1234-001' \
  -d '{"customerId":"'"$CUSTOMER_ID"'","description":"Integration example","amount":"8.25","currency":"USDC"}'

# Create a hosted checkout link through the same Payment Core.
curl -sS -X POST "$TARIFFIA_BASE_URL/v1/payment-links" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: sdk-link-1234-001' \
  -d '{"customerId":"'"$CUSTOMER_ID"'","description":"Checkout example","amount":"8.25","currency":"USDC"}'

# Read verified payment state and submit a transaction hash for server verification.
curl -sS "$TARIFFIA_BASE_URL/v1/payments/PAYMENT_UUID" \
  -H "authorization: Bearer $TARIFFIA_API_KEY"
curl -sS -X POST "$TARIFFIA_BASE_URL/v1/payments/PAYMENT_UUID/verify" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" -H 'content-type: application/json' \
  -d '{"transactionHash":"0xTRANSACTION_HASH"}'

# Read a customer balance and start a USDC-backed credit top-up.
curl -sS "$TARIFFIA_BASE_URL/v1/credits/$CUSTOMER_ID/balance" \
  -H "authorization: Bearer $TARIFFIA_API_KEY"
curl -sS -X POST "$TARIFFIA_BASE_URL/v1/credits/topups" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" -H 'content-type: application/json' \
  -H 'idempotency-key: sdk-topup-1234-001' \
  -d '{"customerId":"'"$CUSTOMER_ID"'","amount":"5.00"}'

# Inspect enabled AI model pricing, then report usage produced by your own backend integration.
curl -sS "$TARIFFIA_BASE_URL/v1/ai/models" \
  -H "authorization: Bearer $TARIFFIA_API_KEY"
curl -sS -X POST "$TARIFFIA_BASE_URL/v1/ai/usage" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" -H 'content-type: application/json' \
  -d '{"requestId":"ai-request-1234","customerId":"'"$CUSTOMER_ID"'","provider":"example-ai","model":"text-small","inputTokens":1200,"outputTokens":450}'

# Webhook endpoint secrets are supplied by your backend and are never returned by the API.
curl -sS -X POST "$TARIFFIA_BASE_URL/v1/webhooks" \
  -H "authorization: Bearer $TARIFFIA_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"Orders","url":"https://merchant.example/hooks/tariffia","events":["payment.confirmed","credit.topup","ai.usage.recorded"],"secret":"REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS"}'
