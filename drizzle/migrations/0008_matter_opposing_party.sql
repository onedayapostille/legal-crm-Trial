-- ─── Opposing party (conflict-of-interest checks) ────────────────────────────
-- Records the adverse / opposing party for each matter so the Conflict Check
-- can flag when a new matter's opposing party (or matter name) collides with an
-- existing client or matter in the system.

ALTER TABLE "client_matters"
  ADD COLUMN IF NOT EXISTS "opposing_party" varchar(255);

CREATE INDEX IF NOT EXISTS idx_client_matters_opposing_party
  ON client_matters(opposing_party);
