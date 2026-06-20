-- ─────────────────────────────────────────────────────────────────────────────
-- Remediation: resolve duplicate (matter, user) lawyer-rate rows (CRM-008)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The UNIQUE index in migration 0019 is only created when NO duplicate
-- (client_matter_id, user_id) pairs exist. If startup logged duplicates, run
-- this to inspect and (deliberately) resolve them, then re-run migrations.
--
-- Never deletes silently. STEP 1 reports; STEP 2 is an opt-in cleanup that keeps
-- the most recently updated rate per (matter, user) and removes older duplicates.
-- Take a backup and confirm with finance before uncommenting STEP 2.
-- ─────────────────────────────────────────────────────────────────────────────

-- STEP 1 — REPORT duplicate (matter, user) pairs:
SELECT client_matter_id,
       user_id,
       count(*)                  AS occurrences,
       array_agg(id ORDER BY id) AS rate_ids
FROM matter_lawyer_rates
WHERE user_id IS NOT NULL
GROUP BY client_matter_id, user_id
HAVING count(*) > 1
ORDER BY occurrences DESC;

-- STEP 2 — (OPTIONAL, MANUAL) keep the newest rate per (matter,user), delete the
-- older duplicates. Review STEP 1 first, then uncomment.
--
-- BEGIN;
-- WITH ranked AS (
--   SELECT id,
--          row_number() OVER (
--            PARTITION BY client_matter_id, user_id
--            ORDER BY updated_at DESC, id DESC
--          ) AS rn
--   FROM matter_lawyer_rates
--   WHERE user_id IS NOT NULL
-- )
-- DELETE FROM matter_lawyer_rates
-- WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
-- COMMIT;

-- STEP 3 — verify no duplicates remain, then re-run `pnpm db:migrate` (or restart
-- the server) so migration 0019 creates ux_matter_lawyer_rates_matter_user.
