-- Phase 19: SMS provider hardening.
-- Services gain an explicit optional fallback provider (never the primary), and provider
-- requests keep an audit trail of every pre-acceptance attempt (provider, outcome, error
-- category, retry hint, latency). No credentials, message content or OTP codes are stored.
ALTER TABLE sms_services
  ADD COLUMN IF NOT EXISTS fallback_provider_id uuid REFERENCES sms_providers(id),
  DROP CONSTRAINT IF EXISTS sms_services_fallback_distinct_check;
ALTER TABLE sms_services
  ADD CONSTRAINT sms_services_fallback_distinct_check
  CHECK (fallback_provider_id IS NULL OR fallback_provider_id <> provider_id);

ALTER TABLE sms_provider_requests
  ADD COLUMN IF NOT EXISTS attempts jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS sms_provider_requests_provider_status_idx
  ON sms_provider_requests (provider_id, status);
