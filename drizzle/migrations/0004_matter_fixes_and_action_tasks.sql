-- ─── client_matters: add description, widen short text columns ────────────────
ALTER TABLE "client_matters"
  ADD COLUMN IF NOT EXISTS "matter_description" TEXT;

ALTER TABLE "client_matters"
  ALTER COLUMN "matter_status" TYPE VARCHAR(100);

ALTER TABLE "client_matters"
  ALTER COLUMN "achievement_status" TYPE VARCHAR(100);

-- ─── tasks: link to clients module ────────────────────────────────────────────
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "client_id" INTEGER REFERENCES "clients"("id") ON DELETE CASCADE;

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "client_matter_id" INTEGER REFERENCES "client_matters"("id") ON DELETE CASCADE;

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "client_action_log_id" INTEGER REFERENCES "client_action_logs"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_tasks_client_id              ON tasks(client_id);
CREATE INDEX IF NOT EXISTS idx_tasks_client_matter_id       ON tasks(client_matter_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_action_log_id_unique
  ON tasks(client_action_log_id) WHERE client_action_log_id IS NOT NULL;
