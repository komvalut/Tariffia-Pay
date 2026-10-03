-- Phase 38: append-only audit log for important admin/merchant actions.
-- Only actor identity, action, resource identity, timestamp and bounded safe metadata are
-- stored. API keys, secrets, private keys, passwords, webhook secrets, provider credentials,
-- OTP codes and message content are never written here; the service sanitizes metadata again
-- before insert. Entries are only ever inserted and read; the application exposes no update
-- or delete path, so the log is append-only.
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('admin', 'merchant')),
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Merchant isolation and newest-first pagination.
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_id, created_at DESC);
-- Admin listing order.
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
-- Admin filters.
CREATE INDEX IF NOT EXISTS audit_log_filters_idx ON audit_log (actor_type, action, resource_type);
