-- ─────────────────────────────────────────────────────────────────────────────
-- One-time backfill: legacy enquiries (leads) → canonical clients
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY: As of migration 0017 + the syncLeadToClient mirror, every NEW enquiry
-- created/updated through the Enquiry form also creates a canonical client
-- (clients + client_lead_details). Enquiries that existed BEFORE unification have
-- no mirror yet, so they are invisible in the Leads Pipeline / dashboard metrics.
-- This script creates the missing mirrors for historical leads.
--
-- SAFETY:
--   * Idempotent — guarded by `WHERE NOT EXISTS (... source_lead_id = leads.id)`.
--     Running it twice creates no duplicates.
--   * Additive only — it never updates or deletes any existing client or lead.
--   * No historical data is removed.
--
-- HOW TO RUN (deliberately, not automatic):
--   psql "$DATABASE_URL" -f scripts/backfill-leads-to-clients.sql
--   (Take a database backup first. Run inside the transaction below.)
--
-- ROLLBACK (removes ONLY the rows this backfill created — those linked to a
-- source lead; manually-created clients have source_lead_id IS NULL and are
-- untouched):
--   BEGIN;
--   DELETE FROM client_lead_details
--     WHERE client_id IN (SELECT id FROM clients WHERE source_lead_id IS NOT NULL);
--   DELETE FROM clients WHERE source_lead_id IS NOT NULL;
--   COMMIT;
--   -- NOTE: only safe as a rollback immediately after backfill, before any of
--   -- these mirrored clients are edited/used downstream.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) Create the canonical client for each legacy lead that has no mirror yet.
--    Status mapping mirrors syncLeadToClient():
--      Converted → Existing Client, Lost → Rejected, otherwise → Leads.
INSERT INTO clients (client_name, client_status, converted_from, source_lead_id, created_by, created_at, updated_at)
SELECT
  l.client_name,
  CASE l.current_status
    WHEN 'Converted' THEN 'Existing Client'
    WHEN 'Lost'      THEN 'Rejected'
    ELSE 'Leads'
  END,
  'Enquiry',
  l.id,
  l.created_by,
  COALESCE(l.created_at, now()),
  now()
FROM leads l
WHERE NOT EXISTS (
  SELECT 1 FROM clients c WHERE c.source_lead_id = l.id
);

-- 2) Create the matching client_lead_details (channel + assigned lawyer) for the
--    clients just inserted that don't already have a detail row.
INSERT INTO client_lead_details (client_id, channel_type, channel_medium, assigned_lawyer_id, client_source, lead_status, created_at, updated_at)
SELECT
  c.id,
  l.channel_type,
  l.channel_medium,
  l.assigned_to,
  l.referral_source_name,
  l.current_status,
  now(),
  now()
FROM clients c
JOIN leads l ON l.id = c.source_lead_id
WHERE c.source_lead_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM client_lead_details d WHERE d.client_id = c.id
  );

COMMIT;

-- Verify:
--   SELECT count(*) FROM clients WHERE source_lead_id IS NOT NULL;   -- mirrored clients
--   SELECT count(*) FROM leads;                                      -- should be >= mirrored count
