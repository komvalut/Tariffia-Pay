-- Phase 32: merchant self-service settings.
-- Non-sensitive, merchant-editable preferences only (display name, support email, default
-- currency, timezone). It never stores API keys, webhook secrets, provider credentials,
-- private keys or payment state; those remain in their existing tables untouched.
CREATE TABLE IF NOT EXISTS merchant_settings (
  merchant_id uuid PRIMARY KEY REFERENCES merchants(id),
  display_name text,
  support_email text,
  default_currency text,
  timezone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
