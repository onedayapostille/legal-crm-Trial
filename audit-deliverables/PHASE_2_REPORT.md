# Legal CRM — Phase 2 Report (Matter & Finance Data Integrity)

**Branch:** `fix/crm-phase-2-data-integrity` (continues from Phase 1)
**Date:** 2026-06-20
**Scope:** CRM-006 (Matter Type authority), CRM-007 (Original Serial integrity),
CRM-008 (lawyer-rate duplicates), CRM-010 (financial client/matter link),
CRM-012 (Billed Amount vs Revenue cleanup).

> Prereq check: Phase 1 (`fix/crm-phase-1-critical-foundation`) is included — this
> branch was created from it. Phase 1 commits are present in history.

---

## 1. Files Changed

| File | Change |
| --- | --- |
| `server/db.ts` | Serial: format enforcement, advisory-lock transaction, unique-violation mapping. Matter Type required on create. `assertMatterBelongsToClient()` for financial records. `applyDiscountRules` no longer writes billed_amount/remaining_advanced. Lawyer-rate unique-violation backstop. |
| `drizzle/migrations/0018_matter_original_serial_unique.sql` | Guarded partial UNIQUE index on `client_matters.original_serial`. |
| `drizzle/migrations/0019_matter_lawyer_rates_unique.sql` | Guarded partial UNIQUE index on `matter_lawyer_rates(client_matter_id, user_id)`. |
| `scripts/dedup-original-serials.sql` | Remediation: detect/resolve duplicate serials before the unique index. |
| `scripts/dedup-matter-lawyer-rates.sql` | Remediation: detect/resolve duplicate (matter,user) rates. |
| `client/src/pages/ClientForm.tsx` | Removed client-level Matter Type field. |
| `client/src/pages/MatterNew.tsx` | Matter Type marked required + client-side guard. |
| `client/src/pages/ClientDetail.tsx` | "To Be Billed" now computed from revenue, not billed_amount. |
| `client/src/pages/FinancialRecords.tsx` | Removed dead billed_amount aggregation/columns. |
| `server/originalSerial.test.ts` | Pure format tests + serial/matter-type integration tests. |
| `server/financialRevenue.test.ts` | Billed/revenue cleanup + client/matter link tests. |
| `server/{activeMatters,clientTasks,conflictCheck,matterLawyerRates,rejectedClientLock}.test.ts` | Added required `matterType` to matter fixtures. |

Commits:
1. `feat: matter & finance data-integrity (server) — CRM-006/007/008/010/012`
2. `feat: matter & finance data-integrity (frontend) — CRM-006/012`
3. `test: Phase 2 data-integrity coverage + fixtures`

---

## 2. Migrations Added

| Migration | What it does | Safety |
| --- | --- | --- |
| `0018_matter_original_serial_unique.sql` | Partial `UNIQUE` index `ux_client_matters_original_serial` on non-NULL serials. | **Guarded**: a `DO` block counts duplicates first; if any exist it RAISEs a WARNING and skips index creation (so startup never breaks). Idempotent. Rollback in header. |
| `0019_matter_lawyer_rates_unique.sql` | Partial `UNIQUE` index `ux_matter_lawyer_rates_matter_user` on `(client_matter_id, user_id)` where `user_id IS NOT NULL` (legacy null-user rows exempt). | Same guarded pattern. Idempotent. Rollback in header. |

Both are applied by the existing startup auto-migrator (`runMigrations`). If a guard
skips an index because of pre-existing duplicates, the startup log says so; run the
matching dedup script, then restart / `pnpm db:migrate` to create the index.

**Remediation scripts (run deliberately, never auto-run):**
`scripts/dedup-original-serials.sql`, `scripts/dedup-matter-lawyer-rates.sql` — each
REPORTS duplicates first (STEP 1) and provides a commented, opt-in resolution
(STEP 2) plus verification. No data is deleted or overwritten automatically.

---

## 3. Data Integrity Rules Added

- **Original Serial (CRM-007)**
  - DB-level uniqueness via partial UNIQUE index (the authoritative guarantee).
  - Concurrency-safe allocation: a transaction-scoped `pg_advisory_xact_lock`
    serializes max+1 generation; the unique index is the hard backstop and any
    `23505` is mapped to a friendly `409 CONFLICT`.
  - Canonical format `^MAT-\d{4,}$` enforced for manual entry; legacy/imported
    serials are grandfathered (only re-validated when actually changed).
- **Matter Type (CRM-006)** — required server-side on matter create; owned by the
  matter. Multiple matters under one client can hold different types. Client-level
  Matter Type removed from the New Client form (column/API kept for compat).
- **Financial client/matter link (CRM-010)** — `assertMatterBelongsToClient()` on
  create and update: a linked matter must exist and belong to the record's client.
  Client-level records (no matter) remain allowed. Enforced server-side regardless
  of frontend filtering.
- **Lawyer rates (CRM-008)** — DB composite uniqueness `(client_matter_id, user_id)`
  + friendly `409` on violation, backing the existing app-level check and active
  lawyer/partner validation.

---

## 4. Financial Formulas — Confirmed vs Pending Approval

**Active fields (confirmed in code):**
- `revenue` — the single active amount field (user-entered).
- `net_fees = max(0, agreed_fees − discount_amount)`; `discount_amount =
  agreed_fees × discount_rate(discount_approval)`.
- `outstanding_amount = max(0, revenue − collected_amount)`.
- `to_be_billed = max(0, agreed_fees − revenue)` (reports + UI).
- `total_revenue = SUM(revenue)`.

**Legacy / read-only (no longer written — CRM-012):**
- `billed_amount` — previously mirrored to `revenue` on every write, which
  overwrote genuine historical values. Now never written by the app; existing
  values preserved; new rows leave it NULL.
- `remaining_advanced` — previously forced to 0 by the mirror. Now never written;
  historical values preserved; new rows NULL.

**Pending finance approval (business decisions, documented — not blocking):**
- Whether the legacy `billed_amount` column should ever be reconciled or dropped.
  Use the `financial_billed_revenue_discrepancies` view (migration 0011) to review
  pre-existing rows where `billed_amount <> revenue`. **Do not drop the column**
  without sign-off — it holds historical accounting data.
- Whether `remaining_advanced` (advance/retainer remaining) should become an active
  derived field with an agreed formula. Currently inactive by decision to avoid
  corrupting prior meaning.

---

## 5. Tests Run & Results

Run via local binaries (no `pnpm` on PATH): `node_modules/.bin/tsc`, `.../vitest`.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `tsc --noEmit` | **PASS** (exit 0) |
| Pure unit tests | `vitest run -t "assertValidOriginalSerialFormat"` | **PASS** — 2/2 |
| Full suite | `vitest run` | 11 pass / 82 fail — **every failure is `DATABASE_URL environment variable is required`** (verified: no other error cause appears). No logic regressions. |

**Pure (DB-free) tests passing now:** `assertValidOriginalSerialFormat` (2),
`mapLeadStatusToClientStatus` (4, Phase 1), `conversionRangeStart` (3), + 2 others.

**Could NOT run (need a PostgreSQL `DATABASE_URL`)** — written and type-correct:
the integration parts of `originalSerial` (serial allocation/uniqueness/matter-type
authority), `financialRevenue` (billed cleanup + client/matter link),
`matterLawyerRates` (duplicate prevention), plus all other DB-backed suites.

**Exact commands to run the DB-backed tests** (disposable Postgres recommended):
```bash
# 1) point at a throwaway database
export DATABASE_URL='postgresql://user:pass@localhost:5432/legal_crm_test?sslmode=disable'
# 2) apply migrations (creates schema incl. 0018/0019 unique indexes)
pnpm db:migrate
# 3) run the suite
pnpm test
# Targeted:
pnpm exec vitest run server/originalSerial.test.ts server/financialRevenue.test.ts server/matterLawyerRates.test.ts
```

---

## 6. Remaining Risks / Limitations

- **Unverified at runtime:** all integrity rules are enforced in code + migrations
  but were not executed against a live DB here. Apply migrations to a disposable
  Postgres and run the suite (commands above) before sign-off.
- **Pre-existing duplicates block the unique indexes:** if production has duplicate
  serials or duplicate (matter,user) rates, migrations 0018/0019 will SKIP index
  creation (logged as a warning) until the dedup scripts are run. This is
  intentional (never auto-overwrite), but means uniqueness is not guaranteed until
  remediation is done.
- **Serial format grandfathering:** legacy non-`MAT-####` serials remain valid and
  are only re-validated if changed. Strict global format enforcement is a future
  business decision.
- **Finance sign-off pending** on `billed_amount` reconciliation and the meaning of
  `remaining_advanced` (see §4). No destructive action taken.
- **Advisory-lock allocation** assumes a single logical Postgres (advisory locks are
  per-database). That matches the deployment; multi-primary setups would need the
  unique index alone (still safe) or a sequence.
- **Out of scope for Phase 2** (later phase): notification/email delivery (CRM-018),
  schema↔migration FK parity, free-text status governance, cross-user real-time.

---

## 7. Manual QA Checklist (Phase 2)

**Original Serial**
- [ ] Create a matter with blank serial → auto `MAT-####`, unique.
- [ ] Create with manual `MAT-0001` → accepted; create a second with the same →
      rejected (409). Create with `SER-1` → rejected (400, format).
- [ ] Edit a legacy matter whose serial isn't `MAT-####` without changing the
      serial → still saves (grandfathered).
- [ ] After applying migrations on a clean DB, confirm
      `\d client_matters` shows `ux_client_matters_original_serial` (unique).

**Matter Type**
- [ ] Create a matter with no type → blocked (client + server).
- [ ] One client, two matters: Corporate + Litigation → both saved, independent.
- [ ] New Client form no longer shows Matter Type.

**Financial link**
- [ ] Client-level record (no matter) → allowed.
- [ ] Matter-level record where matter belongs to the client → allowed.
- [ ] Attempt to link a matter from a different client → rejected (400).
- [ ] Reports/summaries still include client-level (no-matter) rows.

**Billed vs Revenue**
- [ ] New financial record → `billed_amount` and `remaining_advanced` are NULL;
      Revenue, Net Fees, Outstanding, To Be Billed correct.
- [ ] Edit revenue on a record → `billed_amount` unchanged (history preserved).
- [ ] No "Billed Amount" column/total appears as an active field in Financial
      Records or Client financials.
- [ ] `SELECT * FROM financial_billed_revenue_discrepancies;` reviewed by finance.

**Lawyer rates**
- [ ] Add a rate for a lawyer on a matter; add the same lawyer again → rejected.
- [ ] After migrations, confirm `ux_matter_lawyer_rates_matter_user` exists.
