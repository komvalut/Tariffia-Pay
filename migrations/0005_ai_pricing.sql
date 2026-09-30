ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_event_type_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_event_type_check CHECK (event_type IN (
  'payment.created', 'payment.detected', 'payment.confirmed', 'payment.failed',
  'payment.expired', 'order.paid', 'credit.topup', 'credit.deducted', 'ai.usage.recorded'
));

CREATE TABLE IF NOT EXISTS ai_providers (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_models (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES ai_providers(id),
  slug text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  pricing_mode text NOT NULL CHECK (pricing_mode IN ('PER_REQUEST', 'PER_1K_TOKENS', 'PER_REQUEST_AND_TOKENS')),
  provider_cost_per_request_usd numeric(28, 8) NOT NULL DEFAULT 0 CHECK (provider_cost_per_request_usd >= 0),
  customer_price_per_request_usd numeric(28, 8) CHECK (customer_price_per_request_usd >= 0),
  provider_input_cost_per_1k_usd numeric(28, 8) NOT NULL DEFAULT 0 CHECK (provider_input_cost_per_1k_usd >= 0),
  customer_input_price_per_1k_usd numeric(28, 8) CHECK (customer_input_price_per_1k_usd >= 0),
  provider_output_cost_per_1k_usd numeric(28, 8) NOT NULL DEFAULT 0 CHECK (provider_output_cost_per_1k_usd >= 0),
  customer_output_price_per_1k_usd numeric(28, 8) CHECK (customer_output_price_per_1k_usd >= 0),
  markup_bps integer NOT NULL DEFAULT 0 CHECK (markup_bps >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, slug)
);

CREATE TABLE IF NOT EXISTS ai_usage_records (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  credit_account_id uuid NOT NULL REFERENCES credit_accounts(id),
  credit_transaction_id uuid NOT NULL REFERENCES credit_transactions(id),
  provider_id uuid NOT NULL REFERENCES ai_providers(id),
  model_id uuid NOT NULL REFERENCES ai_models(id),
  request_id text NOT NULL,
  pricing_mode text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens bigint NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  provider_cost_usd numeric(28, 8) NOT NULL CHECK (provider_cost_usd >= 0),
  customer_price_usd numeric(28, 8) NOT NULL CHECK (customer_price_usd >= 0),
  profit_usd numeric(28, 8) NOT NULL,
  credits_deducted_units numeric(78, 0) NOT NULL CHECK (credits_deducted_units > 0),
  credits_per_usdc_rate integer NOT NULL CHECK (credits_per_usdc_rate > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, request_id),
  UNIQUE (credit_transaction_id)
);

CREATE INDEX IF NOT EXISTS ai_models_provider_enabled_idx ON ai_models (provider_id, enabled);
CREATE INDEX IF NOT EXISTS ai_usage_merchant_created_idx ON ai_usage_records (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_customer_created_idx ON ai_usage_records (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_model_created_idx ON ai_usage_records (model_id, created_at DESC);
