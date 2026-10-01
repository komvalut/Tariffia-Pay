ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_event_type_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_event_type_check CHECK (event_type IN (
  'payment.created', 'payment.detected', 'payment.confirmed', 'payment.failed', 'payment.expired', 'order.paid',
  'credit.topup', 'credit.deducted', 'ai.usage.recorded', 'invoice.issued', 'receipt.issued',
  'subscription.created', 'subscription.activated', 'subscription.paused', 'subscription.resumed',
  'subscription.cancelled', 'subscription.past_due', 'subscription.expired',
  'subscription.billing_cycle.created', 'subscription.billing_cycle.paid', 'subscription.billing_cycle.failed'
));

CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  amount numeric(36, 6) NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  billing_interval text NOT NULL CHECK (billing_interval IN ('DAY', 'WEEK', 'MONTH', 'YEAR')),
  interval_count integer NOT NULL CHECK (interval_count BETWEEN 1 AND 12),
  trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  plan_name text NOT NULL,
  payment_method text NOT NULL,
  billing_mode text NOT NULL CHECK (billing_mode IN ('MANUAL', 'AUTOMATIC')),
  amount numeric(36, 6) NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  billing_interval text NOT NULL CHECK (billing_interval IN ('DAY', 'WEEK', 'MONTH', 'YEAR')),
  interval_count integer NOT NULL CHECK (interval_count BETWEEN 1 AND 12),
  trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED', 'PAST_DUE')),
  starts_at timestamptz NOT NULL,
  trial_ends_at timestamptz,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  next_billing_at timestamptz NOT NULL,
  ends_at timestamptz,
  creation_key_hash char(64) NOT NULL,
  creation_request_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, creation_key_hash)
);

CREATE TABLE IF NOT EXISTS subscription_billing_cycles (
  id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  cycle_number integer NOT NULL CHECK (cycle_number > 0),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  amount numeric(36, 6) NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  status text NOT NULL CHECK (status IN ('CREATING', 'PENDING', 'PAID', 'FAILED', 'EXPIRED')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, cycle_number)
);

CREATE TABLE IF NOT EXISTS subscription_billing_attempts (
  id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  billing_cycle_id uuid NOT NULL REFERENCES subscription_billing_cycles(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  request_key_hash char(64),
  core_idempotency_key char(64) NOT NULL UNIQUE,
  order_id uuid UNIQUE REFERENCES orders(id),
  payment_id uuid UNIQUE REFERENCES payments(id),
  status text NOT NULL CHECK (status IN ('CREATING', 'PENDING', 'PAID', 'FAILED', 'EXPIRED')),
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (billing_cycle_id, attempt_number),
  UNIQUE (subscription_id, request_key_hash)
);

CREATE INDEX IF NOT EXISTS subscriptions_merchant_created_idx ON subscriptions (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscriptions_customer_created_idx ON subscriptions (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscriptions_auto_due_idx ON subscriptions (next_billing_at)
  WHERE status = 'ACTIVE' AND billing_mode = 'AUTOMATIC';
CREATE INDEX IF NOT EXISTS subscription_cycles_subscription_idx ON subscription_billing_cycles (subscription_id, cycle_number DESC);
CREATE INDEX IF NOT EXISTS subscription_attempts_subscription_idx ON subscription_billing_attempts (subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_attempts_payment_idx ON subscription_billing_attempts (payment_id) WHERE payment_id IS NOT NULL;
