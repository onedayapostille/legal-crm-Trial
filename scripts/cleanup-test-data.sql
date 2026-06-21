-- DEV-ONLY: remove orphaned test users left by interrupted test runs.
-- Scope: users whose email ends in '@x.com' (the test-suite convention). The real
-- admin (admin@legalcrm.com) and ALL business rows are preserved — every FK to
-- users is nullable except user_notifications.user_id, so we NULL the links and
-- delete only the test users + their own notifications. The file wraps itself in
-- BEGIN/COMMIT, so any error rolls the whole thing back. Safe to re-run (idempotent).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/cleanup-test-data.sql
--   (do NOT add -1 — the file already manages its own transaction)

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _test_users ON COMMIT DROP AS
  SELECT id FROM users WHERE email LIKE '%@x.com';

-- Unlink test users from every (nullable) referencing column — non-destructive to
-- the referenced business rows.
UPDATE activity_logs        SET performed_by       = NULL WHERE performed_by       IN (SELECT id FROM _test_users);
UPDATE audit_logs           SET user_id            = NULL WHERE user_id            IN (SELECT id FROM _test_users);
UPDATE chat_submissions     SET assigned_to        = NULL WHERE assigned_to        IN (SELECT id FROM _test_users);
UPDATE client_action_logs   SET created_by         = NULL WHERE created_by         IN (SELECT id FROM _test_users);
UPDATE client_lead_details  SET assigned_lawyer_id = NULL WHERE assigned_lawyer_id IN (SELECT id FROM _test_users);
UPDATE client_matters       SET created_by         = NULL WHERE created_by         IN (SELECT id FROM _test_users);
UPDATE client_matters       SET lead_lawyer_id     = NULL WHERE lead_lawyer_id     IN (SELECT id FROM _test_users);
UPDATE clients              SET created_by         = NULL WHERE created_by         IN (SELECT id FROM _test_users);
UPDATE companies            SET created_by         = NULL WHERE created_by         IN (SELECT id FROM _test_users);
UPDATE documents            SET uploaded_by        = NULL WHERE uploaded_by        IN (SELECT id FROM _test_users);
UPDATE financial_records    SET created_by         = NULL WHERE created_by         IN (SELECT id FROM _test_users);
UPDATE leads                SET assigned_to        = NULL WHERE assigned_to        IN (SELECT id FROM _test_users);
UPDATE leads                SET created_by         = NULL WHERE created_by         IN (SELECT id FROM _test_users);
UPDATE matter_lawyer_rates  SET created_by         = NULL WHERE created_by         IN (SELECT id FROM _test_users);
UPDATE matter_lawyer_rates  SET user_id            = NULL WHERE user_id            IN (SELECT id FROM _test_users);
UPDATE matters              SET assigned_to        = NULL WHERE assigned_to        IN (SELECT id FROM _test_users);
UPDATE matters              SET created_by         = NULL WHERE created_by         IN (SELECT id FROM _test_users);
UPDATE notes                SET created_by         = NULL WHERE created_by         IN (SELECT id FROM _test_users);
UPDATE system_settings      SET updated_by         = NULL WHERE updated_by         IN (SELECT id FROM _test_users);
UPDATE tasks                SET assigned_to        = NULL WHERE assigned_to        IN (SELECT id FROM _test_users);
UPDATE tasks                SET created_by         = NULL WHERE created_by         IN (SELECT id FROM _test_users);
UPDATE users                SET reports_to_id      = NULL WHERE reports_to_id      IN (SELECT id FROM _test_users);

-- Only NOT NULL FK: notifications belong to the test user, so remove them.
DELETE FROM user_notifications WHERE user_id IN (SELECT id FROM _test_users);

-- Finally remove the test users themselves.
DELETE FROM users WHERE id IN (SELECT id FROM _test_users);

COMMIT;
