-- ─── Task provenance (source_type / source_id) ───────────────────────────────
-- Adds generic source columns to `tasks` so a task records WHERE it originated:
--   source_type — e.g. "action_log", "call", "meeting", "email", "follow_up",
--                 "financial_review" (free-form, 50 chars).
--   source_id   — id of the originating record (e.g. a client_action_logs.id),
--                 used to let the Task Details view jump back to the source.
--
-- Both nullable: tasks created directly (Tasks page / Client Tasks tab) carry no
-- source, and all existing rows keep NULL — existing data is unaffected.
--
-- Rollback:
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "source_id";
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "source_type";

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "source_type" varchar(50);

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "source_id" integer;

CREATE INDEX IF NOT EXISTS idx_tasks_source
  ON tasks(source_type, source_id);
