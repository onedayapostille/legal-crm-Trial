-- ─────────────────────────────────────────────────────────────────────────────
-- Remediation: resolve duplicate (client_id, matter_reference) rows (CRM-007)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- matter_reference is the matter-level identifier and must be unique per client.
-- (original_serial is the inherited client number and is NOT unique — do not
-- dedup it.) The UNIQUE index in migration 0018 is only created when NO duplicate
-- (client_id, matter_reference) pairs exist. If startup logged duplicates, run
-- this to inspect and (deliberately) resolve them, then re-run migrations.
--
-- Never deletes or overwrites automatically. STEP 1 reports; STEP 2 is a
-- commented, opt-in re-suffixing of the newer duplicates so each client's matter
-- references become unique without losing rows. Backup + confirm before STEP 2.
-- ─────────────────────────────────────────────────────────────────────────────

-- STEP 1 — REPORT duplicate (client, reference) pairs:
SELECT client_id,
       matter_reference,
       count(*)                  AS occurrences,
       array_agg(id ORDER BY id) AS matter_ids
FROM client_matters
WHERE matter_reference IS NOT NULL AND btrim(matter_reference) <> ''
GROUP BY client_id, matter_reference
HAVING count(*) > 1
ORDER BY occurrences DESC;

-- STEP 2 — (OPTIONAL, MANUAL) make duplicates unique by suffixing the later rows
-- (keeps the earliest row's reference unchanged: "101" -> "101", "101-2", ...).
-- Review STEP 1 first, then uncomment.
--
-- BEGIN;
-- WITH ranked AS (
--   SELECT id,
--          row_number() OVER (
--            PARTITION BY client_id, matter_reference ORDER BY id
--          ) AS rn
--   FROM client_matters
--   WHERE matter_reference IS NOT NULL AND btrim(matter_reference) <> ''
-- )
-- UPDATE client_matters cm
-- SET matter_reference = cm.matter_reference || '-' || r.rn,
--     updated_at = now()
-- FROM ranked r
-- WHERE cm.id = r.id AND r.rn > 1;  -- rn = 1 (earliest) keeps its reference
-- COMMIT;

-- STEP 3 — verify no duplicates remain, then re-run `pnpm db:migrate` (or restart
-- the server) so migration 0018 creates ux_client_matters_client_reference.
