-- ─── In-app notifications ────────────────────────────────────────────────────
-- Per-user notification inbox (e.g. lead-lawyer assignment alerts).

CREATE TABLE IF NOT EXISTS "user_notifications" (
  "id"          SERIAL PRIMARY KEY,
  "user_id"     INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "title"       VARCHAR(255) NOT NULL,
  "body"        TEXT,
  "entity_type" VARCHAR(50),
  "entity_id"   INTEGER,
  "is_read"     BOOLEAN NOT NULL DEFAULT false,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, is_read);
