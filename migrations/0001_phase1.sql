CREATE TABLE IF NOT EXISTS merchants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  wallet_address text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS merchants_email_unique_idx ON merchants (lower(email));

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash char(64) NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['payments:write', 'orders:write', 'customers:write', 'ledger:read'],
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  external_id text,
  email text,
  name text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, external_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  customer_id uuid REFERENCES customers(id),
  reference text,
  description text NOT NULL,
  amount numeric(36, 6) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'USDC',
  status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, reference)
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  amount numeric(36, 6) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'USDC',
  adapter text NOT NULL DEFAULT 'usdc',
  network text NOT NULL DEFAULT 'base',
  recipient_address text NOT NULL,
  token_address text,
  status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PENDING', 'DETECTED', 'VERIFYING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'REFUNDED')),
  tx_hash text,
  idempotency_key text NOT NULL,
  expires_at timestamptz,
  detected_at timestamptz,
  confirmed_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, idempotency_key),
  UNIQUE (network, tx_hash)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash varchar(64) NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  order_id uuid REFERENCES orders(id),
  payment_id uuid REFERENCES payments(id),
  entry_type text NOT NULL,
  amount numeric(36, 6) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL,
  reference text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_merchant_created_idx ON orders (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_merchant_created_idx ON payments (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_merchant_created_idx ON ledger_entries (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_keys_merchant_idx ON api_keys (merchant_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
