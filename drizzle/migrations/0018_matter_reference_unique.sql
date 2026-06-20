-- ─── Matter Reference uniqueness per client (CRM-007, corrected) ─────────────
-- Confirmed business rule:
--   * client_matters.original_serial INHERITS the parent client's Original Serial
--     / Client Number. It represents the CLIENT, not the matter, so multiple
--     matters under one client share it. It is intentionally NOT unique and has
--     no MAT-#### format. (No unique index is created on original_serial.)
--   * matter_reference is the MATTER-level identifier. A client may not have two
--     matters with the same matter_reference; different clients may reuse one.
--
-- This enforces uniqueness on (client_id, matter_reference) via a PARTIAL unique
-- index (blank/NULL references are exempt, so matters without a reference yet do
-- not collide).
--
-- SAFETY GUARD: building a UNIQUE index fails if duplicate (client_id,
-- matter_reference) pairs already exist. Creating it in this auto-applied
-- migration would then block startup, so we first detect duplicates and SKIP with
-- a clear warning. Resolve with scripts/dedup-matter-references.sql, then re-run
-- migrations.
--
-- Rollback:
--   DROP INDEX IF EXISTS ux_client_matters_client_reference;

DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT client_id, matter_reference
    FROM client_matters
    WHERE matter_reference IS NOT NULL AND btrim(matter_reference) <> ''
    GROUP BY client_id, matter_reference
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE WARNING
      'CRM-007: % duplicate (client_id, matter_reference) pair(s) found — UNIQUE index NOT created. Run scripts/dedup-matter-references.sql, then re-run migrations.',
      dup_count;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS ux_client_matters_client_reference
      ON client_matters (client_id, matter_reference)
      WHERE matter_reference IS NOT NULL AND btrim(matter_reference) <> '';
    RAISE NOTICE 'CRM-007: unique index ux_client_matters_client_reference is in place.';
  END IF;
END $$;
