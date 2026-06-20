# Legal CRM — Phase 2 Report (Matter & Finance Data Integrity)

**Branch:** `fix/crm-phase-2-data-integrity` (continues from Phase 1)
**Date:** 2026-06-20
**Scope:** CRM-006 (Matter Type authority), CRM-007 (Original Serial = inherited
client number; Matter Reference uniqueness), CRM-008 (lawyer-rate duplicates),
CRM-010 (financial client/matter link), CRM-012 (Billed Amount vs Revenue cleanup).

> **CRM-007 corrected after review (2026-06-20):** an earlier draft wrongly treated
> `original_serial` as a unique `MAT-####` matter identifier. The confirmed rule is
> below — Original Serial is the inherited client number (not unique), and Matter
> Reference is the matter-level identifier with `UNIQUE(client_id, matter_reference)`.

> Prereq check: Phase 1 (`fix/crm-phase-1-critical-foundation`) is included — this
> branch was created from it. Phase 1 commits are present in history.

---

## 1. Files Changed

| File | Change |
| --- | --- |
| `server/db.ts` | Serial: inherit client number (`defaultOriginalSerialFromClient`), no format/allocator/uniqueness; Matter Reference unique per client (`assertMatterReferenceUniqueForClient`) + unique-violation mapping. Matter Type required on create. `assertMatterBelongsToClient()` for financial records. `applyDiscountRules` no longer writes billed_amount/remaining_advanced. Lawyer-rate unique-violation backstop. |
| `drizzle/migrations/0018_matter_reference_unique.sql` | Guarded partial UNIQUE index on `client_matters(client_id, matter_reference)`. (No unique index on `original_serial`.) |
| `drizzle/migrations/0019_matter_lawyer_rates_unique.sql` | Guarded partial UNIQUE index on `matter_lawyer_rates(client_matter_id, user_id)`. |
| `scripts/dedup-matter-references.sql` | Remediation: detect/resolve duplicate (client, reference) pairs before the unique index. |
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
4. `docs: add Phase 2 report (matter & finance data integrity)`
5. `fix(CRM-007): Original Serial is the inherited client number, not a unique matter id` (correction after review)

---

## 2. Migrations Added

| Migration | What it does | Safety |
| --- | --- | --- |
| `0018_matter_reference_unique.sql` | Partial `UNIQUE` index `ux_client_matters_client_reference` on `(client_id, matter_reference)` where the reference is non-blank. **No** unique index on `original_serial` (it is the shared, inherited client number). | **Guarded**: a `DO` block counts duplicate (client, reference) pairs first; if any exist it RAISEs a WARNING and skips index creation (so startup never breaks). Idempotent. Rollback in header. |
| `0019_matter_lawyer_rates_unique.sql` | Partial `UNIQUE` index `ux_matter_lawyer_rates_matter_user` on `(client_matter_id, user_id)` where `user_id IS NOT NULL` (legacy null-user rows exempt). | Same guarded pattern. Idempotent. Rollback in header. |

Both are applied by the existing startup auto-migrator (`runMigrations`). If a guard
skips an index because of pre-existing duplicates, the startup log says so; run the
matching dedup script, then restart / `pnpm db:migrate` to create the index.

**Remediation scripts (run deliberately, never auto-run):**
`scripts/dedup-matter-references.sql`, `scripts/dedup-matter-lawyer-rates.sql` — each
REPORTS duplicates first (STEP 1) and provides a commented, opt-in resolution
(STEP 2) plus verification. No data is deleted or overwritten automatically.
(`original_serial` is intentionally NOT deduped — duplicates are allowed.)

---

## 3. Data Integrity Rules Added

- **Original Serial = inherited client number (CRM-007, corrected)**
  - `original_serial` represents the **parent client's** Original Serial / Client
    Number. It is **shared** across all of a client's matters, is **NOT unique**,
    and has **no `MAT-####` format** and **no allocator**.
  - On create, a blank serial defaults from the client: `clientNumber` →
    `fileNumber` → `CL-<clientId>` (documented fallback). A provided value is used
    as-is. On edit, the existing value is preserved; if cleared it is refilled from
    the client number (never left blank).
- **Matter Reference = matter-level identifier (CRM-007)**
  - **Required going forward** on Add/Edit Matter — enforced server-side: create
    rejects a blank/missing reference (`400`); update rejects clearing it to blank
    (`400`). Updates that don't touch the reference are left alone, so editing
    other fields on a legacy record with a blank reference is **not** blocked or
    auto-overwritten (legacy reads/displays are unaffected). Frontend Add/Edit
    Matter forms (ClientDetail dialogs + MatterNew) also require it.
  - `UNIQUE(client_id, matter_reference)` (partial; blank references exempt):
    a client cannot have two matters with the same reference; different clients
    may reuse one. Enforced in app code on create/update with a DB `23505` backstop
    mapped to `409 CONFLICT`. Not globally unique (intentional).
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
| Full suite | `vitest run` | 9 pass / 87 fail — **every failure is `DATABASE_URL environment variable is required`** (verified: no other error cause appears). No logic regressions. |

**Pure (DB-free) tests passing now:** `mapLeadStatusToClientStatus` (4, Phase 1),
`conversionRangeStart` (3), + 2 others. (CRM-007 is now entirely DB-backed —
serial inheritance and reference uniqueness both touch the database.)

**Could NOT run (need a PostgreSQL `DATABASE_URL`)** — written and type-correct:
`originalSerial` (serial inheritance / shared serial / matter_reference uniqueness /
matter-type authority), `financialRevenue` (billed cleanup + client/matter link),
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
  `(client_id, matter_reference)` pairs or duplicate `(matter, user)` rates,
  migrations 0018/0019 will SKIP index creation (logged as a warning) until the
  dedup scripts are run. This is intentional (never auto-overwrite), but means
  uniqueness is not guaranteed until remediation is done. (`original_serial`
  duplicates are allowed by design and are never deduped.)
- **Matter Reference is required** for new/updated matters (enforced server-side +
  in the forms). Legacy records with a blank reference are not auto-fixed: they
  still read/display, and are only required to gain a reference when they are next
  edited. A backfill of legacy blanks (if desired) is a separate, reviewed step.
- **Global matter_reference uniqueness** is intentionally NOT enforced (different
  clients may reuse a reference). Switch to a global unique index only if the
  business later confirms it.
- **Finance sign-off pending** on `billed_amount` reconciliation and the meaning of
  `remaining_advanced` (see §4). No destructive action taken.
- **Out of scope for Phase 2** (later phase): notification/email delivery (CRM-018),
  schema↔migration FK parity, free-text status governance, cross-user real-time.

---

## 7. Manual QA Checklist (Phase 2)

**Original Serial (inherited client number)**
- [ ] Client "Sankyo" with Client Number `881`. Create Matter 1 (no serial) →
      `original_serial = 881`. Create Matter 2 → also `881` (shared, not unique).
- [ ] Matters 1 & 2 have different Matter References (e.g. `101`, `102`).
- [ ] Serial is NOT `MAT-####` and is never max+1 generated.
- [ ] Client with no Client Number → matter serial falls back to `CL-<clientId>`.
- [ ] Edit a matter and clear the serial → it refills from the client number.

**Matter Reference (required + unique per client)**
- [ ] Add Matter with a blank Matter Reference → blocked (form + server 400).
- [ ] Edit Matter and clear the reference → blocked (server 400). Editing another
      field on a legacy blank-reference matter without touching the reference →
      still saves (legacy not broken).
- [ ] Same client, second matter with an existing reference → rejected (409).
- [ ] Two different clients with the same reference → both allowed.
- [ ] After migrations on a clean DB, confirm `\d client_matters` shows
      `ux_client_matters_client_reference` (unique) and NO unique index on
      `original_serial`.

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
