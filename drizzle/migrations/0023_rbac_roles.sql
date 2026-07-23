-- ─── AGP Roles & Permissions v1.1 — canonical account roles (additive) ───────
-- Adds the new canonical role values to the user_role enum. Legacy values
-- (partner, lawyer, staff, viewer) are intentionally KEPT — dropping enum
-- values would break existing rows/deployments. Data remapping happens in
-- 0024 (a separate file: new enum values cannot be used in the same
-- transaction that adds them).

ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'head_of_practice';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'senior_associate';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'executive_associate';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'associate';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'junior_lawyer';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'trainee';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'paralegal';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'coordinator';
