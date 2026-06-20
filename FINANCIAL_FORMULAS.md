# Financial Record Formulas (Phase 5)

This document records the **current, implemented** financial calculations so they
are documented rather than guessed (Phase 5 requirement). The authoritative
source is `applyDiscountRules()` in `server/db.ts` and the To-Be-Billed SQL in
`getToBeBilledBreakdown()`. Where business meaning is uncertain, it is flagged
**[NEEDS FINANCE APPROVAL]** rather than changed.

## Active vs legacy fields

| Field | Status | Notes |
|---|---|---|
| **Revenue** | **Active** | The single user-facing amount field. |
| Agreed Fees | Active (input) | Basis for discount + To Be Billed. |
| Discount Approval | Active (input) | Drives Discount % (see table below). |
| Discount % / Discount Amount | Active (derived) | Computed from Discount Approval. |
| Net Fees | Active (derived) | Computed from Agreed Fees − Discount Amount. |
| Collected Amount | Active (input) | Basis for Outstanding. |
| Outstanding Amount | Active (derived) | Computed from Revenue − Collected. |
| To Be Billed | Active (derived, view-layer) | Computed from Agreed Fees − Revenue. |
| Invoice Status (`collection_status`) | Active (input) | Not Billed / Partially Billed / Billed / Partially Collected / Fully Collected / Overdue. |
| **Billed Amount** (`billed_amount`) | **Legacy, read-only** | NEVER written by the app (CRM-012). Historical values preserved. |
| **Remaining Advanced** (`remaining_advanced`) | **Legacy, read-only** | NEVER written by the app (CRM-012). Historical values preserved. |

## Formulas (as implemented)

All money is rounded to 2 decimals (`round2`); missing inputs are treated as 0.

```
Discount %        = DISCOUNT_RATES[discountApproval]
Discount Amount   = round2(agreedFees * Discount% / 100)
Net Fees          = round2(max(0, agreedFees - Discount Amount))
Outstanding       = round2(max(0, revenue - collectedAmount))
To Be Billed      = max(0, agreedFees - revenue)        // computed in UI + getToBeBilledBreakdown SQL
```

### Discount Approval → Discount %

| Discount Approval | Discount % |
|---|---|
| N/A | 0 |
| P&L Head Lawyers | 5 |
| CEO | 10 |
| Board | 15 |

## Safety invariants (do not regress)

1. **No `billed_amount = revenue` mirroring.** A prior implementation mirrored
   `billed_amount` to `revenue` on every write, overwriting genuine historical
   billed values and forcing `remaining_advanced` to 0. `applyDiscountRules`
   deliberately does **not** touch these two columns; `updateFinancialRecord`
   explicitly omits them from the `SET`.
2. **Historical `billed_amount` / `remaining_advanced` are preserved.** New rows
   leave them `NULL`; existing rows keep their values.
3. The `financial_billed_revenue_discrepancies` view (migration 0011) surfaces
   any pre-existing rows where `billed_amount` and `revenue` differ, for finance
   to review manually — it does not auto-correct them.

## Items flagged for finance confirmation

- **[NEEDS FINANCE APPROVAL]** Whether `To Be Billed` should be
  `agreedFees - revenue` or `netFees - revenue` (i.e. before vs after discount).
  Current logic uses **Agreed Fees**. If finance intends net-of-discount, this is
  a one-line change in `applyDiscountRules`/`getToBeBilledBreakdown` — not changed
  here pending confirmation.
- **[NEEDS FINANCE APPROVAL]** Whether `Outstanding` should derive from `revenue`
  or `netFees` when a discount applies. Current logic uses **Revenue**.
- **[NEEDS FINANCE APPROVAL]** Disposition of the legacy `billed_amount` /
  `remaining_advanced` columns once finance has reviewed the discrepancy view
  (keep as history vs archive vs drop).
