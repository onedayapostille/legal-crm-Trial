-- ─── AI Assistant audit trail ─────────────────────────────────────────────────
-- One row per AI Assistant question. Records who asked what, over which period,
-- and which data scope + model were used — for accountability. The AI's full
-- answer is intentionally NOT stored. All columns are additive and nullable
-- (except question), so this migration is safe and affects no existing data.
--
-- Rollback:
--   DROP TABLE IF EXISTS "ai_audit_logs";

CREATE TABLE IF NOT EXISTS "ai_audit_logs" (
  "id"              serial PRIMARY KEY,
  "user_id"         integer REFERENCES "users"("id"),
  "question"        text NOT NULL,
  "period"          varchar(20),
  "data_scope_used" text,
  "model"           varchar(200),
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_logs_user ON ai_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_audit_logs_created ON ai_audit_logs(created_at);
