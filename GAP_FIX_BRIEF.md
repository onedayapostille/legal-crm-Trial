# AlGhazzawi CRM — Gap Fix Brief
**For a new chat session to implement all fixes without prior context.**

---

## Project Overview

- **Repo:** `D:\github\legal-crm-Trial` (or wherever you cloned it)
- **Branch to work on:** create a new branch from `claude/alghazzawi-clients-module`
- **Stack:** tRPC v11 · Drizzle ORM · PostgreSQL · React + Wouter · TypeScript
- **Key files:**
  - Schema: `drizzle/schema.ts`
  - Backend router: `server/routers.ts`
  - Backend helpers: `server/db.ts`
  - Shared constants: `shared/const.ts`
  - Frontend pages: `client/src/pages/`
  - Migrations run automatically on server start via `drizzle-kit push` or the auto-migration in `server/db.ts`

---

## How the App is Structured

### Data Model (AlGhazzawi Module)
```
clients                   — master client record (clientNumber, fileNumber, clientName, clientStatus, city, matterType)
  └── client_matters      — one or more matters per client (attorney codes, matter status, achievement %)
  └── client_lead_details — pipeline fields for Leads-status clients (nextActionDate, clientSource, leadStatus)
  └── rejected_clients    — rejection reason/notes for Rejected-status clients
  └── financial_records   — financial per client-matter (fees, discounts, billing, collection)
  └── client_action_logs  — activity log per client (actionType, actionOwner, nextStep, actionDate)

tasks                     — follow-up tasks (linked to clientMatterId, clientActionLogId)
users                     — CRM login accounts (role: admin/manager/partner/lawyer/finance/staff/viewer)
```

### Discount Logic (already implemented — DO NOT change)
`discountPercentage`, `discountAmount`, `netFees`, `remainingAdvanced`, `outstandingAmount` are ALL calculated server-side by `applyDiscountRules()` in `server/db.ts`. The frontend sends only: `agreedFees`, `discountApproval`, `billedAmount`, `revenue`, `collectedAmount`. Never allow the user to input the calculated fields.

### Routing
- `/clients` → `ClientList`
- `/clients/:id` → `ClientDetail` (tabs: Overview, Matters, Actions, Financial)
- `/clients/new` → `ClientForm`
- `/matters` → `MatterList` (reads `client_matters` via `trpc.clientMatters.listAll`)
- `/matters/new` → `MatterNew`
- `/financial` → `FinancialRecords` (global list)
- `/client-actions` → `ClientActionLog` (global list)
- `/tasks` → `TaskList`

### Permissions
- `clients:manage` — create/edit/delete clients and matters
- `financial:manage` / `financial:view` — financial records
- `actions:manage` — action log
- `:manage` implies `:view` for the same resource (see `hasPermission` in `shared/const.ts`)

---

## Full Gap Analysis (41 gaps)

These were identified by comparing the CRM against the Excel workbook. Fix them in phase order.

---

## Phase 1 — Foundation: Lookup Tables & Enums
**No UI. Schema + seed only. ALL other phases depend on this.**

### Gaps to close: #7, #8, #20, #38, #39, #40, #41

### 1A — Add `staff_codes` table to `drizzle/schema.ts`

```typescript
export const staffCodes = pgTable("staff_codes", {
  code: varchar("code", { length: 20 }).primaryKey(),
  fullName: varchar("full_name", { length: 255 }).notNull(),
  role: varchar("role", { length: 100 }),   // e.g. "Partner", "Associate", "Of Counsel"
  isActive: boolean("is_active").default(true).notNull(),
});
```

Seed these 11 records (exact codes from Excel Reference sheet — update names/roles from actual Excel file):
```
JAA, MTB, SAA, KAM, NAA, FAA, RAA, MAA, HAA, AAA, DAA
```
Add a tRPC procedure `staffCodes.list` (public within auth) so the frontend can populate dropdowns.

### 1B — Convert `matterStatus` from `varchar(100)` to enum

In `drizzle/schema.ts`, add:
```typescript
export const clientMatterStatusEnum = pgEnum("client_matter_status", [
  "Active",
  "In Progress",
  "On Hold",
  "Completed",
  "Cancelled",
]);
```
Change `client_matters.matterStatus` from `varchar("matter_status", { length: 100 })` to `clientMatterStatusEnum("matter_status")`.

Write migration: `ALTER TYPE` or drop+recreate enum, `ALTER COLUMN matter_status TYPE client_matter_status USING matter_status::client_matter_status`.

### 1C — Add `achievementStatusEnum`

```typescript
export const achievementStatusEnum = pgEnum("achievement_status", [
  "On Track",
  "Delayed",
  "Completed",
  "At Risk",
]);
```
Change `client_matters.achievementStatus` to use this enum.

### 1D — Add `actionTypeEnum`

```typescript
export const actionTypeEnum = pgEnum("action_type", [
  "Meeting",
  "Call",
  "Email",
  "Filing",
  "Court Hearing",
  "Document Review",
  "Internal",
  "Other",
]);
```
Change `client_action_logs.actionType` to use this enum.

### 1E — Add `clientSourceEnum`

```typescript
export const clientSourceEnum = pgEnum("client_source", [
  "Referral",
  "Website",
  "Existing Client Referral",
  "Walk-in",
  "Cold Outreach",
  "Other",
]);
```
Change `client_lead_details.clientSource` and the new `clients.clientSource` (added in Phase 2) to use this enum.

---

## Phase 2 — Matters Module
**Depends on Phase 1.**

### Gaps to close: #5, #9, #10, #11, #12, #13, #14

### 2A — Add missing columns to `client_matters`

```typescript
// in clientMatters table definition:
whatShouldHappenNextNow: text("what_should_happen_next_now"),
legacyNote: text("legacy_note"),
nextActionDate: date("next_action_date"),
nextActionOwner: varchar("next_action_owner", { length: 100 }),  // staff code
```

Update `clientMatters.create` and `clientMatters.update` Zod schemas in `server/routers.ts` to accept these fields.

### 2B — Add `clientSource` to `clients` table

```typescript
// in clients table definition:
clientSource: clientSourceEnum("client_source"),
```

When `clients.update` changes `clientStatus` from `"Leads"` to `"Existing Client"`, copy `client_lead_details.clientSource` → `clients.clientSource` in the same transaction.

### 2C — Staff code dropdowns in MatterNew and MatterDialog

In `client/src/pages/MatterNew.tsx` and the `MatterDialog` in `ClientDetail.tsx`:
- Replace free-text `Input` for `leadPartner`, `supportLead`, `attorneyHead`, `attorney1`, `attorney2`, `attorney3` with `Select` dropdowns populated from `trpc.staffCodes.list.useQuery()`.
- On selection of `leadPartner`, auto-fill `leadPartnerFullName` from the selected staff code's `fullName`. Same for `attorney1` → `attorneyFullName`.
- `nextActionOwner` dropdown (also from staff codes) added to MatterDialog.

### 2D — Show matter-level next action in ClientDetail Matters tab

In `ClientDetail.tsx` `MattersTable` component, add columns:
- Next Action Date (`nextActionDate`)
- Next Action Owner (`nextActionOwner`)
- What Happens Next (`whatShouldHappenNextNow`)

In the edit dialog for a matter, add fields for these three columns.

---

## Phase 3 — Financial Module
**Depends on Phase 2 (matters must exist and have staff codes).**

### Gaps to close: #16, #17, #19

### 3A — Matter selector in FinancialDialog (`ClientDetail.tsx`)

`FinancialDialog` currently has no matter selector. Add a required `Select` dropdown:
```
trpc.clientMatters.list.useQuery({ clientId })
```
The selected `clientMatterId` is sent in the create/update payload. The router already accepts `clientMatterId` as optional — make it required.

### 3B — Auto-derive `responsibleLawyer`

After selecting a matter in FinancialDialog:
1. Look up the matter's `leadPartnerFullName` — if non-empty, set `responsibleLawyer` to that value (read-only display).
2. Fallback: use `attorneyFullName` from the matter.
3. Allow manual override by enabling the field if user clears the auto-filled value.

### 3C — Add matter reference column to FinancialRecords global list

In `client/src/pages/FinancialRecords.tsx`, the `trpc.financial.list` query must also return the matter reference. Update the router's `financial.list` procedure to join `client_matters` and return `matterReference` alongside each record. Add a "Matter" column to the table.

---

## Phase 4 — Action Log & Tasks
**Depends on Phase 1 (actionType enum). Depends on Phase 2 (staff codes for actionOwner).**

### Gaps to close: #22, #23, #24, #25, #26

### 4A — Add `status` and `nextActionDate` to `client_action_logs`

```typescript
// in clientActionLogs table:
status: varchar("status", { length: 50 }).default("Pending"),  // Pending | Done | Cancelled
nextActionDate: date("next_action_date"),
```

Update Zod schemas in `server/routers.ts` for `clientActions.create` and `clientActions.update`.

### 4B — Convert `actionOwner` and `actionType` to dropdowns

In `ActionDialog` (inside `ClientDetail.tsx`):
- `actionOwner`: replace `Input` with `Select` from `trpc.staffCodes.list`
- `actionType`: replace `Input` with `Select` from `actionTypeEnum` values

### 4C — Auto-create task from `nextStep`

In `clientActions.create` router procedure (`server/routers.ts`), after inserting the action log row:
```typescript
if (input.nextStep && input.nextStep.trim().length > 0) {
  await db.insert(tasks).values({
    title: input.nextStep.trim(),
    clientId: input.clientId,
    clientMatterId: input.clientMatterId ?? null,
    clientActionLogId: newActionId,
    dueDate: input.nextActionDate ?? null,
    status: "todo",
    priority: "medium",
    createdBy: ctx.user.id,
  });
}
```
This makes every logged action with a next step automatically create a task. No UI change needed for task creation — it happens server-side.

### 4D — Add filters to `/client-actions` global page

In `client/src/pages/ClientActionLog.tsx`, add:
- Filter by `actionType` (Select dropdown, all enum values + "All")
- Filter by date range (two date inputs: from/to)
- Pass filters to `trpc.clientActions.list` query (update router to accept these params)

---

## Phase 5 — Dashboard & Reports
**Depends on Phase 1. Can run in parallel with Phase 3/4.**

### Gaps to close: #1, #2, #3, #34, #35, #36, #37

### 5A — Fix Dashboard `activeMatters` KPI

In `server/routers.ts`, find the dashboard stats procedure. Change the query that counts `activeMatters` from:
```typescript
// WRONG — reads old matters table
db.select({ count: count() }).from(matters).where(eq(matters.status, "active"))
```
To:
```typescript
// CORRECT — reads client_matters
db.select({ count: count() }).from(clientMatters)
  .where(eq(clientMatters.matterStatus, "Active"))
```

### 5B — Add client status breakdown to Dashboard

The endpoint `trpc.clients.statusCounts` already returns `{ existing, leads, rejected }`. Add three summary cards to the Dashboard page showing these counts.

### 5C — Add financial summary widget to Dashboard

Add a row of cards: Total Revenue, Total Outstanding, Overdue Count — same data as `/financial` summary cards, just surfaced on the Dashboard.

### 5D — Rewire analytics pages

Audit these four pages and update all tRPC queries to use `client_matters`/`clients`/`financial_records` instead of `leads`/`matters`:
- `client/src/pages/KPIDashboard.tsx`
- `client/src/pages/StatusTracker.tsx`
- `client/src/pages/PaymentTracker.tsx`
- `client/src/pages/PipelineForecast.tsx`

Update the corresponding router procedures in `server/routers.ts`.

### 5E — Fix `/clients/rejected` page

`client/src/pages/ClientsRejected.tsx` — ensure it fetches `rejected_clients` detail rows and shows `rejectionReasonSource`, `rejectionNotes`, `rejectedBy` alongside client info.

### 5F — Add CSV export to filtered client lists

In `ClientsExisting`, `ClientsLeads`, `ClientsRejected` — add an "Export CSV" button that triggers a `window.open` or `fetch` to a new router endpoint `clients.exportCsv` that streams a CSV.

---

## Phase 6 — Team & Polish
**Depends on Phase 1. Can start after Phase 2.**

### Gaps to close: #4, #6, #15, #27, #31, #32, #33

### 6A — Link `users` to `staff_codes`

```typescript
// in users table:
staffCode: varchar("staff_code", { length: 20 }).references(() => staffCodes.code),
```

In `UserManagement` page — add a "Staff Code" field when creating/editing a user. This links a CRM login account to an attorney code.

When auto-creating tasks from action log (Phase 4C), resolve `nextActionOwner` staff code → `users.staffCode` → `users.id` to set `task.assignedTo`.

### 6B — Staff Codes admin section in UserManagement

Add a "Staff Codes" tab/section to `client/src/pages/UserManagement.tsx` (admin-only). Simple CRUD table backed by `trpc.staffCodes.create/update/delete` procedures.

### 6C — Add `notes` field to `clients`

```typescript
// in clients table:
notes: text("notes"),
```

Show a "Notes" textarea in the Overview tab of `ClientDetail.tsx` under `ClientInfoCard`.

### 6D — Uniqueness constraint on `originalSerial`

```sql
ALTER TABLE client_matters ADD CONSTRAINT client_matters_original_serial_unique UNIQUE (original_serial);
```
Handle the constraint error gracefully in the router (return a user-friendly message).

---

## Summary of All Gaps

| # | Module | Issue | Phase |
|---|--------|-------|-------|
| 1 | Dashboard | `activeMatters` reads old `matters` table | 5 |
| 2 | Dashboard | No client status breakdown cards | 5 |
| 3 | Dashboard | No financial summary widget | 5 |
| 4 | Clients | No `phone`/`email` on clients | 6 |
| 5 | Clients | `clientSource` lost on Leads→Existing conversion | 2 |
| 6 | Clients | No general `notes` field on clients | 6 |
| 7 | Matters | `matterStatus` is free text, needs enum | 1 |
| 8 | Matters | `achievementStatus` is free text, needs enum | 1 |
| 9 | Matters | `clientSource`/`nextActionDate`/`nextActionOwner`/`leadStatus` disappear on status change | 2 |
| 10 | Matters | No matter-level next action date/owner | 2 |
| 11 | Matters | `whatShouldHappenNextNow` field missing | 2 |
| 12 | Matters | `legacyNote` field missing | 2 |
| 13 | Matters | Staff codes — no lookup table, no validation | 1 |
| 14 | Matters | MatterNew uses free-text inputs for attorney codes | 2 |
| 15 | Matters | `originalSerial` has no uniqueness constraint | 6 |
| 16 | Financial | `responsibleLawyer` is free text, should auto-derive | 3 |
| 17 | Financial | FinancialDialog has no matter selector | 3 |
| 18 | Financial | `revenue` semantics unclear | — |
| 19 | Financial | Global list has no matter reference column | 3 |
| 20 | Action Log | `actionType` is free text, needs enum | 1 |
| 21 | Action Log | `actionOwner` is free text, should be staff code dropdown | 4 |
| 22 | Action Log | No `status` field (Pending/Done/Cancelled) | 4 |
| 23 | Action Log | No per-action `nextActionDate` | 4 |
| 24 | Action Log | `nextStep` does not auto-create a Task | 4 |
| 25 | Action Log | No filters on global `/client-actions` page | 4 |
| 26 | Tasks | Tasks not auto-generated from action log | 4 |
| 27 | Tasks | `assignedTo` (user ID) not linked to staff codes | 6 |
| 28 | Tasks | TaskList has no grouping by client/matter | — |
| 29 | Tasks | No visible link from task → source action | — |
| 30 | Team | No `staff_codes` lookup table | 1 |
| 31 | Team | `users` table disconnected from staff codes | 6 |
| 32 | Team | Attorney code fields accept any string (no validation) | 1+2 |
| 33 | Team | No team assignment history/audit | 6 |
| 34 | Reports | Filtered client list pages show only client fields, not matter data | 5 |
| 35 | Reports | No CSV/Excel export from any list page | 5 |
| 36 | Reports | Analytics pages query old `leads`/`matters` tables | 5 |
| 37 | Reports | `/clients/rejected` doesn't show rejection detail fields | 5 |
| 38 | Lookups | `matterStatus` not an enum | 1 |
| 39 | Lookups | `actionType` not an enum | 1 |
| 40 | Lookups | Staff codes reference table missing | 1 |
| 41 | Lookups | `clientSource` values not standardized | 1 |

Gaps #18, #28, #29 are informational/low-priority — address at end of Phase 6 if time allows.

---

## Rules That Must Not Change

1. **Discount calculation** — `discountPercentage`, `discountAmount`, `netFees`, `remainingAdvanced`, `outstandingAmount` are always calculated server-side by `applyDiscountRules()` in `server/db.ts`. Never accept these as user input.

2. **Discount approval values** — exactly: `"N/A"`, `"P&L Head Lawyers"`, `"CEO"`, `"Board"`. Rates: N/A=0%, P&L=5%, CEO=10%, Board=15%.

3. **Client status values** — exactly: `"Existing Client"`, `"Leads"`, `"Rejected"`.

4. **City values** — exactly: `"Riyadh"`, `"Dammam"`, `"Jeddah"`.

5. **Fee type values** — exactly: `"Billable Hours"`, `"Fixed / Project-Based Fees"`, `"Retainers"`, `"Success Fees"`, `"Advisory / Special Mandates"`, `"Blended"`.

6. **Collection status values** — exactly: `"Not Billed"`, `"Partially Billed"`, `"Billed"`, `"Partially Collected"`, `"Fully Collected"`, `"Overdue"`.

7. **Permission model** — `:manage` implies `:view` for the same resource. Do not break `hasPermission()` in `shared/const.ts`.

8. **No migration data loss** — all schema changes must use `ADD COLUMN IF NOT EXISTS` or safe `ALTER TYPE` patterns. Never drop existing columns.

---

## Before You Start Each Phase

1. Read `drizzle/schema.ts` fully before touching the schema.
2. Read `server/routers.ts` for the relevant procedures before editing them.
3. After schema changes, run `npm run db:push` (or the project's migration command) to apply.
4. After frontend changes, verify the feature works end-to-end in the browser before marking done.
5. Create one commit per phase.

---

*Generated: 2026-05-20. Branch: claude/alghazzawi-clients-module.*
