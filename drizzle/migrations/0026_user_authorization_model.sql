-- 0026_user_authorization_model.sql
--
-- Adds the explicit per-account policy-era discriminator. Existing legacy role
-- rows remain legacy. Target-only roles can only represent the approved target
-- model, so any such pre-existing rows are deterministically classified target.
-- Shared names (admin/manager/finance) remain legacy until an administrator
-- performs an explicit audited transition.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'authorization_model') THEN
    CREATE TYPE authorization_model AS ENUM ('legacy', 'target');
  END IF;
END
$$;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "authorization_model" authorization_model;

UPDATE "users"
SET "authorization_model" = CASE
  WHEN "role" IN (
    'head_of_practice', 'senior_associate', 'executive_associate', 'associate',
    'junior_lawyer', 'trainee', 'paralegal', 'coordinator'
  ) THEN 'target'::authorization_model
  ELSE 'legacy'::authorization_model
END
WHERE "authorization_model" IS NULL;

ALTER TABLE "users"
  ALTER COLUMN "authorization_model" SET DEFAULT 'legacy'::authorization_model,
  ALTER COLUMN "authorization_model" SET NOT NULL;

ALTER TABLE "users"
  DROP CONSTRAINT IF EXISTS "users_role_authorization_model_check";

ALTER TABLE "users"
  ADD CONSTRAINT "users_role_authorization_model_check" CHECK (
    (
      "authorization_model" = 'legacy'
      AND "role" IN ('admin', 'manager', 'partner', 'lawyer', 'finance', 'staff', 'viewer')
    )
    OR
    (
      "authorization_model" = 'target'
      AND "role" IN (
        'admin', 'manager', 'head_of_practice', 'senior_associate',
        'executive_associate', 'associate', 'junior_lawyer', 'trainee',
        'paralegal', 'finance', 'coordinator'
      )
    )
  );
