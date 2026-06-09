-- ─── Two-level communication channel ─────────────────────────────────────────
-- Splits the flat communication_channel into channel_type (Digital Channels /
-- Referral / Walk-in / Event / Conference) and channel_medium (the specific
-- digital medium, referral name, or event name). Applied to enquiries (leads)
-- and client intake (client_lead_details). Non-destructive: communication_channel
-- is kept; existing rows are backfilled.

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "channel_type"   varchar(50);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "channel_medium" varchar(255);

ALTER TABLE "client_lead_details" ADD COLUMN IF NOT EXISTS "channel_type"   varchar(50);
ALTER TABLE "client_lead_details" ADD COLUMN IF NOT EXISTS "channel_medium" varchar(255);

-- Backfill leads from the legacy flat value.
UPDATE "leads"
SET
  "channel_type" = CASE
    WHEN "communication_channel" IN ('Email','Phone','WhatsApp','Website','LinkedIn') THEN 'Digital Channels'
    WHEN "communication_channel" = 'Referral' THEN 'Referral'
    WHEN "communication_channel" = 'Walk-in' THEN 'Walk-in'
    WHEN "communication_channel" IN ('Event/Conference','Event / Conference') THEN 'Event / Conference'
    ELSE "channel_type"
  END,
  "channel_medium" = CASE
    WHEN "communication_channel" IN ('Email','Phone','WhatsApp','Website','LinkedIn') THEN "communication_channel"
    WHEN "communication_channel" = 'Referral' THEN "referral_source_name"
    ELSE "channel_medium"
  END
WHERE "channel_type" IS NULL AND "communication_channel" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_channel_type   ON leads(channel_type);
CREATE INDEX IF NOT EXISTS idx_leads_channel_medium ON leads(channel_medium);
CREATE INDEX IF NOT EXISTS idx_cld_channel_type     ON client_lead_details(channel_type);
CREATE INDEX IF NOT EXISTS idx_cld_channel_medium   ON client_lead_details(channel_medium);
