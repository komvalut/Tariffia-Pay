-- Phase 46: enforce audit_log append-only at the database level.
-- The application already exposes no update or delete path, but a database trigger guarantees
-- the log cannot be altered even through direct SQL. INSERT (append) remains allowed; only
-- UPDATE and DELETE are rejected. This mirrors the ledger_entries immutability trigger.
CREATE OR REPLACE FUNCTION reject_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
