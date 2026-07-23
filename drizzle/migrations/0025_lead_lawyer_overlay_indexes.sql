-- 0025_lead_lawyer_overlay_indexes.sql
--
-- Phase 6: additive indexes supporting the per-matter Lead Lawyer overlay.
-- The overlay reuses the EXISTING FK (client_matters.lead_lawyer_id, §H) — no new
-- columns or constraints. These indexes back the hot overlay lookups:
--   * ledMatterIds / isLeadLawyerOfMatter → WHERE lead_lawyer_id = $actor
--   * task overlay                        → WHERE client_matter_id IN (led ids)
--
-- Additive and idempotent (CREATE INDEX IF NOT EXISTS). NOT executed in this
-- phase — do not run db:migrate / db:push.

CREATE INDEX IF NOT EXISTS "client_matters_lead_lawyer_id_idx"
  ON "client_matters" ("lead_lawyer_id");

CREATE INDEX IF NOT EXISTS "tasks_client_matter_id_idx"
  ON "tasks" ("client_matter_id");
