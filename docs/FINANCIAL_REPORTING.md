# Financial Reporting Module

Backend service: `server/financialReports.ts` · Router: `financialReports.*` in
`server/routers.ts` · UI: `client/src/pages/FinancialReports.tsx` (`/financial-reports`)
· Tests: `server/financialReports.test.ts`.

## Source of truth

Every report aggregates directly from **`financial_records`** (one row per
record) joined only through one-to-one relationships:

| Dimension | Join |
|---|---|
| Client | `financial_records.client_id → clients.id` |
| Matter | `financial_records.client_matter_id → client_matters.id` (nullable) |
| Responsible Lawyer | `financial_records.responsible_lawyer_id → users.id` |
| Lead Partner | `client_matters.lead_lawyer_id → users.id` |

Attorney 1–4 and `matter_lawyer_rates` are one-to-many and are **never** joined
into financial aggregation — that is the double-counting guard. The legacy
`payments` table and the legacy read-only columns `billed_amount` /
`remaining_advanced` (CRM-012) are excluded.

## Formulas (approved set, unchanged — see FINANCIAL_FORMULAS.md)

- Net Fees = `COALESCE(net_fees, agreed_fees)` (legacy-row fallback)
- Outstanding = stored `outstanding_amount` (= max(0, revenue − collected))
- To Be Billed = `GREATEST(0, COALESCE(net_fees, agreed_fees, 0) − COALESCE(revenue, 0))`
- Collection Rate = Collected / Revenue × 100 (NULL when revenue = 0)
- Overdue = status ∈ {Billed, Partially Billed, Partially Collected, Overdue}
  AND `billing_date` present AND `CURRENT_DATE − billing_date ≥ overdue_invoice_days`
  (system setting, default 30) — the overdue *report* additionally requires
  outstanding > 0.

All aggregation happens in Postgres `numeric` (exact decimal); money crosses the
API as strings. No floating-point arithmetic is used for totals.

## Attribution rules ("Attributed Revenue", not revenue share)

- **By Lawyer** — 100% of a record to its Responsible Lawyer.
- **By Lead Partner** — 100% of the same record to its Matter's Lead Partner.
- A record may therefore appear once in *each* dimension report, but never more
  than once *within* one report. There is no approved revenue-sharing formula;
  none is implemented.

## Missing business rule: Head of Practice

Head of Practice is **not represented in the data model** — it is not a user
role, not a matter field, and there is no practice-group entity. It is *not*
derived from `attorney_head` (different concept). The report dimension exists in
the API (`byHeadOfPractice` returns `configured: false` + reason; the
`headOfPracticeId` filter matches nothing) and the UI shows the section as
"Data relationship not configured".

**To enable it:** add an explicit relationship — e.g.
`client_matters.head_of_practice_id → users.id`, or a `practice_groups` table
with a head user — then group on it in `server/financialReports.ts`.

## Reporting date

There is no dedicated invoice/revenue date column. The effective reporting date
is `COALESCE(billing_date, created_at::date)`, returned as `effectiveDate`.
Date filters are inclusive on whole dates (from = start of day, to = end of
day) using the project's existing `CURRENT_DATE`-based policy.

There is also **no due-date column**: the derived due date is
`billing_date + overdue_invoice_days`, used for the Overdue report's Due Date /
Days Overdue / aging buckets.

## Permissions

All `financialReports.*` endpoints are gated by `financial:view` — identical
exposure to the existing financial module (admin, manager, partner; finance via
`financial:manage`). Lawyers/staff/viewers have no financial access, matching
the pre-existing rules. Row-level scoping (e.g. "lawyer sees own records only")
does not exist anywhere in the financial module and was deliberately **not**
introduced here (permissions were neither widened nor narrowed).

## Known limitations

- No invoice entity: the Invoice Status report reads the records' own invoice
  fields; "Invoice Amount" = Revenue (amount invoiced to date).
- No `collection_status` value for "Cancelled" — the overdue exclusion covers
  Fully Collected / Not Billed only.
- No discount-reason column (Discount Type = the approval level); no per-record
  "updated by" column (field-level history lives in the audit trail).
- CSV export caps the *details* export at 10,000 rows (noted inside the file
  when truncated). PDF export is not implemented (no existing PDF mechanism).
