-- ─── User supervisor link (task visibility) ──────────────────────────────────
-- Self-referential supervisor: a lawyer's reports_to_id points at their partner.
-- Powers backend-enforced role-based task visibility (partners see their team's
-- tasks). Nullable; no existing data affected.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "reports_to_id" integer REFERENCES "users"("id");

CREATE INDEX IF NOT EXISTS idx_users_reports_to ON users(reports_to_id);
