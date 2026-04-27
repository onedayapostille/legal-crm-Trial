-- Apply the new production role defaults after enum values exist.

ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'staff';

UPDATE "users"
SET "role" = 'staff',
    "updated_at" = NOW()
WHERE "role"::text = 'user';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON "users"(LOWER("email"));
CREATE INDEX IF NOT EXISTS idx_users_role ON "users"("role");
CREATE INDEX IF NOT EXISTS idx_users_status ON "users"("status");
