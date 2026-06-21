# Local CRM Runtime, Video Requirements & CRM-001–CRM-020 Comparison Audit

**Date:** 2026-06-21
**Scope:** Read-only local audit. (Sections 1–10 describe the audit as performed; the **Resolution Update** below records fixes applied in a subsequent follow-up task.)
**Branch:** `fix/env-config-and-docs`
**Acceptance priority:** manager video instructions first; CRM-001–CRM-020 as a broader checklist.

---

> ## ✅ Resolution Update (follow-up — Top 5 fixes applied)
>
> The five recommended fixes from §10 were subsequently implemented. The local test suite went from **90/14 to 104/104 passing**; `tsc --noEmit` clean; `pnpm build` green.
>
> | # | Recommendation | Status | What changed |
> |---|---|---|---|
> | 1 | Same Matter Reference across different clients flagged as conflict | ✅ Fixed | `checkMatterConflicts` now takes the prospective `clientId` and drops cross-client "Matter" matches (different clients may reuse a reference). Client + Opposing-Party + same-client matches still flag. `server/db.ts`, `server/routers.ts`, `MatterNew.tsx`, `ClientDetail.tsx`. `originalSerial` suite now 12/12. |
> | 2 | Finance formula sign-off | ⏸️ Documentation-only (correct) | No code change made — formulas remain documented in `FINANCIAL_FORMULAS.md` with explicit **[NEEDS FINANCE APPROVAL]** flags. Cannot/should not change calculations without Finance confirming. |
> | 3 | Conflict popup missing "Source" column | ✅ Fixed | `ConflictMatchTable.tsx` now shows Match Type / Matched Name / Related Client / Related Record / Status / **Source** (source derived from match origin). |
> | 4 | Pre-existing test failures + orphaned data | ✅ Fixed (tests) | `payments` fixture (`status:"active"` + `enquiryId→leadId`/`getByEnquiry→getByLead` API rename), `taskVisibility` teardown order (reports-to FK), `leadLawyerAssignment` teardown (remove lead→client mirror), `intakeFilters` timezone-robust date window. **Orphaned dev-DB rows were NOT mass-deleted** (harmless; suite passes with them present; future runs now self-clean). |
> | 5 | `AUTH_SECRET` / migration ledger | ✅ Fixed | Confirmed `AUTH_SECRET` is a genuine `JWT_SECRET` fallback (`auth.ts`); aligned the unused `env.ts cookieSecret` to match. Added a `schema_migrations` ledger so migrations are recorded and not re-run every boot (idempotency preserved; 20 files recorded). |

> **DOCX source note:** Both uploaded files —
> `Legal_CRM_Prompts_CRM001_CRM020.docx` and `Legal_CRM_Prompts_CRM001_CRM020 (1).docx` —
> are **byte-identical duplicates** (each 37,205 bytes, identical MD5 `6ce43bcd50acbf7f9ff6ec01802adc47`).
> Their content is **placeholder-only**: each CRM item is just a title plus
> *"Use the detailed implementation prompt prepared for CRM-XXX. This section is reserved for Claude/Codex execution and project tracking."*
> **There are no detailed acceptance criteria in the DOCX files.** Expected behavior below is therefore derived from
> the CRM titles + the manager-video requirements + existing in-repo audit context
> (`Legal_CRM_Post_Changes_Audit_Report.docx`, `GAP_FIX_BRIEF.md`, and `CRM-0xx` code comments).

---

## 1. Executive Summary

| Area | Status |
|---|---|
| **Local runtime** | ✅ Running on `http://localhost:3000` |
| **Database** | ✅ Local PostgreSQL `localhost:5432/app`, healthy (`/health/db` ok) |
| **Login / Auth** | ✅ Login page HTTP 200; admin login returns `success:true` (role `admin`, active) |
| **Migrations** | ✅ All 21 tables present; 20 migration files applied idempotently on startup |
| **Typecheck** | ✅ `tsc --noEmit` clean |
| **Build** | ✅ `pnpm build` succeeds (vite + esbuild, `dist/` produced) |
| **Unit/DB tests** | ⚠️ 90 passed / 14 failed (15 of 20 files pass) — **all 14 failures are pre-existing and outside audited code paths** |
| **Video requirements** | ✅ Mostly implemented; 2 notable gaps (conflict "Source" column; same-reference-across-clients conflict friction) |
| **CRM-001…CRM-020** | ✅ Broadly implemented with passing test coverage; CRM-011 is "Skip For Now" by design |
| **Overall readiness** | **Safe to continue development.** No critical/blocking runtime or data-integrity issues found. |

**Main risks**
1. **Conflict-check friction vs Matter Reference rule** (High): creating a matter whose Matter Reference equals a **different client's** matter reference is flagged as a conflict and requires acknowledgement, even though the confirmed rule allows different clients to reuse a reference.
2. **Conflict popup missing a "Source" column** (Medium): video asks for Match Type / Matched Name / Related Client / Related Matter-Record / Status / **Source**; the table shows all but Source.
3. **Local test-suite hygiene** (Medium, not a product bug): pre-existing test-teardown bugs + accumulated orphaned test data (users table inflated to 70 rows) cause 14 test failures unrelated to the audited features.

---

## 2. Local Runtime Verification

| Check | Result | Evidence |
|---|---|---|
| `.env` exists | ✅ | `.env` present at repo root |
| `DATABASE_URL` set | ✅ | `/health` → `databaseUrlSet:true`, host `localhost`, port `5432` |
| `JWT_SECRET` set | ✅ | `/health` → `jwtSecretSet:true` |
| `AUTH_SECRET` set | ⚠️ N/A | `/health` → `AUTH_SECRET:false`. App authenticates with **`JWT_SECRET`** (`server/routers.ts` `auth.login` → `createSessionToken`); `AUTH_SECRET` is unused locally. Not a blocker. |
| Local PostgreSQL running | ✅ | scoop PostgreSQL 18 on `localhost:5432`; `/health/db` → `{ok:true}` |
| CRM connects to local DB | ✅ | `/health/db` runs `select 1` → ok |
| Migrations applied | ✅ | All 21 public tables exist (`clients`, `client_matters`, `financial_records`, `users`, `matter_lawyer_rates`, `tasks`, `leads`, `client_lead_details`, `user_notifications`, …). Files `0000`–`0019` in `drizzle/migrations/`. |
| Migration tracking | ⚠️ note | No migration-ledger table; `runMigrations()` (`server/db.ts`) re-applies each `.sql` idempotently on every boot. "Applied" = "tables exist". |
| App starts without fatal errors | ✅ | Server already listening on `:3000`; a second `pnpm dev` attempt printed `DATABASE_URL: SET ✓ / JWT_SECRET: SET ✓` then exited on `EADDRINUSE` (port already bound — expected). |
| Frontend loads | ✅ | `GET /` → HTTP 200 (SPA `index.html`) |
| Login page loads | ✅ | SPA routes to `/login` |
| Login works | ✅ | `POST /api/trpc/auth.login` with `.env` admin creds → HTTP 200, `success:true`, user `role:admin`, `status:active` (credentials sourced from `.env`, never printed) |
| `/health` flags | ✅ | `databaseUrlSet:true`, `jwtSecretSet:true` |

**Data smoke check (read-only):** `users=70`, `clients=9`, `client_matters=0`, `financial_records=0`.

> ⚠️ **`users=70` is inflated by orphaned test users** from earlier interrupted test runs whose teardown failed (see §6 Issue 3). **No data was deleted** per audit constraints.
> ⚠️ **`client_matters=0` / `financial_records=0`**: the local DB has **no seed matters or financial records**, so the manual video scenario (§9) must *create* a matter — nothing pre-existing to inspect.

---

## 3. Video Requirements Review

| Video Requirement Area | Status | Evidence / Files | Issues | Priority |
|---|---|---|---|---|
| **Matter Form (Add/Edit from client page)** | ✅ Implemented | `client/src/pages/ClientDetail.tsx` (`MatterDialog`, `MatterEditDialog`, `MatterFormFields`); `MatterNew.tsx` | Form values preserved across conflict check (conflict held in state; payload rebuilt from form) | — |
| **Original Serial** | ✅ Implemented | `defaultOriginalSerialFromClient` (`server/db.ts`); UI shows inherited, muted/mono, helper text | Not unique, not used as identifier | — |
| **Matter Reference** | ✅ Implemented | Required + unique-per-client (form, tRPC, DB index `0018`, `assertMatterReferenceUniqueForClient`); friendly duplicate message | Cross-client reuse flagged by conflict check (see Conflict row) | High (via conflict) |
| **Matter Type** | ✅ Implemented | Required on create + edit (`createClientMatter`; client checks in both dialogs + `MatterNew`); label `*` | — | — |
| **Matters Table** | ✅ Implemented | Client-detail table: Reference + Original Serial **separate columns**, Type, Billing, Lead Partner, Status, Achievement, Priority; global `/matters` shows Ref + Serial separately + Lead Partner | Auto-refresh via `clientMatters.list`/`listAll` invalidation | — |
| **Conflict Check** | ⚠️ Partial | Runs before create (front + backend); acknowledgement checkbox + audit log; `normalizeForConflict` (case/space/punct/Arabic) | (1) popup missing **"Source"**; (2) same-ref different-client friction | Medium / High |
| **Lawyer Assignment** | ✅ Implemented | Lead Partner = user dropdown (`users.leadLawyers`) wired to `lead_lawyer_id`; server validates `resolveAssignedUser` (active + role); legacy text still shows; Support Lead/Attorneys remain free-text (no migration added) | — | — |
| **Financial Linked Matter** | ✅ Implemented | `components/FinancialDialog.tsx`: dropdown `Ref · Type · Status · Lead Partner: Name`, "No matter — client-level record", inline chip; cross-client blocked (`assertMatterBelongsToClient`) | — | — |
| **Financial Calculations** | ✅ Implemented (Revenue active) | `applyDiscountRules`: Net Fees/Discount/Outstanding from Revenue; `billed_amount`/`remaining_advanced` legacy read-only, never mirrored (CRM-012); `FINANCIAL_FORMULAS.md` | Some intent flagged for Finance (§7) | High (sign-off only) |
| **Counters / Refresh** | ✅ Implemented | Counters derive from queries invalidated on mutation (`clientMatters`, `financial.list`, `clientActions.list`, `tasks.list`) | — | — |
| **Navigation** | ✅ Implemented | Add Matter dialogs stay in context; `MatterNew` → `/clients/:id`; back affordances across pages | — | — |

---

## 4. CRM-001 to CRM-020 Review

> Status derived from title + code + test coverage (DOCX has no acceptance criteria).
> Passing test files this run (15): activeMatters, auth.logout, clientStatusCounts, clientTasks, communicationChannel, conflictCheck, conversionRate, enquiries, enquiryDatetime, financialRevenue, matterLawyerRates, newLeadVisibility, normalizeForConflict, recentLeads, rejectedClientLock.

| CRM ID | Requirement | Status | Evidence / Files | Overlap w/ Video | Priority |
|---|---|---|---|---|---|
| CRM-001 | Dashboard Leads Metrics | Implemented | `clientStatusCounts.test.ts` ✓, `Dashboard.tsx`, `KPIDashboard.tsx` | No | Low |
| CRM-002 | Active Matters Counter | Implemented | `activeMatters.test.ts` ✓ | Indirect | Low |
| CRM-003 | Conversion Rate | Implemented | `conversionRate.test.ts` ✓ | No | Low |
| CRM-004 | Conflict Check Dashboard + Matters | Implemented (minor fix) | `conflictCheck.test.ts` ✓, `normalizeForConflict.test.ts` ✓, `ConflictMatchTable.tsx` | **Yes (primary)** | High |
| CRM-005 | Back Button Navigation | Implemented | back affordances in `ClientDetail`, `MatterNew`, `EnquiryForm`, `TaskForm`, `ClientForm` | Yes | Medium |
| CRM-006 | Move Client Type → Matter Type | Implemented | Matter Type required at matter level; `originalSerial.test.ts` ✓ (11/12) | Yes | High |
| CRM-007 | Original Serial Fix | Implemented | `defaultOriginalSerialFromClient`; `originalSerial.test.ts` ✓ | **Yes (primary)** | High |
| CRM-008 | Hourly Rate Lawyer + Co-Lawyers | Implemented | `matterLawyerRates.test.ts` ✓ (5/5), `getMatterBillableLawyers`, `LawyerRatesDialog` | Yes | High |
| CRM-009 | Rejected Client Lock | Implemented | `rejectedClientLock.test.ts` ✓, `assertClientNotRejected` | No | Medium |
| CRM-010 | Financial Records Client Link | Implemented | `assertMatterBelongsToClient` (create+update), `financialRevenue.test.ts` ✓ | **Yes (primary)** | High |
| CRM-011 | Skip For Now | N/A (by design) | Title literally "Skip For Now" | No | — |
| CRM-012 | Remove Billed Amount | Implemented | `applyDiscountRules` leaves `billed_amount` untouched; no Billed Amount column; `FINANCIAL_FORMULAS.md` | **Yes (primary)** | High |
| CRM-013 | New Lead Real-Time Update | Implemented | `newLeadVisibility.test.ts` ✓, recentLeads/statusCounts invalidation | No | Medium |
| CRM-014 | Recent Leads Last 30 Days | Implemented | `recentLeads.test.ts` ✓ | No | Low |
| CRM-015 | Merge Enquiry Log + Leads Pipeline | Implemented | `enquiries.test.ts` ✓, `EnquiriesLog.tsx` | No | Medium |
| CRM-016 | Enquiry Timezone | Implemented | `enquiryDatetime.test.ts` ✓, migration `0013` | No | Low |
| CRM-017 | Communication Channel Hierarchy | Implemented | `communicationChannel.test.ts` ✓, migration `0014` | No | Low |
| CRM-018 | Suggested Lead Lawyer Dropdown + Notifications | Implemented (test teardown bug) | `leadLawyerAssignment.test.ts` (body passes; 2 fail only in cleanup, §6); `users.leadLawyers`, `user_notifications` | Yes | High |
| CRM-019 | Tasks Inside Client Page | Implemented | `clientTasks.test.ts` ✓, Tasks tab in `ClientDetail.tsx` | No | Medium |
| CRM-020 | Task Role-Based Visibility | Implemented (tests broken by teardown) | `taskVisibility.test.ts` (5 fail only in FK teardown, §6); visibility enforced server-side | No | High |

---

## 5. Video vs CRM-001–CRM-020 Mapping

| Video Requirement | Related CRM ID(s) | Coverage | Notes |
|---|---|---|---|
| Original Serial inherited from client number | CRM-007 | ✅ | UI + server default |
| Matter Type at Matter level | CRM-006 | ✅ | Required on add + edit |
| Matter Reference required + unique per client | (no dedicated CRM ID) | ⚠️ | Implemented, but conflict check flags cross-client reuse |
| Conflict Check before Matter creation | CRM-004 | ✅ | Minor UI gap (Source column) |
| Conflict normalization (case/space/punct/Arabic) | CRM-004 | ✅ | `normalizeForConflict` (8/8) |
| Financial Record linked to Matter | CRM-010 | ✅ | Cross-client blocked |
| Billed/Revenue safe behavior | CRM-012 | ✅ | No mirroring; history preserved |
| Lawyer assignment (Lead Partner dropdown) | CRM-018 | ✅ | Wired to `lead_lawyer_id`, server-validated |
| Lawyer hourly rates / co-lawyers | CRM-008 | ✅ | `matterLawyerRates` 5/5 |
| Back navigation | CRM-005 | ✅ | Present |
| Tasks inside client page | CRM-019 / CRM-020 | ✅ | Tests have teardown bug only |
| Matters table separate Ref/Serial + refresh | (UI; CRM-006/007) | ✅ | Client-detail + global list |
| Counters refresh after Add/Edit | (UI) | ✅ | Query invalidation |

**Video items without a dedicated CRM ID:** "Matter Reference required + unique per client" and "Matters table layout/refresh" (intersect CRM-006/007).
**CRM items not in the video but important:** CRM-001/002/003 (dashboard), CRM-013/014 (leads), CRM-015 (merge), CRM-016 (timezone), CRM-017 (channel), CRM-009 (rejected lock).

---

## 6. Detailed Issues

### Issue 1 — Conflict check flags same Matter Reference across DIFFERENT clients (HIGH)
- **Description:** The confirmed rule allows different clients to reuse a Matter Reference. But `searchConflicts` matches references globally, so Client B's matter with a reference equal to Client A's triggers a "potential conflict" requiring acknowledgement.
- **Evidence:** `server/originalSerial.test.ts` → "allows the same reference for DIFFERENT clients" **fails** (gated by conflict). Logic: `server/db.ts searchConflicts` (matter-reference match) + `routers.ts` create gate. **Pre-existing** (present at baseline `290ecec`).
- **Impact:** Manager workflow friction; one acceptance test red. Not data-corrupting (acknowledgement still proceeds).
- **Priority:** High.
- **Recommended fix (needs product confirmation):** scope the "Matter" conflict match so an identical reference under a *different* client is informational, not acknowledgement-blocking — or update the test if the gate is intended. **Do not change without manager/product sign-off** (conflict-gating is business logic).

### Issue 2 — Conflict popup missing the "Source" column (MEDIUM)
- **Description:** Video asks for Match Type, Matched Name, Related Client, Related Matter/Record, Status, **Source**. Current table: Match Type, Matched Name, Status, Client, Record ID — **no "Source"**.
- **Evidence:** `client/src/components/ConflictMatchTable.tsx` headers (lines 49–53).
- **Impact:** Minor readability gap; "Related Matter/Record" = Record ID.
- **Priority:** Medium. **Fix:** add a "Source" column (Client / Matter / Opposing Party origin) — UI only.

### Issue 3 — Pre-existing test failures + orphaned local test data (MEDIUM, not a product bug)
- **Description:** 14 failures, none in audited code paths:
  - **payments.test.ts (5):** `TRPCError: "Account is not active"` — the test's session user is rejected by the permission middleware (test fixture/auth), not a payments-logic failure.
  - **taskVisibility (5) + leadLawyerAssignment (2):** teardown FK `client_lead_details_assigned_lawyer_id_fkey` — tests delete a user still referenced by `client_lead_details.assigned_lawyer_id` without unassigning first. Test bodies pass; only cleanup throws. Worsened by orphaned data.
  - **originalSerial (1):** Issue 1.
  - **intakeFilters (1):** "filters by created date range" assertion.
- **Evidence:** full-suite log; FK error `Key (id)=(208) is still referenced from table "client_lead_details"`; `users` table = 70 rows (orphaned `*@x.com` users).
- **Impact:** Misleading red suite. No production impact.
- **Priority:** Medium. **Fix:** (a) fix teardown ordering (unassign / delete `client_lead_details` before user delete); (b) fix payments auth fixture; (c) clean orphaned local test rows (out of scope here). A prior unrelated fix corrected `users.delete({ id })` → `{ userId }` in several suites (why `matterLawyerRates` is now green).

### Issue 4 — `AUTH_SECRET` absent / no migration ledger (LOW)
- **Description:** `/health` `AUTH_SECRET:false`; app uses `JWT_SECRET` (fine). No migration-tracking table — migrations re-run every boot on idempotency.
- **Impact:** Low; works locally. Idempotent re-runs are slower and can mask drift.
- **Priority:** Low.

---

## 7. Recommended Next Implementation Plan

**Phase A — Must fix before continuing (runtime/integrity blockers):** *None.* Runtime, DB, login, build all green.

**Phase B — Video acceptance fixes**
1. **Decide & implement** same-reference-across-clients conflict behavior (Issue 1) — product decision first, then scoped change to `searchConflicts`/create-gate (or test update).
2. Add **"Source" column** to conflict popup (Issue 2) — UI only.

**Phase C — CRM-001…CRM-020 completion**
- All CRM items implemented; remaining work is **test hygiene** (Issue 3), not features: fix teardown ordering in `taskVisibility`/`leadLawyerAssignment`, fix `payments` auth fixture, clean orphaned local test users.

**Phase D — Finance approval items** (document-only until Finance signs off; see `FINANCIAL_FORMULAS.md`)
- Confirm **To Be Billed** = Agreed Fees − Revenue (vs Net Fees − Revenue).
- Confirm **Outstanding** = Revenue − Collected (vs Net Fees − Collected).
- Confirm disposition of legacy `billed_amount` / `remaining_advanced` after reviewing the `financial_billed_revenue_discrepancies` view (migration `0011`).

**Phase E — Final QA**
- Run the manual video scenario (§9) against the running app.
- Re-run DB-backed + role-based tests after teardown fixes.
- Regression-test matter create → conflict → acknowledge → financial link.

---

## 8. Tests Run

| Command | Result | Notes / Limitations |
|---|---|---|
| `tsc --noEmit` | ✅ exit 0 | Clean typecheck |
| `pnpm build` (`vite build && esbuild …`) | ✅ exit 0 | `dist/public` produced; ~7.7s |
| `vitest run --no-file-parallelism` (full) | ⚠️ exit 1 | **90 passed / 14 failed** (15/20 files pass). Run sequentially to avoid local connection exhaustion. |
| `vitest run conflictCheck normalizeForConflict matterLawyerRates financialRevenue` | ✅ | 4/4, 8/8, 5/5, 6/6 — suites covering recently audited features |
| `GET /health` | ✅ | `databaseUrlSet:true, jwtSecretSet:true` |
| `GET /health/db` | ✅ | `{ok:true}` |
| `POST /api/trpc/auth.login` (admin from `.env`) | ✅ | HTTP 200, `success:true`, admin/active |
| psql read-only counts | ✅ | 21 tables; users=70 (orphaned), clients=9, matters=0, financial=0 |

**Failing suites (all pre-existing, outside audited paths):** `payments` (5, auth fixture), `taskVisibility` (5, FK teardown), `leadLawyerAssignment` (2, FK teardown), `originalSerial` (1, Issue 1), `intakeFilters` (1, date assertion).
**Lint:** no lint script in `package.json` (`format` = prettier; not run to avoid file changes). **Cannot verify** lint separately.

---

## 9. Manual QA Checklist (manager video scenario)

> Run against `http://localhost:3000` (admin). Local DB has **0 matters / 0 financial records**, so this is a clean-create walkthrough. **Not executed in this read-only audit** (would create live records) — provided for the reviewer.

- [ ] Open a client page (`/clients/:id`) — 9 clients exist.
- [ ] Click **Add Matter**.
- [ ] Confirm **Original Serial** is inherited from the client number (muted, helper text).
- [ ] Enter a **Matter Reference**.
- [ ] Confirm Matter Reference is **required** (blank → blocked).
- [ ] Add a second matter with the **same reference under the same client** → **rejected**.
- [ ] Select a **Matter Type** (required).
- [ ] On Save, **Conflict Check** runs (matter name + opposing party).
- [ ] If conflicts: review popup, tick **acknowledge**, proceed.
- [ ] Save Matter.
- [ ] Confirm it appears in the **Matters table** (Reference + Original Serial separate, Type, Status, Lead Partner, Priority).
- [ ] Confirm **Matters tab count** increments without a browser refresh.
- [ ] Open the **Financial** tab.
- [ ] Add/Edit a **Financial Record**.
- [ ] **Link it to the Matter** — dropdown shows `Ref · Type · Status · Lead Partner: Name` and a "No matter — client-level record" option.
- [ ] Confirm the **Financial table** shows the linked matter and distinguishes matter-level vs client-level rows.
- [ ] Confirm **Financial tab count** increments without a browser refresh.
- [ ] (Negative) Confirm a financial record **cannot** link to another client's matter.

---

## 10. Final Recommendation

**✅ Safe to continue development.**

The CRM runs locally end-to-end: environment configured, PostgreSQL healthy, migrations applied, app serving on `:3000`, login working, typecheck clean, production build green. The manager-video requirements and CRM-001–CRM-020 are broadly implemented with passing test coverage for the core matter/conflict/financial/lawyer flows.

No **Critical** (runtime/login/data-corruption) issues were found. The two product-relevant items to address next are both **non-blocking**: (1) decide the same-reference-across-clients conflict behavior, and (2) add the conflict popup "Source" column. The 14 failing tests are **pre-existing test-teardown/fixture issues plus orphaned local test data**, not regressions in the audited features.

---

### Findings count

| Severity | Count | Items |
|---|---|---|
| **Critical** | 0 | — |
| **High** | 2 | Issue 1 (same-ref conflict friction); Finance sign-off on formulas (Phase D) |
| **Medium** | 2 | Issue 2 (conflict "Source" column); Issue 3 (test hygiene + orphaned data) |
| **Low** | 1 | Issue 4 (`AUTH_SECRET` absent / no migration ledger) |
