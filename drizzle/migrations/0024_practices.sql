-- 0024_practices.sql
--
-- Phase 5: Head-of-Practice responsibility model (OWN_PRACTICE enforcement).
--
-- Additive only: a new `practices` table mapping a (location, matter_type) pair
-- to ONE responsible Head of Practice (a user FK). Nothing existing is altered.
--
--   * A "practice" = (location, matter_type). location uses the existing city
--     enum (Riyadh/Dammam/Jeddah); matter_type uses the existing client matter
--     type enum (Corporate/Litigation) → at most 6 practices.
--   * head_of_practice_id is a real user FK (never a name). Nullable so a practice
--     row may exist before its head is appointed.
--   * UNIQUE (location, matter_type): exactly one responsible head per practice
--     (BR-01/BR-02 — the head is "determined by location and matter type").
--   * The table is created EMPTY. Responsible heads are appointed / classified by
--     a later CONTROLLED step — this migration performs NO automatic backfill and
--     writes NO existing rows (§H).
--
-- A record's practice is derived from its (city, matter_type): clients directly,
-- client_matters via their parent client's city. Records whose (location,
-- matter_type) map to no practice are UNCLASSIFIED — readable under ALL, but not
-- writable under OWN_PRACTICE until classified.
--
-- Idempotent (IF NOT EXISTS). THIS MIGRATION IS NOT EXECUTED IN THIS PHASE.

CREATE TABLE IF NOT EXISTS "practices" (
  "id"                    SERIAL PRIMARY KEY,
  "location"              "city"                NOT NULL,
  "matter_type"           "client_matter_type"  NOT NULL,
  "head_of_practice_id"   INTEGER REFERENCES "users"("id"),
  "created_by"            INTEGER REFERENCES "users"("id"),
  "created_at"            TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMP NOT NULL DEFAULT now()
);

-- Exactly one responsible head per (location, matter_type).
CREATE UNIQUE INDEX IF NOT EXISTS "practices_location_matter_type_uniq"
  ON "practices" ("location", "matter_type");

-- Lookups by responsible head (OWN_PRACTICE resolution + HoP reporting).
CREATE INDEX IF NOT EXISTS "practices_head_of_practice_id_idx"
  ON "practices" ("head_of_practice_id");
