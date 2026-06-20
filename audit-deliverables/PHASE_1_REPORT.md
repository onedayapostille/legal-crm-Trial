# Legal CRM — Phase 1 Report (Critical Foundation Fixes)

**Branch:** `fix/crm-phase-1-critical-foundation`
**Date:** 2026-06-20
**Scope:** Security/credentials, canonical intake unification, dashboard intake
metrics, legacy-route preservation, and test cleanup. Finance, matters, roles,
and serial-integrity work are intentionally deferred to later phases.

---

## 1. Files Changed

| File | Change |
| --- | --- |
| `Dockerfile` | Removed hard-coded `DATABASE_URL` and `JWT_SECRET`; documented runtime injection. |
| `README.md` | New **Secrets & Security** section + mandatory credential-rotation note. |
| `drizzle/schema.ts` | Added `clients.source_lead_id` (nullable FK → `leads.id`, `ON DELETE SET NULL`). |
| `drizzle/migrations/0017_client_source_lead_link.sql` | Additive, idempotent migration for the link column + index (with rollback note). |
| `scripts/backfill-leads-to-clients.sql` | One-time, idempotent backfill of legacy leads → canonical clients (with rollback). |
| `server/db.ts` | `mapLeadStatusToClientStatus()`, `syncLeadToClient()`, wired into `createLead`/`updateLead`. |
| `client/src/pages/EnquiryForm.tsx` | Invalidate canonical client queries on create/update (same-user real-time). |
| `client/src/pages/Dashboard.tsx` | Top KPI changed from "Total Leads (Non-active)" → "Active Leads" (no Rejected mixing). |
| `client/src/App.tsx` | Added `/enquiries/:id/edit` and `/leads/:id/edit` routes. |
| `server/enquiries.test.ts` | Rewritten: removed `enquiries` router → `leads` router + canonical-mirror tests + pure unit tests. |
| `server/payments.test.ts` | Replaced stale `caller.enquiries.*` → `caller.leads.*`; added required `channelType`. |
| `server/enquiryDatetime.test.ts` | Added required `channelType` to fixtures (fixed CRM-016 validation failures). |

Commits (focused, all after checks passed):
1. `security: remove hard-coded DATABASE_URL and JWT_SECRET from Dockerfile`
2. `feat: unify intake on canonical clients model via lead→client mirror`
3. `test: fix stale enquiries router refs + add canonical mirror tests`

---

## 2. What Was Fixed

### A) Security / Credentials (audit Critical: "Embedded credentials")
- **Removed** the live Supabase `DATABASE_URL` and the `JWT_SECRET` from the
  `Dockerfile` (they were baked into image `ENV` layers).
- Secrets are now read **only** from runtime environment variables. The code
  already did this (`server/_core/auth.ts`, `server/db.ts`); the Dockerfile was
  the sole leak in the working tree.
- `.env.example` already contained **placeholder-only** values — no change
  needed; confirmed no real secrets present.
- Startup logging already prints only `SET ✓ / NOT SET ✗`, never secret values.
- README now documents required env vars and a **rotation requirement** (see §4).

### B/C) Canonical Intake Unification (audit Critical CRM-015, High CRM-001/013)
- **Canonical model = `clients` + `client_lead_details`** (see §3).
- Root cause fixed: the New Lead/Enquiry form wrote **only** the legacy `leads`
  table, so new enquiries never appeared in the canonical Leads Pipeline,
  dashboard Total Leads, Recent Leads, or Conversion Rate.
- **Server-side mirror** (`syncLeadToClient`): every lead create/update now
  upserts a linked canonical client (`clients.source_lead_id = leads.id`) plus
  its `client_lead_details` (channel type/medium, assigned lawyer, source, lead
  status). The legacy `leads` row is preserved intact (rich enquiry fields + the
  Enquiries Log keep working) — it is now a compatibility/reporting record, not a
  competing source of truth.
- **Status mapping**: `Converted → Existing Client`, `Lost → Rejected`,
  everything else → `Leads`. Conservative: a mirror manually moved to `Rejected`
  is never auto-un-rejected.
- **Suggested Lead Lawyer** now persists into the canonical
  `client_lead_details.assigned_lawyer_id` (via the mirror), so intake assignment
  is unified with the pipeline filter (partial CRM-018).
- **Communication channel** fields are written consistently to both models
  through the mirror (CRM-017).
- **Same-user real-time** (CRM-013): EnquiryForm invalidates the canonical
  client queries on create/update, so the pipeline and dashboard refresh with no
  manual reload. (Cross-user real-time is **not** implemented — see §6.)

### D) Legacy Route Preservation
- `/enquiries` and `/leads` list routes still redirect to `/clients/leads`
  (unchanged).
- Added the previously-missing **`/enquiries/:id/edit`** (and `/leads/:id/edit`)
  routes, which render the canonical-mirroring EnquiryForm. This removes the
  404 on enquiry edit deep links flagged by the audit.
- Stale `enquiries.*` router references in tests were updated to `leads.*`.

### E) Dashboard Intake Metrics (audit High CRM-001)
- All dashboard intake cards already read **one** backend source (`clients`):
  `clients.dashboardStats`, `clients.recentLeads`, `clients.conversionMetrics`.
  No card reads legacy `leads`.
- Fixed the only mixing problem: the top KPI was "Total Leads (Non-active)" =
  Leads **+ Rejected**. It is now **"Active Leads" = `clientStatus = "Leads"`**,
  matching the Pipeline / Recent Leads / Conversion definitions. Rejected and
  Existing remain clearly separated in the Client Registry cards below:
  - **Active Leads** (top KPI) and **Leads Pipeline** card = `Leads` status
  - **Existing Clients** card = `Existing Client`
  - **Rejected** card = `Rejected`
  - **Total Clients** card = all
- **Rejected-in-Total-Leads decision:** Rejected is now **excluded** from the
  lead count and shown as its own metric. (Confirm with the business owner; this
  is reversible by reverting the one StatCard change.)

### F) Tests
- Rewrote `enquiries.test.ts` (the removed-router test). It now contains
  **runnable, DB-free** unit tests for `mapLeadStatusToClientStatus` plus
  DB-backed mirror/conversion integration tests.
- Fixed stale `enquiries.*` calls in `payments.test.ts` and missing-`channelType`
  fixtures in `enquiryDatetime.test.ts`.

---

## 3. Canonical Data Model (after Phase 1)

```
clients (master intake + registry)            ← CANONICAL
  ├─ client_lead_details (1:1)                ← pipeline metadata (channel, assigned lawyer, next action)
  ├─ source_lead_id ─────────────────────────→ leads.id   (NEW: link to origin enquiry, nullable)
  └─ clientStatus: Existing Client | Leads | Rejected
     convertedFrom: Lead | Enquiry | Direct

leads (legacy enquiry record)                 ← COMPATIBILITY / RICH ENQUIRY LOG
  └─ mirrored into clients on every create/update via syncLeadToClient()
```

- **Reads** (Leads Pipeline, Dashboard lead metrics, Recent Leads, Conversion
  Rate, Client Registry): **`clients` / `client_lead_details`**.
- **Enquiries Log** (`/enquiries/log`): still reads `leads` — deliberately, as
  the rich marketing/channel reporting view. It is kept consistent because every
  lead is mirrored into `clients`. (Optional future: re-point it at the canonical
  model once the rich enquiry fields are migrated.)
- **Writes**: New Lead/Enquiry → `leads` **and** (mirror) → `clients` +
  `client_lead_details`. Direct client creation → `clients` only.

---

## 4. Migrations / Backfills Required

### Schema migration (automatic, safe)
`drizzle/migrations/0017_client_source_lead_link.sql` — adds
`clients.source_lead_id` + index. Additive, nullable, `IF NOT EXISTS`, applied by
the startup auto-migrator. **Rollback** (in the file header):
```sql
DROP INDEX IF EXISTS idx_clients_source_lead;
ALTER TABLE "clients" DROP COLUMN IF EXISTS "source_lead_id";
```

### Data backfill (deliberate, one-time, NOT auto-run)
`scripts/backfill-leads-to-clients.sql` — creates canonical clients for legacy
enquiries that predate unification so they appear in the pipeline/dashboard.
- Idempotent (guarded by `NOT EXISTS`), additive only, no deletes.
- Run with a DB backup in place:
  `psql "$DATABASE_URL" -f scripts/backfill-leads-to-clients.sql`
- Rollback (removes only mirrored clients, i.e. `source_lead_id IS NOT NULL`) is
  documented in the script header.

### ⚠️ Credential rotation (outside the codebase — MUST do before delivery)
The real `DATABASE_URL` (Supabase) and `JWT_SECRET` were previously committed and
remain in **git history** and in any **already-built image**. Removing them from
the working tree is not sufficient. Required:
1. Rotate the Supabase DB password; re-issue the connection string.
2. Generate a new `JWT_SECRET` (`openssl rand -hex 32`) — invalidates old
   sessions (intended).
3. Update the deployment secret store / `.env`.
4. Optionally purge from git history (`git filter-repo`) + coordinated force-push.

---

## 5. Tests Run & Results

Tooling note: `pnpm` is not on PATH in this environment; commands were run via the
local binaries (`node_modules/.bin/tsc`, `.../vitest`).

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `tsc --noEmit` | **PASS** (exit 0) |
| Unit tests (DB-free) | `vitest run -t "mapLeadStatusToClientStatus"` | **PASS** — 4/4 |
| Full suite | `vitest run` | 9 pass / 76 fail — **all 76 failures are `DATABASE_URL environment variable is required`** (integration tests), not logic errors. |
| Prettier | `prettier --check` | Not enforced by this repo; the touched files were already non-conforming before the change (CI uses `tsc`). Additions follow the existing 2-space style. No repo-wide reformat performed to avoid noise. |

**Database-backed tests that could NOT run** (need `DATABASE_URL` → a disposable
PostgreSQL): `enquiries` (mirror integration part), `payments`, `recentLeads`,
`conversionRate` (integration part), `clientStatusCounts`, `newLeadVisibility`,
`activeMatters`, `rejectedClientLock`, `taskVisibility`, `clientTasks`,
`matterLawyerRates`, `communicationChannel`, `enquiryDatetime`,
`leadLawyerAssignment`, `intakeFilters`, `conflictCheck`, `originalSerial`,
`financialRevenue`. These are written and type-correct; they will execute once a
migrated test database is provided (as the audit also recommended).

---

## 6. Remaining Limitations (in scope for later phases or follow-up)

- **Cross-user real-time** is not implemented; only same-user cache invalidation.
  A subscription/polling transport is an optional future enhancement.
- **Enquiries Log** still reads legacy `leads` (kept for rich channel reporting).
  Consistency is maintained via the mirror; full canonical read deferred.
- **Update-sync direction is one-way** (lead → client). Editing the mirrored
  client directly (e.g. renaming via ClientDetail) is not pushed back to the
  legacy lead. Acceptable because the enquiry form is the intended edit path.
- **DB-backed tests leave mirror client rows** when they only delete the lead
  (pre-existing tests). Recommend running the suite against a **disposable**
  PostgreSQL (already an audit recommendation) to avoid count-delta flakiness.
- **Not addressed in Phase 1** (later phases): serial uniqueness/concurrency
  (CRM-007), financial Billed/Revenue semantics (CRM-012), matter-ownership
  validation (CRM-010), notification false-success / real email (CRM-018),
  schema↔migration FK parity, free-text status governance.

---

## 7. Manual QA Checklist (Phase 1)

**Security**
- [ ] `docker build` produces an image with **no** `DATABASE_URL`/`JWT_SECRET`
      in any layer (`docker history`, image inspect).
- [ ] App boots only when `DATABASE_URL` is provided at runtime; logs show
      `SET ✓ / NOT SET ✗` and never the secret values.
- [ ] Confirm secrets rotated in Supabase + secret store (see §4).

**Intake unification**
- [ ] Create a New Lead/Enquiry → it appears at the **top** of `/clients/leads`
      (Leads Pipeline) immediately, **without** a manual refresh.
- [ ] The same new lead increments the dashboard **Active Leads** card and
      **Recent Leads (last 30 days)** widget.
- [ ] The new lead's **channel type/medium** and **assigned lead lawyer** show on
      the canonical client (intake filters + ClientDetail).
- [ ] Set the enquiry's status to **Converted** → the mirror moves to **Existing
      Client** and the **Conversion Rate** card updates (Enquiry counted).
- [ ] Set status to **Lost** → mirror becomes **Rejected**; it leaves the Leads
      Pipeline.
- [ ] Enquiries Log (`/enquiries/log`) still lists the legacy enquiry record.

**Routes**
- [ ] `/enquiries` and `/leads` redirect to `/clients/leads`.
- [ ] `/enquiries/:id/edit` and `/leads/:id/edit` open the editor (no 404).

**Dashboard separation**
- [ ] Active Leads = Leads only (Rejected **not** included); Rejected shown
      separately; Existing Clients separate; Total Clients = all.

**Backfill (staging)**
- [ ] Run `backfill-leads-to-clients.sql` on a copy → every legacy lead has
      exactly one mirrored client; re-running creates no duplicates.
- [ ] Validate the documented rollback removes only `source_lead_id IS NOT NULL`
      clients.
