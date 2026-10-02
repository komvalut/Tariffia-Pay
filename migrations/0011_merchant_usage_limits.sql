-- Phase 21: per-merchant API request usage counters and rate limits.
-- Limits are per merchant and per request category (general, ai, sms). A NULL column
-- means "use the configured default"; 0 means unlimited for that merchant. Counters are
-- fixed-window request counts. No secrets, prompts, completions or SMS content here.
CREATE TABLE IF NOT EXISTS merchant_usage_limits (
  merchant_id uuid PRIMARY KEY REFERENCES merchants(id),
  general_requests_per_minute integer CHECK (general_requests_per_minute IS NULL OR general_requests_per_minute >= 0),
  ai_requests_per_minute integer CHECK (ai_requests_per_minute IS NULL OR ai_requests_per_minute >= 0),
  sms_requests_per_minute integer CHECK (sms_requests_per_minute IS NULL OR sms_requests_per_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS merchant_request_counters (
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  category text NOT NULL CHECK (category IN ('general', 'ai', 'sms')),
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, category, window_start)
);

CREATE INDEX IF NOT EXISTS merchant_request_counters_window_idx
  ON merchant_request_counters (window_start);
