-- ─── Financial: deprecate billed_amount in favour of revenue ─────────────────
-- Per meeting note "Remove Billed Amount": Revenue is now the single amount field.
-- "Billed Amount" was removed from the forms and reports. The billed_amount COLUMN
-- is intentionally NOT dropped (it is referenced by historical data and audit
-- trails). Going forward the application mirrors billed_amount = revenue on every
-- write, so the two stay consistent.
--
-- This migration is non-destructive: it does NOT alter or delete any data. It only
-- documents the deprecation and exposes a review view for finance to reconcile any
-- pre-existing rows where billed_amount and revenue differ.

COMMENT ON COLUMN "financial_records"."billed_amount" IS
  'DEPRECATED: mirrored to revenue on write. Revenue is the single amount field. Kept for historical/audit compatibility — do not use in new reports.';

-- Review report: rows recorded BEFORE this change where the two amounts diverge.
-- These need manual review; the app will not auto-overwrite historical values.
CREATE OR REPLACE VIEW "financial_billed_revenue_discrepancies" AS
SELECT
  fr.id                                   AS financial_record_id,
  fr.client_id,
  fr.client_matter_id,
  fr.invoice_number,
  fr.billed_amount,
  fr.revenue,
  (COALESCE(fr.billed_amount, 0) - COALESCE(fr.revenue, 0)) AS difference,
  fr.collection_status,
  fr.created_at,
  fr.updated_at
FROM "financial_records" fr
WHERE fr.billed_amount IS DISTINCT FROM fr.revenue
ORDER BY ABS(COALESCE(fr.billed_amount, 0) - COALESCE(fr.revenue, 0)) DESC;

COMMENT ON VIEW "financial_billed_revenue_discrepancies" IS
  'Manual-review report: financial_records where billed_amount <> revenue (pre-deprecation data). Empty once all rows are reconciled.';
