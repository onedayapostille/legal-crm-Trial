-- ─── Lawyer assignments as real users on matters + financial records ────────
-- Adds user FK columns for every manually-typed lawyer field so assignments
-- reference actual users (CRM lawyer-dropdown initiative). Additive and
-- backward-compatible: the legacy free-text columns (support_lead,
-- attorney_head, attorney_1..3, responsible_lawyer, lead_partner*) are KEPT and
-- now double as server-derived display mirrors of the linked user's name.
-- attorney_4 is new (no legacy data) and gets both an FK and a display column
-- for symmetry with attorney_1..3.

ALTER TABLE "client_matters"
  ADD COLUMN IF NOT EXISTS "support_lead_id" integer REFERENCES "users"("id");
ALTER TABLE "client_matters"
  ADD COLUMN IF NOT EXISTS "attorney_head_id" integer REFERENCES "users"("id");
ALTER TABLE "client_matters"
  ADD COLUMN IF NOT EXISTS "attorney_1_id" integer REFERENCES "users"("id");
ALTER TABLE "client_matters"
  ADD COLUMN IF NOT EXISTS "attorney_2_id" integer REFERENCES "users"("id");
ALTER TABLE "client_matters"
  ADD COLUMN IF NOT EXISTS "attorney_3_id" integer REFERENCES "users"("id");
ALTER TABLE "client_matters"
  ADD COLUMN IF NOT EXISTS "attorney_4_id" integer REFERENCES "users"("id");
ALTER TABLE "client_matters"
  ADD COLUMN IF NOT EXISTS "attorney_4" varchar(100);

ALTER TABLE "financial_records"
  ADD COLUMN IF NOT EXISTS "responsible_lawyer_id" integer REFERENCES "users"("id");

CREATE INDEX IF NOT EXISTS idx_client_matters_support_lead ON client_matters(support_lead_id);
CREATE INDEX IF NOT EXISTS idx_client_matters_attorney_head ON client_matters(attorney_head_id);
CREATE INDEX IF NOT EXISTS idx_client_matters_attorney_1 ON client_matters(attorney_1_id);
CREATE INDEX IF NOT EXISTS idx_client_matters_attorney_2 ON client_matters(attorney_2_id);
CREATE INDEX IF NOT EXISTS idx_client_matters_attorney_3 ON client_matters(attorney_3_id);
CREATE INDEX IF NOT EXISTS idx_client_matters_attorney_4 ON client_matters(attorney_4_id);
CREATE INDEX IF NOT EXISTS idx_financial_records_responsible_lawyer ON financial_records(responsible_lawyer_id);
