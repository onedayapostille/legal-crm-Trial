-- ─── Lawyer rate uniqueness per matter/user (CRM-008) ────────────────────────
-- Prevent duplicate hourly-rate rows for the same (matter, user). The app already
-- checks this, but a DB constraint closes the race window and protects against
-- direct writes/imports.
--
-- PARTIAL index: only rows with a real user_id are constrained. Legacy rows that
-- predate the user link (user_id IS NULL, free-text lawyer_name only) are exempt,
-- so the migration is safe on historical data and NULLs do not collide.
--
-- SAFETY GUARD: skip + warn if duplicate (client_matter_id, user_id) pairs exist,
-- so this auto-applied migration never blocks startup. Resolve with
-- scripts/dedup-matter-lawyer-rates.sql, then re-run migrations.
--
-- Rollback:
--   DROP INDEX IF EXISTS ux_matter_lawyer_rates_matter_user;

DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT client_matter_id, user_id
    FROM matter_lawyer_rates
    WHERE user_id IS NOT NULL
    GROUP BY client_matter_id, user_id
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE WARNING
      'CRM-008: % duplicate (matter,user) lawyer-rate pair(s) found — UNIQUE index NOT created. Run scripts/dedup-matter-lawyer-rates.sql, then re-run migrations.',
      dup_count;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS ux_matter_lawyer_rates_matter_user
      ON matter_lawyer_rates (client_matter_id, user_id)
      WHERE user_id IS NOT NULL;
    RAISE NOTICE 'CRM-008: unique index ux_matter_lawyer_rates_matter_user is in place.';
  END IF;
END $$;
