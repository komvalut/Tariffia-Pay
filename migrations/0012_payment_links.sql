-- Phase 25: merchant payment-link management.
-- A payment link is an existing payment/order with a hosted checkout URL. This table adds
-- only reversible merchant management metadata (enabled/paused and soft-deleted) keyed by the
-- payment; it is created lazily on first management action, so payments never listed here are
-- active by default. It stores no secrets and does not touch payment processing.
CREATE TABLE IF NOT EXISTS payment_links (
  payment_id uuid PRIMARY KEY REFERENCES payments(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  enabled boolean NOT NULL DEFAULT true,
  disabled_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_links_merchant_idx ON payment_links (merchant_id, created_at DESC);
