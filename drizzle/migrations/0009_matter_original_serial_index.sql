-- ─── Original Serial lookups ─────────────────────────────────────────────────
-- Speeds up auto-generation (scan of MAT-#### serials) and the uniqueness check
-- performed on matter create/update. Kept as a NON-unique index intentionally:
-- historical imported rows may contain duplicate/blank serials, so uniqueness is
-- enforced at the application layer for new/edited matters (a hard UNIQUE
-- constraint would require a one-off data-dedup pass first).

CREATE INDEX IF NOT EXISTS idx_client_matters_original_serial
  ON client_matters(original_serial);
