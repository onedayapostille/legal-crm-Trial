# Current Project Status & Completed Fixes Audit

**Date:** 2026-06-21
**Branch:** `fix/env-config-and-docs`
**Scope:** Summary of completed fixes + quick current-status audit. **Read-only** — no code, migrations, or DB data changed; this report is the only file written.
**Method:** git history, prior audit reports in `audit-deliverables/`, current code inspection, and live local checks (app `/health`, DB, login, `tsc`, full test suite).

---

> ## ✅ Resolution Update (remaining issues actioned)
>
> Following this audit, the remaining Medium/Low issues were addressed (the single **High** item is a non-code Finance sign-off and remains open by nature):
>
> | Issue | Sev | Status | What changed |
> |---|---|---|---|
> | Local Postgres not persistent | Medium | ✅ Resolved | Added idempotent `scripts/start-local-db.ps1` + a per-user **Startup-folder launcher** (`start-legalcrm-db.cmd`) so the DB auto-starts at logon (no admin needed; Windows service / `schtasks ONLOGON` both require elevation here). |
> | No seed matters/financial for E2E QA | Medium | ✅ Resolved | Added idempotent `scripts/seed-demo.ts` → demo client "DEMO - Northwind Trading" with matters **NW-001** (Corporate) + **NW-002** (Litigation) and a matter-linked financial record. It also live-validates CRM-012: `billed_amount` stays **NULL** (not mirrored), discount/net/outstanding compute correctly (10% CEO discount → net 90,000; outstanding 20,000). |
> | Orphaned dev-DB test data | Medium | ✅ Resolved | `scripts/cleanup-test-data.sql` (transactional, idempotent) removed **161 `@x.com` test users (162 → 1)**; admin + the 9 real clients + demo data preserved. Note: a few orphaned *test clients/leads* remain (harder to identify safely by name) — left intentionally; future test runs now self-clean. |
> | Conflict popup width (6 cols) | Low | ✅ Resolved | `ConflictMatchTable.tsx` wrapper → `overflow-x-auto` + `whitespace-nowrap` headers (scrolls on narrow screens instead of squishing). |
> | Minor copy | Low | ➖ No change | No concrete copy defect identified; not changed to avoid churn. |
> | **Finance formula sign-off** | **High** | ⏸️ **Open (by design)** | Requires Finance to confirm `To Be Billed`/`Outstanding` bases + legacy `billed_amount` disposition — documented in `FINANCIAL_FORMULAS.md`. Engineering will not change formulas without sign-off. |
>
> Verification after changes: `tsc --noEmit` clean · conflict/original-serial suites 16/16 · app `/health/db` ok · demo data present. New files are dev tooling only (no business-logic/migration changes).

---

## 1. Executive Summary

* **Overall status:** ✅ **Safe to continue development.** Core matter/conflict/financial/lawyer logic is implemented and covered by a green test suite.
* **Local runtime:** ✅ App serves on `http://localhost:3000`; DB connected (`localhost:5432/app`); `/health` + `/health/db` healthy; **login works** (admin, active). ⚠️ Operational caveat: the local scoop PostgreSQL has **stopped on its own twice this session** — it is not running as a persistent service, which intermittently breaks login until restarted.
* **Completed fixes:** ~20 distinct items across Phases 1–6 plus the Top-5 follow-up fixes (see §2).
* **Verification:** `tsc --noEmit` clean · **full suite 104/104 passing (20 files)** · `pnpm build` green · migration ledger records 20 files.
* **Remaining blockers:** **None critical.** One **High** item is a *non-code* Finance sign-off on formulas; the rest are operational/medium (local DB persistence, orphaned test data, no seed matters for end-to-end QA).
* **Recommended next action:** Make the local Postgres persistent (stop the recurring drop-outs), then obtain Finance sign-off on the documented formulas, then run the manual video QA against seeded data.

---

## 2. Completed Fixes

| Area | Fix Completed | Evidence / Files / Commits | Status |
|---|---|---|---|
| Local runtime / env (Phase 1) | `.env` + `.env.example`; `JWT_SECRET`/`DATABASE_URL` loading; `/health` + `/health/db` diagnostics | `server/_core/index.ts`, `server/_core/env.ts`, `.env.example`; `PHASE_1_REPORT.md` | ✅ Done |
| **CRM-007 Original Serial** | Defaults from parent client number; **not unique**, **no MAT-#### format**, **no max+1**; matters under one client share it | `defaultOriginalSerialFromClient` + comment block (`server/db.ts`); `originalSerial.test.ts` (12/12) | ✅ Done |
| **Matter Reference** | Required on create + edit; matter-level identifier; **unique per (client_id, matter_reference)**; reusable across clients | `assertMatterReferenceUniqueForClient` (`server/db.ts`), unique index `0018_matter_reference_unique`; `originalSerial.test.ts` | ✅ Done |
| **CRM-006 Matter Type** | Required + authoritative at matter level; different types per client allowed | `createClientMatter` requires `matterType` (`server/db.ts`); `MatterNew.tsx`/`ClientDetail.tsx` client-side checks | ✅ Done |
| **CRM-010 Financial client/matter link** | Records belong to a client; optional matter link; **cross-client link blocked** on create + update; client-level records supported | `assertMatterBelongsToClient` (create+update, `server/db.ts`); `financialRevenue.test.ts` | ✅ Done |
| **CRM-012 Revenue / Billed Amount** | Revenue is the active field; **billed_amount NOT mirrored**; historical billed/remaining preserved | `applyDiscountRules` (`server/db.ts`); `FINANCIAL_FORMULAS.md`; `0011_financial_billed_revenue_audit` view | ✅ Done (finance sign-off pending — §7 High) |
| **CRM-008 Lawyer rates** | Duplicate rate per (matter,user) prevented; lead+co-lawyer billing | `matter_lawyer_rates_unique` (`0019`); `matterLawyerRates.test.ts` (5/5) | ✅ Done |
| Conflict matching normalization | Case/whitespace/punctuation + basic Arabic normalization; conservative (substring, not fuzzy) | `normalizeForConflict` (`server/db.ts`); `normalizeForConflict.test.ts` (8/8) | ✅ Done |
| **Fix 1 — cross-client reference** | Same Matter Reference under a *different* client no longer forces conflict acknowledgement | `checkMatterConflicts(clientId)` filter (`server/db.ts`, `server/routers.ts`, `MatterNew.tsx`, `ClientDetail.tsx`); commit `af978e6` | ✅ Done |
| Video: Original Serial inherited UI | Field shown as inherited from client (muted/mono + helper) | `MatterNew.tsx`, `ClientDetail.tsx` | ✅ Done |
| Video: Matters table polish | Reference + Original Serial as **separate** columns; Lead Partner/Type/Status/Priority; auto-refresh | `ClientDetail.tsx` matters table, `MatterList.tsx` | ✅ Done |
| Video: Matter Type required polish | `*` label + client-side required on add/edit | `ClientDetail.tsx` | ✅ Done |
| **Fix 3 — Conflict popup Source column** | Match Type / Matched Name / Related Client / Related Record / Status / **Source** | `ConflictMatchTable.tsx`; commit `af978e6` | ✅ Done |
| Video: Lead Partner dropdown (Phase 3) | Dropdown of active partners/lawyers → `lead_lawyer_id`, server-validated; legacy text preserved | `MatterNew.tsx`, `ClientDetail.tsx`, `users.leadLawyers`, `createClientMatter`/`updateClientMatter` | ✅ Done |
| Video: Financial linked-matter dropdown (Phase 4) | Shows `Ref · Type · Status · Lead Partner: Name`; "No matter — client-level record" | `components/FinancialDialog.tsx` | ✅ Done |
| Finance formulas doc (Phase 5) | Documented formulas + legacy field status + **[NEEDS FINANCE APPROVAL]** flags | `FINANCIAL_FORMULAS.md`; stale comment fixed in `server/routers.ts` | ✅ Done |
| Counters / refresh / nav (Phase 6) | Tab counters + lists invalidate on mutation; in-context navigation | `ClientDetail.tsx`, `FinancialDialog.tsx` invalidations | ✅ Done |
| **Fix 4 — Test repairs** | `payments` fixture+API rename; `taskVisibility` teardown FK order; `leadLawyerAssignment` lead→client mirror cleanup; `intakeFilters` timezone-robust window | `*.test.ts`; suite 90/14 → **104/104**; commit `af978e6` | ✅ Done |
| **Fix 5 — Auth/migrations** | `AUTH_SECRET` confirmed as `JWT_SECRET` fallback + `env.ts` aligned; **`schema_migrations` ledger** added (idempotency preserved) | `server/_core/env.ts`, `server/db.ts`; commit `af978e6` | ✅ Done |
| Reports | Local dev, deployment, phase, and comparison audits | `audit-deliverables/` (LOCAL_DEV_SETUP, ONLINE_DEPLOYMENT, PHASE_1/2, LOCAL_VIDEO_AND_CRM001_CRM020) | ✅ Done |

---

## 3. Local Runtime Audit

* **Environment:** `.env` present; `DATABASE_URL` ✓, `JWT_SECRET` ✓, `PORT=3000`. `AUTH_SECRET` not set locally (intentional — `auth.ts` uses `JWT_SECRET || AUTH_SECRET`). `/health` → `databaseUrlSet:true`, `jwtSecretSet:true`, admin seed envs present.
* **Database:** scoop PostgreSQL 18 on `localhost:5432/app`; `/health/db` → `{ok:true}`. Read-only counts: **users≈162** (inflated by orphaned test rows — see §7), **clients=9**, **client_matters=0**, **financial_records=0**.
* **Migrations:** 20 files `0000`–`0019` applied; new `schema_migrations` ledger records all 20 (re-runs are skipped; migrations remain idempotent). All 21 expected tables present.
* **Health endpoint:** ✅ `/health` and `/health/db` both healthy at audit time.
* **Login:** ✅ `POST /api/trpc/auth.login` (admin) → HTTP 200, `success:true`, role `admin`, active.
* **Smoke test:** App `GET /` → HTTP 200 (SPA). `tsc` clean; `pnpm build` green (vite + esbuild).
* ⚠️ **Operational caveat:** local Postgres stopped twice this session (stale `postmaster.pid`, nothing on 5432), each time surfacing as the generic login error *"We couldn't sign you in right now"* (a DB `ECONNREFUSED`, not bad credentials). Resolved by clearing the pidfile and `pg_ctl start`. It is not configured as a persistent service.
* **Dublyo/hosted (separate from local):** prior notes record the hosted app cannot reach its DB (platform networking, not a code bug) — out of scope here; use local dev. See `ONLINE_DEPLOYMENT_AUDIT.md`.

---

## 4. Core Workflow Audit

| Workflow | Status | Evidence | Issues |
|---|---|---|---|
| Dashboard | ✅ Working | `Dashboard.tsx`, `KPIDashboard.tsx`; `clientStatusCounts`/`conversionRate`/`activeMatters` tests pass | — |
| Leads / Enquiries / Pipeline | ✅ Working | `EnquiriesLog.tsx`, unified intake; `enquiries`/`recentLeads`/`newLeadVisibility`/`intakeFilters` tests pass | — |
| Client detail | ✅ Working | `ClientDetail.tsx` (tabs: matters/actions/tasks/financial with live counts) | — |
| Add/Edit Matter | ✅ Working | `ClientDetail.tsx` dialogs + `MatterNew.tsx`; Original Serial inherited, Reference+Type required, Lead Partner dropdown | 0 seed matters locally → create-to-test |
| Conflict Check | ✅ Working | Pre-create gate + acknowledgement + audit; `conflictCheck` (4/4) + `normalizeForConflict` (8/8); Source column added | — |
| Matter list/table | ✅ Working | `MatterList.tsx`, client-detail table (separate Ref/Serial columns) | — |
| Financial Records | ✅ Working | `FinancialRecords.tsx`, `FinancialDialog.tsx`; client vs matter-level distinguished; cross-client blocked | Formula intent pending finance (§7) |
| Tasks / Actions | ✅ Working | `clientTasks` (pass), `taskVisibility` (5/5 after fix); Tasks tab in client page | — |
| Permissions / roles | ✅ Working | `permissionProcedure`, role checks; `taskVisibility` role enforcement passes | — |

---

## 5. Video-Based Requirements Status

| Requirement | Status | Evidence | Remaining Work | Priority |
|---|---|---|---|---|
| Original Serial inherited from client | ✅ Done | `defaultOriginalSerialFromClient` + UI | — | — |
| Matter Reference required + unique per client | ✅ Done | `assertMatterReferenceUniqueForClient`, index `0018` | — | — |
| Different clients reuse a reference (no false conflict) | ✅ Done | `checkMatterConflicts(clientId)` (Fix 1); `originalSerial` 12/12 | — | — |
| Matter Type required at matter level | ✅ Done | `createClientMatter`, dialogs | — | — |
| Matters table separate Ref/Serial + Lead Partner + refresh | ✅ Done | `ClientDetail.tsx`, `MatterList.tsx` | — | — |
| Conflict check before create + acknowledgement + audit | ✅ Done | router gate + `ConflictWarningDialog.tsx` | — | — |
| Conflict normalization (case/space/punct/Arabic) | ✅ Done | `normalizeForConflict` | — | — |
| Conflict popup columns incl. Source | ✅ Done | `ConflictMatchTable.tsx` (Fix 3) | Watch horizontal width at 6 cols | Low |
| Lead Partner dropdown (active/eligible users) | ✅ Done | `users.leadLawyers` + dialogs; server-validated | Support Lead/Attorneys remain free-text (by design) | — |
| Financial linked-matter dropdown clarity | ✅ Done | `FinancialDialog.tsx` | — | — |
| Counters / refresh after add/edit | ✅ Done | query invalidations | — | — |
| Full manager video scenario end-to-end | ⚠️ Cannot Verify (locally unseeded) | 0 matters / 0 financial in dev DB | Run scenario against created/seeded data | Medium |

---

## 6. CRM-001 to CRM-020 Compact Status

| CRM ID | Requirement | Status | Notes | Priority |
|---|---|---|---|---|
| CRM-001 | Dashboard Leads Metrics | Done | `clientStatusCounts`/dashboard | Low |
| CRM-002 | Active Matters Counter | Done | `activeMatters.test.ts` | Low |
| CRM-003 | Conversion Rate | Done | `conversionRate.test.ts` | Low |
| CRM-004 | Conflict Check Dashboard + Matters | Done | `conflictCheck` + `normalizeForConflict`; Source column added | — |
| CRM-005 | Back Button Navigation | Done | back affordances across pages | Low |
| CRM-006 | Move Client Type → Matter Type | Done | required at matter level | — |
| CRM-007 | Original Serial Fix | Done | inherited, not unique, no MAT/max+1 | — |
| CRM-008 | Hourly Rate Lawyer + Co-Lawyers | Done | `matterLawyerRates` 5/5; unique index `0019` | — |
| CRM-009 | Rejected Client Lock | Done | `assertClientNotRejected`; `rejectedClientLock.test.ts` | — |
| CRM-010 | Financial Records Client Link | Done | `assertMatterBelongsToClient` | — |
| CRM-011 | Skip For Now | N/A | placeholder by design | — |
| CRM-012 | Remove Billed Amount | Done | no mirroring; history preserved | Finance sign-off (High) |
| CRM-013 | New Lead Real-Time Update | Done | `newLeadVisibility.test.ts` + invalidation | Medium |
| CRM-014 | Recent Leads Last 30 Days | Done | `recentLeads.test.ts` | Low |
| CRM-015 | Merge Enquiry Log + Leads Pipeline | Done | `syncLeadToClient`; `enquiries.test.ts` | Medium |
| CRM-016 | Enquiry Timezone | Done | `enquiryDatetime.test.ts`; migration `0013` | Low |
| CRM-017 | Communication Channel Hierarchy | Done | `communicationChannel.test.ts`; migration `0014` | Low |
| CRM-018 | Suggested Lead Lawyer Dropdown + Notifications | Done | `leadLawyerAssignment` 4/4; `user_notifications` | — |
| CRM-019 | Tasks Inside Client Page | Done | `clientTasks.test.ts`; Tasks tab | Medium |
| CRM-020 | Task Role-Based Visibility | Done | `taskVisibility` 5/5 (after teardown fix) | — |

> All non-placeholder CRM items are **Done** with passing test coverage. CRM-012 carries a finance sign-off dependency (documentation already done). The two source DOCX files (`Legal_CRM_Prompts_CRM001_CRM020*.docx`) are byte-identical placeholders with no acceptance criteria — status is derived from titles + code + tests.

---

## 7. Remaining Issues

### Critical
* **None.** Local runtime, DB, login, build, and tests are all green.

### High
1. **Finance formula sign-off (non-code).** `To Be Billed` (Agreed − Revenue), `Outstanding` (Revenue − Collected), and the disposition of legacy `billed_amount` / `remaining_advanced` are implemented and **documented with [NEEDS FINANCE APPROVAL] flags** in `FINANCIAL_FORMULAS.md`. They must be confirmed by Finance rather than changed by engineering.

### Medium
2. **Local Postgres is not a persistent service.** It stopped twice this session, each time breaking login with a generic error until restarted (`pg_ctl start`). Configure it to run as a service / auto-start.
3. **Dev DB has no seed matters or financial records** (`client_matters=0`, `financial_records=0`), so the end-to-end manager video scenario can't be verified without first creating data.
4. **Orphaned test data in the dev DB** (`users≈162`, plus mirrored lead-clients). Harmless to correctness (suite is 104/104 with them present) and runs now self-clean, but the dev DB is noisy. Optional one-off cleanup of `*@x.com` test users.

### Low
5. **Conflict popup width** — 6 columns in a `max-w-3xl` dialog; verify no horizontal scroll on small screens.
6. **Minor copy/labels** — cosmetic only.

---

## 8. Recommended Next Implementation Order

1. **Must fix before continuing:** *Nothing blocking.* Operationally, make local Postgres persistent so login stops dropping (Issue 2).
2. **Should fix next (manager acceptance):** Seed/create a couple of matters + financial records and run the **manual video QA** end-to-end (Issue 3); confirm conflict popup width on small screens (Issue 5).
3. **Finance approval items:** Sign off on `To Be Billed` / `Outstanding` bases and legacy `billed_amount`/`remaining_advanced` disposition (Issue 1); only then make any formula change.
4. **QA / regression:** Keep the full suite green (104/104); re-run `tsc` + `vitest run --no-file-parallelism` before merges; optionally clean orphaned dev-DB test users (Issue 4).
5. **Deployment / Dublyo:** Resolve hosted-DB networking separately from local (see `ONLINE_DEPLOYMENT_AUDIT.md`); do not conflate with local runtime.

---

## 9. Tests and Checks Run

| Command | Result | Notes |
|---|---|---|
| `tsc --noEmit` | ✅ exit 0 | Clean typecheck |
| `vitest run --no-file-parallelism` (full) | ✅ **104 passed / 0 failed** (20 files) | Run sequentially to avoid local connection exhaustion |
| `pnpm build` (`vite build && esbuild`) | ✅ exit 0 | (from prior run this session; `dist/` produced) |
| `GET /health` | ✅ | `databaseUrlSet:true, jwtSecretSet:true` |
| `GET /health/db` | ✅ | `{ok:true}` |
| `POST /api/trpc/auth.login` (admin) | ✅ | HTTP 200, `success:true`, admin/active |
| `SELECT count(*) FROM schema_migrations` | ✅ 20 | Migration ledger populated |

* **Failures:** none.
* **Skipped:** none. (No dedicated lint script exists — `format` = prettier, not run to avoid file changes; lint **cannot be verified** separately.)
* **DB-backed test status:** ✅ all DB-backed suites pass (conflict, original-serial, financial, lawyer-rates, payments, task-visibility, lead-lawyer, intake-filters, etc.).

---

## 10. Final Recommendation

**✅ Safe to continue development.**

The Legal CRM runs locally end-to-end (env configured, DB connected, migrations applied + ledgered, health green, login working), the full test suite is **104/104**, `tsc` is clean, and the build succeeds. All Phase 1–6 remediations and the Top-5 follow-up fixes are complete with evidence and test coverage.

There are **no Critical blockers**. The only **High** item is a non-code **Finance sign-off** on already-documented formulas. The most impactful operational improvement is making the **local Postgres persistent** so login stops intermittently failing. End-to-end manager-video verification is the main remaining QA step and simply needs seeded matter/financial data.
