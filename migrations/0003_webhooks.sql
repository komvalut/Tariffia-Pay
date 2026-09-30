CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  name text NOT NULL,
  url text NOT NULL,
  events text[] NOT NULL,
  secret_ciphertext text NOT NULL,
  secret_nonce text NOT NULL,
  secret_auth_tag text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  event_type text NOT NULL CHECK (event_type IN (
    'payment.created', 'payment.detected', 'payment.confirmed', 'payment.failed', 'payment.expired', 'order.paid'
  )),
  resource_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id),
  event_id uuid NOT NULL REFERENCES webhook_events(id),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'DELIVERING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_http_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);

CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES webhook_deliveries(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  request_timestamp bigint NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  http_status integer,
  error text,
  response_excerpt text,
  UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_merchant_idx ON webhook_endpoints (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_events_merchant_idx ON webhook_events (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_expiration_due_idx ON payments (expires_at)
  WHERE status = 'PENDING' AND tx_hash IS NULL;
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at, created_at)
  WHERE status IN ('QUEUED', 'RETRYING');
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_attempts_delivery_idx ON webhook_delivery_attempts (delivery_id, attempt_number DESC);
