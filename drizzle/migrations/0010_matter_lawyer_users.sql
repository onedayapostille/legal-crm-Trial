-- ─── Link matter lawyers to real users ──────────────────────────────────────
-- Makes the assigned lead lawyer and per-lawyer hourly rates reference actual
-- users instead of free text, so names cannot be overridden by free text and
-- co-lawyers can be populated from assigned users only.

ALTER TABLE "client_matters"
  ADD COLUMN IF NOT EXISTS "lead_lawyer_id" integer REFERENCES "users"("id");

ALTER TABLE "matter_lawyer_rates"
  ADD COLUMN IF NOT EXISTS "user_id" integer REFERENCES "users"("id");

CREATE INDEX IF NOT EXISTS idx_client_matters_lead_lawyer ON client_matters(lead_lawyer_id);
CREATE INDEX IF NOT EXISTS idx_matter_lawyer_rates_user ON matter_lawyer_rates(user_id);
