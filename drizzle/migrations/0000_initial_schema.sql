-- Legal CRM — Initial PostgreSQL schema
-- Generated for Drizzle ORM / postgres.js

DO $$ BEGIN
  CREATE TYPE "user_role" AS ENUM('admin', 'manager', 'lawyer', 'staff', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "user_status" AS ENUM('active', 'inactive', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "lead_status" AS ENUM('New', 'Contacted', 'Meeting Scheduled', 'Proposal Sent', 'Converted', 'Lost', 'On Hold');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "matter_status" AS ENUM('active', 'pending', 'closed', 'on_hold', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "priority" AS ENUM('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "task_status" AS ENUM('todo', 'in_progress', 'done', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "document_entity" AS ENUM('lead', 'matter', 'company', 'general');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "chat_status" AS ENUM('new', 'read', 'replied', 'converted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "audit_action" AS ENUM('created', 'updated', 'deleted', 'status_changed', 'role_changed', 'password_reset', 'assigned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Users ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "users" (
  "id"             SERIAL PRIMARY KEY,
  "email"          VARCHAR(320) NOT NULL UNIQUE,
  "name"           TEXT,
  "password_hash"  TEXT,
  "role"           "user_role"   NOT NULL DEFAULT 'staff',
  "status"         "user_status" NOT NULL DEFAULT 'active',
  "created_at"     TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"     TIMESTAMP NOT NULL DEFAULT NOW(),
  "last_login_at"  TIMESTAMP
);

-- ─── Companies ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "companies" (
  "id"          SERIAL PRIMARY KEY,
  "name"        VARCHAR(255) NOT NULL,
  "industry"    VARCHAR(100),
  "website"     VARCHAR(500),
  "phone"       VARCHAR(50),
  "email"       VARCHAR(320),
  "address"     TEXT,
  "notes"       TEXT,
  "created_by"  INTEGER REFERENCES "users"("id"),
  "created_at"  TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── Leads ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "leads" (
  "id"                          SERIAL PRIMARY KEY,
  "lead_code"                   VARCHAR(20) NOT NULL UNIQUE,
  "date_of_enquiry"             DATE NOT NULL,
  "time"                        VARCHAR(10),
  "communication_channel"       VARCHAR(50),
  "received_by"                 VARCHAR(100),
  "client_name"                 VARCHAR(255) NOT NULL,
  "client_type"                 VARCHAR(50),
  "nationality"                 VARCHAR(100),
  "email"                       VARCHAR(320),
  "phone_number"                VARCHAR(50),
  "preferred_contact_method"    VARCHAR(50),
  "language_preference"         VARCHAR(50),
  "company_id"                  INTEGER REFERENCES "companies"("id"),
  "service_requested"           VARCHAR(255),
  "short_description"           TEXT,
  "urgency_level"               VARCHAR(20),
  "client_budget"               DECIMAL(15,2),
  "potential_value_range"       VARCHAR(50),
  "expected_timeline"           VARCHAR(100),
  "referral_source_name"        VARCHAR(255),
  "competitor_involvement"      VARCHAR(20),
  "competitor_name"             VARCHAR(255),
  "assigned_department"         VARCHAR(100),
  "assigned_to"                 INTEGER REFERENCES "users"("id"),
  "suggested_lead_lawyer"       VARCHAR(100),
  "current_status"              "lead_status" NOT NULL DEFAULT 'New',
  "next_action"                 TEXT,
  "deadline"                    DATE,
  "first_response_date"         DATE,
  "first_response_time_hours"   DECIMAL(10,2),
  "meeting_date"                DATE,
  "proposal_sent_date"          DATE,
  "proposal_value"              DECIMAL(15,2),
  "follow_up_count"             INTEGER DEFAULT 0,
  "last_contact_date"           DATE,
  "conversion_date"             DATE,
  "engagement_letter_date"      DATE,
  "matter_code"                 VARCHAR(20),
  "payment_status"              VARCHAR(50),
  "invoice_number"              VARCHAR(100),
  "lost_reason"                 TEXT,
  "internal_notes"              TEXT,
  "created_by"                  INTEGER REFERENCES "users"("id"),
  "created_at"                  TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"                  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── Matters ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "matters" (
  "id"               SERIAL PRIMARY KEY,
  "matter_code"      VARCHAR(20) NOT NULL UNIQUE,
  "title"            VARCHAR(500) NOT NULL,
  "description"      TEXT,
  "client_name"      VARCHAR(255) NOT NULL,
  "client_email"     VARCHAR(320),
  "client_phone"     VARCHAR(50),
  "company_id"       INTEGER REFERENCES "companies"("id"),
  "lead_id"          INTEGER REFERENCES "leads"("id"),
  "practice_area"    VARCHAR(100),
  "status"           "matter_status" NOT NULL DEFAULT 'pending',
  "priority"         "priority"      NOT NULL DEFAULT 'medium',
  "assigned_to"      INTEGER REFERENCES "users"("id"),
  "open_date"        DATE,
  "close_date"       DATE,
  "next_hearing_date" DATE,
  "estimated_value"  DECIMAL(15,2),
  "actual_value"     DECIMAL(15,2),
  "billing_type"     VARCHAR(50),
  "created_by"       INTEGER REFERENCES "users"("id"),
  "created_at"       TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── Tasks ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tasks" (
  "id"           SERIAL PRIMARY KEY,
  "title"        VARCHAR(500) NOT NULL,
  "description"  TEXT,
  "status"       "task_status" NOT NULL DEFAULT 'todo',
  "priority"     "priority"    NOT NULL DEFAULT 'medium',
  "matter_id"    INTEGER REFERENCES "matters"("id") ON DELETE CASCADE,
  "lead_id"      INTEGER REFERENCES "leads"("id"),
  "assigned_to"  INTEGER REFERENCES "users"("id"),
  "due_date"     DATE,
  "completed_at" TIMESTAMP,
  "created_by"   INTEGER REFERENCES "users"("id"),
  "created_at"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── Notes ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "notes" (
  "id"          SERIAL PRIMARY KEY,
  "content"     TEXT NOT NULL,
  "entity_type" VARCHAR(50) NOT NULL,
  "entity_id"   INTEGER NOT NULL,
  "is_private"  BOOLEAN DEFAULT FALSE,
  "matter_id"   INTEGER REFERENCES "matters"("id") ON DELETE CASCADE,
  "lead_id"     INTEGER REFERENCES "leads"("id"),
  "created_by"  INTEGER REFERENCES "users"("id"),
  "created_at"  TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── Documents ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "documents" (
  "id"            SERIAL PRIMARY KEY,
  "name"          VARCHAR(500) NOT NULL,
  "original_name" VARCHAR(500),
  "mime_type"     VARCHAR(100),
  "file_size"     INTEGER,
  "storage_key"   VARCHAR(1000),
  "entity_type"   "document_entity" NOT NULL DEFAULT 'general',
  "entity_id"     INTEGER,
  "matter_id"     INTEGER REFERENCES "matters"("id"),
  "lead_id"       INTEGER REFERENCES "leads"("id"),
  "uploaded_by"   INTEGER REFERENCES "users"("id"),
  "created_at"    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── Payments ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "payments" (
  "id"                   SERIAL PRIMARY KEY,
  "lead_id"              INTEGER NOT NULL REFERENCES "leads"("id"),
  "matter_code"          VARCHAR(20) NOT NULL,
  "payment_terms"        TEXT,
  "payment_status"       VARCHAR(50) NOT NULL DEFAULT 'Not Started',
  "total_amount"         DECIMAL(15,2),
  "amount_paid"          DECIMAL(15,2) DEFAULT 0,
  "amount_outstanding"   DECIMAL(15,2),
  "retainer_paid_date"   DATE,
  "retainer_amount"      DECIMAL(15,2),
  "mid_payment_date"     DATE,
  "mid_payment_amount"   DECIMAL(15,2),
  "final_payment_date"   DATE,
  "final_payment_amount" DECIMAL(15,2),
  "payment_notes"        TEXT,
  "created_at"           TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── Activity Logs ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "activity_logs" (
  "id"           SERIAL PRIMARY KEY,
  "entity_type"  VARCHAR(50) NOT NULL,
  "entity_id"    INTEGER NOT NULL,
  "action"       VARCHAR(100) NOT NULL,
  "description"  TEXT,
  "metadata"     JSONB,
  "performed_by" INTEGER REFERENCES "users"("id"),
  "created_at"   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── Audit Logs ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"          SERIAL PRIMARY KEY,
  "entity_type" VARCHAR(50) NOT NULL DEFAULT 'lead',
  "entity_id"   INTEGER NOT NULL,
  "user_id"     INTEGER REFERENCES "users"("id"),
  "action"      "audit_action" NOT NULL,
  "field_name"  VARCHAR(100),
  "old_value"   TEXT,
  "new_value"   TEXT,
  "description" TEXT,
  "created_at"  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── Chat / Contact Submissions ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "chat_submissions" (
  "id"                    SERIAL PRIMARY KEY,
  "name"                  VARCHAR(255) NOT NULL,
  "email"                 VARCHAR(320),
  "phone"                 VARCHAR(50),
  "subject"               VARCHAR(500),
  "message"               TEXT,
  "status"                "chat_status" NOT NULL DEFAULT 'new',
  "assigned_to"           INTEGER REFERENCES "users"("id"),
  "converted_to_lead_id"  INTEGER REFERENCES "leads"("id"),
  "created_at"            TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"            TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_leads_status     ON "leads"("current_status");
CREATE INDEX IF NOT EXISTS idx_leads_created    ON "leads"("created_at" DESC);
CREATE INDEX IF NOT EXISTS idx_matters_status   ON "matters"("status");
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON "tasks"("status");
CREATE INDEX IF NOT EXISTS idx_tasks_due        ON "tasks"("due_date");
CREATE INDEX IF NOT EXISTS idx_activity_entity  ON "activity_logs"("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS idx_audit_entity     ON "audit_logs"("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS idx_users_email      ON "users"("email");
CREATE INDEX IF NOT EXISTS idx_users_role       ON "users"("role");
CREATE INDEX IF NOT EXISTS idx_users_status     ON "users"("status");
