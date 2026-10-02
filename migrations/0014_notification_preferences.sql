-- Phase 33: merchant notification preferences.
-- Per-merchant event toggles only. No email/SMS sending is implemented in this phase and no
-- secrets or message content are stored; these flags are configuration, not delivery state.
CREATE TABLE IF NOT EXISTS merchant_notification_preferences (
  merchant_id uuid PRIMARY KEY REFERENCES merchants(id),
  payment_confirmed boolean NOT NULL DEFAULT true,
  payment_failed boolean NOT NULL DEFAULT true,
  payment_expired boolean NOT NULL DEFAULT true,
  credit_topup boolean NOT NULL DEFAULT true,
  ai_request_failed boolean NOT NULL DEFAULT true,
  sms_request_failed boolean NOT NULL DEFAULT true,
  webhook_failed boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
