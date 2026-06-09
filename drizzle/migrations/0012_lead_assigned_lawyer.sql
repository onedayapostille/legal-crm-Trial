-- ─── Unified intake: assigned lawyer for leads ───────────────────────────────
-- Adds a real (user FK) assigned lawyer to client lead details so the unified
-- intake page (Leads Pipeline) can filter leads by assigned lawyer.

ALTER TABLE "client_lead_details"
  ADD COLUMN IF NOT EXISTS "assigned_lawyer_id" integer REFERENCES "users"("id");

CREATE INDEX IF NOT EXISTS idx_client_lead_details_assigned_lawyer
  ON client_lead_details(assigned_lawyer_id);
