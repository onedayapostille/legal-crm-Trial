-- ─── AGP Roles & Permissions v1.1 — practice ownership + approved remap ──────
-- 1) practice_heads: authoritative (city, matter_type) → Head of Practice map
--    (BR-01). Null-safe transitional behavior: an unmapped combination belongs
--    to no practice, so no Head of Practice gains edit rights over it.
-- 2) Approved role migration mapping (spec §6): partner → head_of_practice,
--    staff → coordinator. Lawyer accounts are NOT auto-mapped — each needs an
--    explicit HR grade (see scripts/role-migration-report.ts). viewer is not
--    part of the approved role set and is left for admin reassignment.
-- All statements are additive / idempotent; nothing is dropped.

CREATE TABLE IF NOT EXISTS "practice_heads" (
  "id" serial PRIMARY KEY,
  "city" "city" NOT NULL,
  "matter_type" "client_matter_type" NOT NULL,
  "head_of_practice_id" integer NOT NULL REFERENCES "users"("id"),
  "created_by" integer REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "practice_heads_city_matter_type_unique" UNIQUE ("city", "matter_type")
);

CREATE INDEX IF NOT EXISTS idx_practice_heads_user ON practice_heads(head_of_practice_id);

-- Audit trail for the approved remaps (before the UPDATEs so the old value is real).
INSERT INTO "audit_logs" ("entity_type", "entity_id", "user_id", "action", "field_name", "old_value", "new_value", "description")
SELECT 'user', "id", NULL, 'role_changed', 'role', 'partner', 'head_of_practice',
       'RBAC migration 0024: approved mapping partner -> head_of_practice'
FROM "users" WHERE "role"::text = 'partner';

INSERT INTO "audit_logs" ("entity_type", "entity_id", "user_id", "action", "field_name", "old_value", "new_value", "description")
SELECT 'user', "id", NULL, 'role_changed', 'role', 'staff', 'coordinator',
       'RBAC migration 0024: approved mapping staff -> coordinator'
FROM "users" WHERE "role"::text = 'staff';

UPDATE "users" SET "role" = 'head_of_practice', "updated_at" = NOW() WHERE "role"::text = 'partner';
UPDATE "users" SET "role" = 'coordinator',      "updated_at" = NOW() WHERE "role"::text = 'staff';

-- Least-privilege default for any row inserted without an explicit role.
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'trainee';
