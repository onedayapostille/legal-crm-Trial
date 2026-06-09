-- ─── Enquiry UTC timestamp ───────────────────────────────────────────────────
-- Store a clean UTC timestamp for each enquiry (timestamptz) plus the timezone
-- captured at entry. dateOfEnquiry/time remain as legacy display columns and are
-- derived from enquiry_at on write. Non-destructive: existing rows are backfilled
-- from their date + time, never dropped.

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "enquiry_at" timestamptz;

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "enquiry_timezone" varchar(64);

-- Backfill historical rows from date_of_enquiry + time (guarding malformed time).
UPDATE "leads"
SET "enquiry_at" = (
  "date_of_enquiry"
  + CASE WHEN "time" ~ '^[0-9]{1,2}:[0-9]{2}' THEN "time"::time ELSE time '00:00' END
)::timestamptz
WHERE "enquiry_at" IS NULL;

-- New rows that omit it fall back to the DB clock (UTC for timestamptz).
ALTER TABLE "leads"
  ALTER COLUMN "enquiry_at" SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_leads_enquiry_at ON leads(enquiry_at);
