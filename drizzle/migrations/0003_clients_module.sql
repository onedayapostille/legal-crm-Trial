-- AlGhazzawi & Partners — Clients Module Migration
-- Adds: clients, client_matters, client_lead_details, rejected_clients, financial_records, client_action_logs

DO $$ BEGIN
  CREATE TYPE "client_status" AS ENUM('Existing Client', 'Leads', 'Rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "city" AS ENUM('Riyadh', 'Dammam', 'Jeddah');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "client_matter_type" AS ENUM('Corporate', 'Litigation');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "fee_type" AS ENUM(
    'Billable Hours',
    'Fixed / Project-Based Fees',
    'Retainers',
    'Success Fees',
    'Advisory / Special Mandates',
    'Blended'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "discount_approval" AS ENUM('N/A', 'P&L Head Lawyers', 'CEO', 'Board');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "collection_status" AS ENUM(
    'Not Billed',
    'Partially Billed',
    'Billed',
    'Partially Collected',
    'Fully Collected',
    'Overdue'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "rejection_reason" AS ENUM('Client', 'Us');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add partner and finance roles to existing enum (ALTER TYPE ADD VALUE is idempotent-safe)
DO $$ BEGIN
  ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'partner';
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'finance';
EXCEPTION WHEN others THEN NULL; END $$;

-- ─── clients ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "clients" (
  "id"             SERIAL PRIMARY KEY,
  "client_number"  VARCHAR(50) UNIQUE,
  "file_number"    VARCHAR(50) UNIQUE,
  "client_name"    VARCHAR(255) NOT NULL,
  "client_status"  "client_status" NOT NULL DEFAULT 'Leads',
  "city"           "city",
  "matter_type"    "client_matter_type",
  "created_by"     INTEGER REFERENCES "users"("id"),
  "created_at"     TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(client_status);
CREATE INDEX IF NOT EXISTS idx_clients_name   ON clients(client_name);

-- ─── client_matters ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "client_matters" (
  "id"                    SERIAL PRIMARY KEY,
  "client_id"             INTEGER NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "original_serial"       VARCHAR(50),
  "matter_reference"      VARCHAR(100),
  "matter_type"           VARCHAR(100),
  "lead_partner"          VARCHAR(100),
  "lead_partner_full_name" VARCHAR(255),
  "support_lead"          VARCHAR(100),
  "attorney_head"         VARCHAR(100),
  "attorney_1"            VARCHAR(100),
  "attorney_2"            VARCHAR(100),
  "attorney_3"            VARCHAR(100),
  "attorney_full_name"    VARCHAR(255),
  "matter_status"         VARCHAR(50),
  "balance_work_left"     DECIMAL(5,2),
  "achievement_percentage" DECIMAL(5,2),
  "achievement_status"    VARCHAR(50),
  "priority"              "priority" DEFAULT 'medium',
  "created_by"            INTEGER REFERENCES "users"("id"),
  "created_at"            TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_matters_client_id ON client_matters(client_id);

-- ─── client_lead_details ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "client_lead_details" (
  "id"                  SERIAL PRIMARY KEY,
  "client_id"           INTEGER NOT NULL UNIQUE REFERENCES "clients"("id") ON DELETE CASCADE,
  "client_source"       VARCHAR(255),
  "next_action_date"    DATE,
  "next_action_date_2"  DATE,
  "next_action_owner"   VARCHAR(255),
  "next_action"         TEXT,
  "priority"            "priority" DEFAULT 'medium',
  "lead_status"         VARCHAR(100),
  "created_at"          TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_lead_details_next_action ON client_lead_details(next_action_date);

-- ─── rejected_clients ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "rejected_clients" (
  "id"                      SERIAL PRIMARY KEY,
  "client_id"               INTEGER NOT NULL UNIQUE REFERENCES "clients"("id") ON DELETE CASCADE,
  "rejection_reason_source" "rejection_reason",
  "rejection_notes"         TEXT,
  "rejected_by"             VARCHAR(255),
  "rejected_at"             TIMESTAMP DEFAULT NOW(),
  "created_at"              TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── financial_records ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "financial_records" (
  "id"                  SERIAL PRIMARY KEY,
  "client_id"           INTEGER NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "client_matter_id"    INTEGER REFERENCES "client_matters"("id"),
  "fee_type"            "fee_type",
  "agreed_fees"         DECIMAL(15,2),
  "discount_approval"   "discount_approval" DEFAULT 'N/A',
  "discount_percentage" DECIMAL(5,2),
  "discount_amount"     DECIMAL(15,2),
  "net_fees"            DECIMAL(15,2),
  "billed_amount"       DECIMAL(15,2),
  "revenue"             DECIMAL(15,2),
  "collected_amount"    DECIMAL(15,2),
  "remaining_advanced"  DECIMAL(15,2),
  "outstanding_amount"  DECIMAL(15,2),
  "collection_status"   "collection_status" DEFAULT 'Not Billed',
  "billing_date"        DATE,
  "payment_date"        DATE,
  "invoice_number"      VARCHAR(100),
  "responsible_lawyer"  VARCHAR(255),
  "finance_notes"       TEXT,
  "created_by"          INTEGER REFERENCES "users"("id"),
  "created_at"          TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_financial_records_client_id        ON financial_records(client_id);
CREATE INDEX IF NOT EXISTS idx_financial_records_collection_status ON financial_records(collection_status);

-- ─── client_action_logs ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "client_action_logs" (
  "id"                SERIAL PRIMARY KEY,
  "client_id"         INTEGER NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "client_matter_id"  INTEGER REFERENCES "client_matters"("id"),
  "action_owner"      VARCHAR(255),
  "next_step"         TEXT,
  "action_date"       DATE,
  "action_type"       VARCHAR(100),
  "action_details"    TEXT,
  "created_by"        INTEGER REFERENCES "users"("id"),
  "created_at"        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_action_logs_client_id   ON client_action_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_client_action_logs_action_date ON client_action_logs(action_date);
