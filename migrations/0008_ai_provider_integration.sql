ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_event_type_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_event_type_check CHECK (event_type IN (
  'payment.created', 'payment.detected', 'payment.confirmed', 'payment.failed', 'payment.expired', 'order.paid',
  'credit.topup', 'credit.deducted', 'ai.usage.recorded', 'invoice.issued', 'receipt.issued',
  'subscription.created', 'subscription.activated', 'subscription.paused', 'subscription.resumed',
  'subscription.cancelled', 'subscription.past_due', 'subscription.expired',
  'subscription.billing_cycle.created', 'subscription.billing_cycle.paid', 'subscription.billing_cycle.failed',
  'ai.request.completed', 'ai.request.failed'
));

-- Provider integration is configured server-side. Only non-secret configuration lives here;
-- the API key itself is read from the process environment and never stored.
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS integration text NOT NULL DEFAULT 'openai-compatible',
  ADD COLUMN IF NOT EXISTS credential_source text NOT NULL DEFAULT 'environment'
    CHECK (credential_source IN ('environment')),
  ADD COLUMN IF NOT EXISTS timeout_ms integer CHECK (timeout_ms IS NULL OR timeout_ms BETWEEN 1000 AND 120000),
  ADD COLUMN IF NOT EXISTS last_status text,
  ADD COLUMN IF NOT EXISTS last_status_message text,
  ADD COLUMN IF NOT EXISTS last_health_checked_at timestamptz;

ALTER TABLE ai_models
  ADD COLUMN IF NOT EXISTS provider_model text,
  ADD COLUMN IF NOT EXISTS max_output_tokens integer NOT NULL DEFAULT 512
    CHECK (max_output_tokens BETWEEN 1 AND 4096);

-- Debugging trail for provider calls. Stores identifiers, status and timings only:
-- no prompts, no completions, no credentials.
CREATE TABLE IF NOT EXISTS ai_provider_requests (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  provider_id uuid NOT NULL REFERENCES ai_providers(id),
  model_id uuid NOT NULL REFERENCES ai_models(id),
  request_id text NOT NULL,
  provider_request_id text,
  provider_response_id text,
  status text NOT NULL CHECK (status IN ('AUTHORIZED', 'COMPLETED', 'FAILED')),
  failure_kind text,
  failure_message text,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  usage_authoritative boolean NOT NULL DEFAULT false,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (merchant_id, request_id)
);

ALTER TABLE ai_usage_records
  ADD COLUMN IF NOT EXISTS provider_request_id uuid REFERENCES ai_provider_requests(id);

CREATE INDEX IF NOT EXISTS ai_provider_requests_merchant_created_idx ON ai_provider_requests (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_provider_requests_pending_idx ON ai_provider_requests (merchant_id, status)
  WHERE status = 'AUTHORIZED';
CREATE INDEX IF NOT EXISTS ai_usage_provider_request_idx ON ai_usage_records (provider_request_id)
  WHERE provider_request_id IS NOT NULL;
