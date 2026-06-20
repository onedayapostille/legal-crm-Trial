-- ─── Original Serial uniqueness (CRM-007) ────────────────────────────────────
-- Enforce uniqueness of client_matters.original_serial at the DATABASE level so
-- two concurrent saves can never produce the same serial. Replaces the previous
-- non-unique index (0009) which only sped up the race-prone app-level check.
--
-- PARTIAL index: only non-NULL serials are constrained. Rows with NULL serial
-- (none are expected — creation always allocates one — but legacy/imported rows
-- may have them) are not affected, and NULLs are not "equal" to each other.
--
-- SAFETY GUARD: building a UNIQUE index fails if duplicate serials already exist
-- (e.g. from historical imports). Creating the index inside this auto-applied
-- migration would then block startup. So we first detect duplicates and SKIP
-- index creation with a clear warning if any are found. Resolve them with
-- scripts/dedup-original-serials.sql, then re-run migrations to create the index.
--
-- Rollback:
--   DROP INDEX IF EXISTS ux_client_matters_original_serial;
--   (optionally recreate the old non-unique index from 0009)

DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT original_serial
    FROM client_matters
    WHERE original_serial IS NOT NULL AND btrim(original_serial) <> ''
    GROUP BY original_serial
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE WARNING
      'CRM-007: % duplicate original_serial value(s) found — UNIQUE index NOT created. Run scripts/dedup-original-serials.sql, then re-run migrations.',
      dup_count;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS ux_client_matters_original_serial
      ON client_matters (original_serial)
      WHERE original_serial IS NOT NULL;
    RAISE NOTICE 'CRM-007: unique index ux_client_matters_original_serial is in place.';
  END IF;
END $$;
