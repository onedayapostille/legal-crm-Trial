-- Add role and audit enum values before they are used by later migrations.

ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'manager';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'lawyer';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'staff';

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'role_changed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'password_reset';
