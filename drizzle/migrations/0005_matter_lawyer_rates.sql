-- Migration 0005: Add billing_type to client_matters + create matter_lawyer_rates table

-- Add billing_type column to client_matters (reuses existing fee_type enum)
ALTER TABLE "client_matters" ADD COLUMN IF NOT EXISTS "billing_type" "fee_type";

-- Create matter_lawyer_rates table
CREATE TABLE IF NOT EXISTS "matter_lawyer_rates" (
  "id"               serial PRIMARY KEY,
  "client_matter_id" integer NOT NULL REFERENCES "client_matters"("id") ON DELETE CASCADE,
  "lawyer_name"      varchar(255) NOT NULL,
  "role"             varchar(100),
  "hourly_rate"      decimal(15,2) NOT NULL,
  "currency"         varchar(10) NOT NULL DEFAULT 'SAR',
  "is_active"        boolean NOT NULL DEFAULT true,
  "effective_date"   date,
  "notes"            text,
  "created_by"       integer REFERENCES "users"("id"),
  "created_at"       timestamp DEFAULT now() NOT NULL,
  "updated_at"       timestamp DEFAULT now() NOT NULL
);

-- Index for fast look-up by matter
CREATE INDEX IF NOT EXISTS "matter_lawyer_rates_matter_idx"
  ON "matter_lawyer_rates"("client_matter_id");
