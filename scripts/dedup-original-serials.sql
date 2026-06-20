-- ─────────────────────────────────────────────────────────────────────────────
-- Remediation: resolve duplicate client_matters.original_serial values (CRM-007)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The UNIQUE index in migration 0018 is only created when NO duplicate serials
-- exist. If startup logged "duplicate original_serial value(s) found", run this
-- to inspect and (deliberately) resolve duplicates, then re-run migrations.
--
-- This script NEVER deletes matters and NEVER silently overwrites. Step 1 only
-- REPORTS. Step 2 is a commented, opt-in re-sequencing of the *newer* duplicates
-- onto fresh MAT-#### serials, keeping the earliest row's serial unchanged.
--
-- ALWAYS take a backup first, and have finance/ops confirm the re-sequencing.
-- ─────────────────────────────────────────────────────────────────────────────

-- STEP 1 — REPORT duplicates (run this first; resolve nothing automatically):
SELECT original_serial,
       count(*)               AS occurrences,
       array_agg(id ORDER BY id) AS matter_ids
FROM client_matters
WHERE original_serial IS NOT NULL AND btrim(original_serial) <> ''
GROUP BY original_serial
HAVING count(*) > 1
ORDER BY occurrences DESC, original_serial;

-- STEP 2 — (OPTIONAL, MANUAL) Re-sequence duplicates.
-- Strategy: for each duplicated serial, keep the LOWEST id as-is and assign the
-- others brand-new MAT-#### serials continuing after the current global max.
-- Review STEP 1 output and confirm before uncommenting.
--
-- BEGIN;
--
-- WITH maxnum AS (
--   SELECT COALESCE(MAX((substring(original_serial FROM '^MAT-(\d+)$'))::int), 0) AS n
--   FROM client_matters
--   WHERE original_serial ~ '^MAT-\d+$'
-- ),
-- dups AS (
--   SELECT id,
--          row_number() OVER (PARTITION BY original_serial ORDER BY id) AS rn
--   FROM client_matters
--   WHERE original_serial IN (
--     SELECT original_serial FROM client_matters
--     WHERE original_serial IS NOT NULL AND btrim(original_serial) <> ''
--     GROUP BY original_serial HAVING count(*) > 1
--   )
-- )
-- UPDATE client_matters cm
-- SET original_serial = 'MAT-' || lpad((m.n + (d.rn - 1))::text, 4, '0'),
--     updated_at = now()
-- FROM dups d, maxnum m
-- WHERE cm.id = d.id AND d.rn > 1;  -- rn = 1 (earliest) keeps its serial
--
-- COMMIT;

-- STEP 3 — verify no duplicates remain, then re-run `pnpm db:migrate` (or restart
-- the server) so migration 0018 creates ux_client_matters_original_serial.
