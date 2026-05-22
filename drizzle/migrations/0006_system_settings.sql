-- ─── System Settings ────────────────────────────────────────────────────────
-- Stores configurable application parameters as key-value rows.
-- "updated_by" is nullable so the seed row can be inserted without a user ID.

CREATE TABLE IF NOT EXISTS "system_settings" (
  "key"         varchar(100) PRIMARY KEY,
  "value"       text         NOT NULL,
  "description" text,
  "updated_by"  integer      REFERENCES "users"("id"),
  "updated_at"  timestamp    NOT NULL DEFAULT now()
);

-- Default: flag an unpaid invoice as overdue after 30 days from billing date.
INSERT INTO "system_settings" ("key", "value", "description")
VALUES (
  'overdue_invoice_days',
  '30',
  'Number of days after billing date (invoice date) before an unpaid invoice is considered overdue'
)
ON CONFLICT ("key") DO NOTHING;
