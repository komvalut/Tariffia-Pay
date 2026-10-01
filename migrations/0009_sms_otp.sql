ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_event_type_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_event_type_check CHECK (event_type IN (
  'payment.created', 'payment.detected', 'payment.confirmed', 'payment.failed', 'payment.expired', 'order.paid',
  'credit.topup', 'credit.deducted', 'ai.usage.recorded', 'invoice.issued', 'receipt.issued',
  'subscription.created', 'subscription.activated', 'subscription.paused', 'subscription.resumed',
  'subscription.cancelled', 'subscription.past_due', 'subscription.expired',
  'subscription.billing_cycle.created', 'subscription.billing_cycle.paid', 'subscription.billing_cycle.failed',
  'ai.request.completed', 'ai.request.failed',
  'sms.request.completed', 'sms.request.failed'
));

-- Provider integration is configured server-side. Only non-secret configuration lives here;
-- the delivery credential is read from the process environment and never stored.
CREATE TABLE IF NOT EXISTS sms_providers (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  integration text NOT NULL DEFAULT 'http-sms',
  credential_source text NOT NULL DEFAULT 'environment'
    CHECK (credential_source IN ('environment')),
  timeout_ms integer CHECK (timeout_ms IS NULL OR timeout_ms BETWEEN 1000 AND 120000),
  last_status text,
  last_status_message text,
  last_health_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Tariffia-owned SMS/OTP products. The customer selects a service; Tariffia chooses
-- the configured provider. Pricing reuses the existing fixed-point USD pricing model.
CREATE TABLE IF NOT EXISTS sms_services (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES sms_providers(id),
  slug text NOT NULL,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'otp_sms' CHECK (type IN ('otp_sms')),
  enabled boolean NOT NULL DEFAULT true,
  customer_price_per_sms_usd numeric(28, 8) CHECK (customer_price_per_sms_usd IS NULL OR customer_price_per_sms_usd >= 0),
  provider_cost_per_sms_usd numeric(28, 8) NOT NULL DEFAULT 0 CHECK (provider_cost_per_sms_usd >= 0),
  markup_bps integer NOT NULL DEFAULT 0 CHECK (markup_bps >= 0),
  otp_length integer NOT NULL DEFAULT 6 CHECK (otp_length BETWEEN 4 AND 12),
  otp_expiry_seconds integer NOT NULL DEFAULT 300 CHECK (otp_expiry_seconds BETWEEN 60 AND 86400),
  otp_message_template text NOT NULL DEFAULT 'Your verification code is {code}',
  max_message_length integer NOT NULL DEFAULT 480 CHECK (max_message_length BETWEEN 1 AND 1600),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, slug)
);

-- Debug/authorization trail for SMS provider calls. Stores identifiers, statuses, segment
-- counts and timings only: no message content, no OTP codes, no credentials.
CREATE TABLE IF NOT EXISTS sms_provider_requests (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  service_id uuid NOT NULL REFERENCES sms_services(id),
  provider_id uuid NOT NULL REFERENCES sms_providers(id),
  request_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SMS', 'OTP')),
  status text NOT NULL CHECK (status IN ('AUTHORIZED', 'COMPLETED', 'FAILED')),
  provider_request_id text,
  provider_message_id text,
  failure_kind text,
  failure_message text,
  units bigint NOT NULL DEFAULT 0 CHECK (units >= 0),
  usage_authoritative boolean NOT NULL DEFAULT false,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (merchant_id, request_id)
);

CREATE TABLE IF NOT EXISTS sms_usage_records (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  credit_account_id uuid NOT NULL REFERENCES credit_accounts(id),
  credit_transaction_id uuid NOT NULL UNIQUE REFERENCES credit_transactions(id),
  service_id uuid NOT NULL REFERENCES sms_services(id),
  provider_id uuid NOT NULL REFERENCES sms_providers(id),
  sms_provider_request_id uuid NOT NULL UNIQUE REFERENCES sms_provider_requests(id),
  request_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SMS', 'OTP')),
  units bigint NOT NULL CHECK (units > 0),
  customer_price_usd numeric(28, 8) NOT NULL CHECK (customer_price_usd > 0),
  provider_cost_usd numeric(28, 8) NOT NULL CHECK (provider_cost_usd >= 0),
  profit_usd numeric(28, 8) NOT NULL,
  credits_deducted_units numeric(78, 0) NOT NULL CHECK (credits_deducted_units > 0),
  credits_per_usdc_rate integer NOT NULL CHECK (credits_per_usdc_rate > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, request_id)
);

CREATE INDEX IF NOT EXISTS sms_services_enabled_idx ON sms_services (enabled);
CREATE INDEX IF NOT EXISTS sms_provider_requests_merchant_created_idx ON sms_provider_requests (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_provider_requests_pending_idx ON sms_provider_requests (merchant_id, status)
  WHERE status = 'AUTHORIZED';
CREATE INDEX IF NOT EXISTS sms_usage_merchant_created_idx ON sms_usage_records (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_usage_service_created_idx ON sms_usage_records (service_id, created_at DESC);
