ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_event_type_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_event_type_check CHECK (event_type IN (
  'payment.created', 'payment.detected', 'payment.confirmed', 'payment.failed',
  'payment.expired', 'order.paid', 'credit.topup', 'credit.deducted'
));

CREATE TABLE IF NOT EXISTS credit_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  credits_per_usdc_rate integer NOT NULL CHECK (credits_per_usdc_rate > 0),
  minimum_topup_usdc numeric(36, 6) NOT NULL CHECK (minimum_topup_usdc > 0),
  maximum_topup_usdc numeric(36, 6) NOT NULL CHECK (maximum_topup_usdc >= minimum_topup_usdc),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_accounts (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  balance_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (balance_units >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, customer_id)
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  account_id uuid NOT NULL REFERENCES credit_accounts(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  transaction_type text NOT NULL CHECK (transaction_type IN ('TOPUP', 'DEDUCTION')),
  credit_units numeric(78, 0) NOT NULL CHECK (credit_units > 0),
  balance_after_units numeric(78, 0) NOT NULL CHECK (balance_after_units >= 0),
  reference text,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS credit_topups (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  account_id uuid NOT NULL REFERENCES credit_accounts(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id),
  amount_usdc numeric(36, 6) NOT NULL CHECK (amount_usdc > 0),
  credit_units numeric(78, 0) NOT NULL CHECK (credit_units > 0),
  credits_per_usdc_rate integer NOT NULL CHECK (credits_per_usdc_rate > 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CREDITED', 'FAILED', 'EXPIRED')),
  idempotency_key text NOT NULL,
  credit_transaction_id uuid REFERENCES credit_transactions(id),
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  credited_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS credit_accounts_merchant_idx ON credit_accounts (merchant_id, customer_id);
CREATE INDEX IF NOT EXISTS credit_transactions_account_idx ON credit_transactions (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credit_transactions_merchant_idx ON credit_transactions (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credit_topups_customer_idx ON credit_topups (merchant_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credit_topups_pending_idx ON credit_topups (payment_id) WHERE status = 'PENDING';
