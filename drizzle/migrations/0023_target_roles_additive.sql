-- 0023_target_roles_additive.sql
--
-- Phase 3: additive target-role enum support (migration-readiness).
--
-- Adds the approved TARGET account roles to the existing "user_role" enum so the
-- column CAN store them at a later controlled cutover. This is purely additive:
--   * No legacy value is removed or renamed — admin/manager/partner/lawyer/
--     finance/staff/viewer all remain valid (coexistence).
--   * No existing account row is updated (roles are re-graded by a later,
--     separate, controlled migration — NOT here).
--   * "lead_lawyer" is intentionally NOT added — Lead Lawyer is a per-matter
--     overlay (matter.lead_lawyer_id), never an account role.
--   * "viewer" is left in place and UNMAPPED, pending an explicit decision.
--
-- Idempotent: ADD VALUE IF NOT EXISTS is safe to re-run and matches the pattern
-- already used by 0001 and 0003. The runner (server/db.ts:runMigrations) records
-- applied files in schema_migrations, but each statement is independently safe.
--
-- Rollback: PostgreSQL cannot DROP an enum value. Because no row references these
-- new values (no data migration here), the safe rollback is simply to leave the
-- unused values present — they are inert until a later phase assigns them.
--
-- THIS MIGRATION IS NOT EXECUTED IN THIS PHASE. Do not run db:migrate / db:push.

ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'head_of_practice';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'senior_associate';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'executive_associate';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'associate';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'junior_lawyer';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'trainee';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'paralegal';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'coordinator';
