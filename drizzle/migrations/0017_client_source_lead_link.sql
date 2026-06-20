-- ─── Canonical intake link (client ← legacy lead) ────────────────────────────
-- Adds clients.source_lead_id: the canonical client that mirrors a legacy
-- enquiry (leads) row links back to it here. Used to keep the mirror in sync and
-- to prevent duplicate mirrors when an enquiry is edited.
--
-- ON DELETE SET NULL: deleting a legacy enquiry detaches its mirror but never
-- deletes the canonical client (no historical client data is lost).
--
-- Nullable; clients created directly (ClientForm) or before unification keep
-- source_lead_id = NULL, so existing data is unaffected.
--
-- One-time backfill of pre-existing legacy leads into canonical clients is a
-- separate, deliberately-run step — see scripts/backfill-leads-to-clients.sql.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_clients_source_lead;
--   ALTER TABLE "clients" DROP COLUMN IF EXISTS "source_lead_id";

ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "source_lead_id" integer
  REFERENCES "leads"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clients_source_lead
  ON clients(source_lead_id);
