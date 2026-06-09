-- ─── Client intake channel (Conversion Rate KPI) ─────────────────────────────
-- Records which intake channel each client originated from so the dashboard
-- Conversion Rate KPI can be computed as:
--   converted clients (Active, from Lead/Enquiry) / total intake (Lead + Enquiry) * 100
--
-- "Direct" clients (walk-ins created straight as Existing Client) are excluded
-- from both numerator and denominator.

DO $$ BEGIN
  CREATE TYPE "client_converted_from" AS ENUM('Lead', 'Enquiry', 'Direct');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add as NOT NULL DEFAULT 'Lead': every existing client is backfilled to 'Lead'
-- since the client registry historically was the lead/enquiry funnel.
ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "converted_from" "client_converted_from" NOT NULL DEFAULT 'Lead';

CREATE INDEX IF NOT EXISTS idx_clients_converted_from ON clients(converted_from);
