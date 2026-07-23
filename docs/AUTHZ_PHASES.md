# Authorization — phased rollout

This CRM is migrating from a flat boolean permission check to a typed
capability-plus-scope policy that supports the firm's real position structure
(approved *Roles & Permissions Specification v1.1*). The migration is staged so
each phase ships independently and changes nothing for existing accounts until
the phase that explicitly migrates them.

## Phase 1 — Manager read-only hotfix (shipped, PR #94)

Schema-free remediation: split combined `:manage` gates into read vs. mutate,
made **Manager** firm-wide read-only, corrected payment/rate gates, closed the
Lead-Lawyer-via-generic-update bypass, and suppressed dashboard financial
aggregates for callers without `financial:view`. Enforcement lives in
`server/routers.ts` via `permissionProcedure(...)` + `shared/const.ts`
`ROLE_PERMISSIONS` / `hasPermission`.

## Phase 2 — Typed policy foundation (this change)

A centralized, typed policy engine under **`shared/policy/`**:

| Module | Responsibility |
|---|---|
| `capabilities.ts` | Closed `Resource × Operation` capability set (`isCapability` fails closed). |
| `scopes.ts` | `DataScope = ALL \| OWN_PRACTICE \| ASSIGNED \| REGISTRY \| OWN \| NONE`. |
| `roles.ts` | Legacy (live) vs target (approved) roles + migration map. |
| `matrix.ts` | `LEGACY_POLICY` (mirrors Phase-1, scope ALL) and `TARGET_POLICY` (approved matrix, real scopes). |
| `overlay.ts` | Lead Lawyer additive per-matter overlay (never a role — BR-03). |
| `authorize.ts` | `authorize(actor, capability): PolicyDecision` (pure, fail-closed) + Phase-1 compatibility adapter. |

Server surface (`server/_core/trpc.ts`): `serverAuthorize()` and
`capabilityProcedure(capability)` — the successor middleware that puts the typed
`PolicyDecision` (with resolved scope) on `ctx.authz`. `permissionProcedure`
remains as a **`@deprecated` compatibility bridge** for routes not yet migrated.

### Era model (why nothing changes yet)

The DB `users.role` column still holds only **legacy** roles, so `authorize`
resolves them against `LEGACY_POLICY` — identical to Phase-1 behavior. The 12
**target** roles exist as types and data in `TARGET_POLICY`, but no live account
holds one, so their (scoped) grants are inert until account migration. The names
shared by both eras (`admin`, `manager`, `finance`) deliberately resolve to the
legacy policy while the app is in the legacy era, so e.g. `finance` does **not**
gain its expanded target rights prematurely.

## Phase 3 — additive target-role schema support (this change)

Makes the persistence layer *ready* for the target roles without migrating any
account.

- **Migration `0023_target_roles_additive.sql`** (NOT executed): adds the eight
  target account roles to the `user_role` enum via `ALTER TYPE ... ADD VALUE IF
  NOT EXISTS` — additive, idempotent, matching the 0001/0003 precedent. No value
  removed/renamed; no row updated; `lead_lawyer` never added (overlay, not a
  role); `viewer` retained but unmapped.
- **`drizzle/schema.ts`**: `userRoleEnum` widened to the 15 coexisting values
  (legacy + target). `shared/policy/roles.ts` `ACCOUNT_ROLE_VALUES` is the
  canonical list; a test drift-guards the two.
- **Role typing**: `AccountRole` / `isAccountRole` (persistable roles) join the
  existing `LegacyRole` / `TargetRole` distinction. `lead_lawyer` is excluded
  from every account-role type and from User Management.
- **Migration-readiness (`shared/policy/migration.ts`)**: the approved mapping as
  data + a deterministic `mapLegacyRole()` (never auto-maps Lawyer/Viewer) + a
  pure `buildPreflightReport()`. **`scripts/preflight-roles.ts`** runs a
  read-only `SELECT role, COUNT(*) GROUP BY role` and classifies each into
  auto / manual (Lawyer→HR grade) / decision (Viewer) / unknown — **no personal
  data**, no writes.

### Role coexistence & API validation across cutover

| State | DB enum | `users.role` rows | `roleSchema` (User-Mgmt create/edit) | `authorize` |
|---|---|---|---|---|
| **Before this migration** | 7 legacy | legacy only | legacy (`USER_ROLES`) | `LEGACY_POLICY` |
| **After 0023, before re-grade** | 15 (legacy+target) | still legacy | still legacy — target roles NOT yet assignable | `LEGACY_POLICY` for live legacy roles; target roles resolvable but unheld |
| **After controlled re-grade (later phase)** | 15 | target | switches to target set | `TARGET_POLICY` |

`roleSchema` is intentionally left as `z.enum(USER_ROLES)` (legacy) so widening
the DB enum does **not** let the API assign an unenforced target role early
(least privilege). The switch to a target-role schema happens with the re-grade,
not here. Unknown roles fail closed at both `authorize` and `mapLegacyRole`.

## Phase 4 — actor-aware DB scoping & IDOR prevention (this change)

Threads the authenticated actor into the data layer for the operational
resources and enforces the caller's scope in SQL (never in the router or after
load). Because every LIVE account is a legacy role (scope ALL), the predicates
are **no-ops for current users**; they activate for target roles.

- **`server/scoping.ts`**: derives each resource's scope from
  `authorize(actor, <resource-capability>)` and returns a SQL predicate:
  `undefined` (ALL / REGISTRY = firm-wide), an ASSIGNED filter, or `sql\`false\``
  (fail closed). ASSIGNED for clients = owns an assigned matter or is the
  lead-assigned lawyer (`client_lead_details`); for matters = actor ∈ the seven
  assignment FKs; standalone `matters` = `assigned_to`.
- **`server/db.ts`**: `getAllClients`, `getClientById`, `getClientMatters`,
  `getAllClientMatters`, `getClientMatterById`, `getAllMatters`, `getMatterById`,
  `getAllLeads`, `getLeadById`, `searchConflicts`, `checkMatterConflicts`,
  `getRecentActivity` take an optional `actor` and apply the predicate. Get-by-ID
  uses the SAME predicate as its list (out-of-scope → `null` → NOT_FOUND).
- **`server/routers.ts`**: covered READ routes migrated `permissionProcedure →
  capabilityProcedure` (legacy-equivalent; lets scoped target roles reach the
  resolver — the legacy gate denies all target roles). Mutations
  (`clients.update/delete`, `clientMatters.update/delete`) re-fetch the target
  under scope and 404 if inaccessible.

### Scope enforcement, deferrals, and fail-closed

- **REGISTRY** (Coordinator) → full client list (registry is firm-wide); matter
  detail is a separate, separately-scoped endpoint.
- **OWN_PRACTICE** (HoP create/edit) → **fail closed** here; Phase 5 derives the
  practice (location + matter type). So HoP cannot yet mutate — safe, not widened.
- **Lead Lawyer overlay** → Phase 6. **Financial** records/reports → Phase 7.
  **Tasks** final policy → Phase 8.
- **Activity feed** entity-level scoping → fail closed for non-ALL audit readers
  (empty) rather than leaking; ALL readers unaffected.
- **Not yet scoped within this phase** (target roles fail closed at their legacy
  gate, so no leak): `recentLeads`, `getLeadDetail`, `getRejectedDetail`, and the
  non-financial dashboard aggregate counts — tracked below.

## Phase 5 — Head of Practice identity & OWN_PRACTICE enforcement (this change)

Implements the practice responsibility model and OWN_PRACTICE writes.

- **`practices` table** (`drizzle/schema.ts`, migration `0024_practices.sql`,
  additive, **not executed**): `(location, matter_type, head_of_practice_id →
  users.id)`, unique on `(location, matter_type)` — one responsible head per
  practice. Created empty; heads appointed by a later controlled step (no
  backfill, §H). A record's practice is derived from its `(city, matter_type)`
  natural key (matters inherit location from their client).
- **`server/practices.ts`**: `getPracticeHead()`, `assertOwnPracticeWrite()`
  (the write validator), and `getClientPracticeClassification()` (read-only
  legacy report). Write rules: ALL → unrestricted; OWN_PRACTICE → proposed (and,
  for edits, current) `(location, matter_type)` must resolve to a practice the
  actor heads; anything else / null / unmapped → **fail closed**. Validating both
  current and proposed values blocks self-claiming and cross-practice moves.
- **`server/routers.ts`**: `clients.create/update/delete` migrated to
  `capabilityProcedure("clients:create|edit|delete")` and call
  `assertOwnPracticeWrite`. HoP **reads stay ALL** (Phase-4 scoping already
  returns unrestricted for ALL). New admin `practices.classification` report.
- **`server/financialReports.ts`**: `getRevenueByHeadOfPractice` now groups by
  the authoritative `practices` head via `(client.city, matter type)` — one head
  per practice, so each record counts once (no double count). Degrades to
  `configured:false` when the table is absent or no head is appointed.

### Bug fixed from Phase 4

`client_matters` routes are gated by `clients:view`, but Phase 4 scoped them by
`matters:view` — legacy `staff`/`viewer` (which hold `clients:view` but not
`matters:view`) were wrongly denied. Added `clientMatterScopeWhere`, which falls
back to client visibility when the actor has no `matters:view`.

### Fail-closed / legacy classification

Existing rows are unclassified until a controlled step appoints heads → readable
under ALL, **not writable** under OWN_PRACTICE. `practices.classification`
reports, per `(city, matter_type)`, how many client rows are writable vs.
unclassified — read-only, no backfill.

## Phase 6 — per-matter Lead Lawyer overlay (this change)

Additive, matter-specific authority derived ONLY from the authenticated user id
vs. the authoritative `client_matters.lead_lawyer_id` — never an account role.

- **`server/db.ts`**: `ledMatterIds(actorId)`, `isLeadLawyerOfMatter(actorId,
  matterId)`. Task visibility (`taskVisibilityCondition`, `isTaskVisibleTo`)
  extended so a lead lawyer additionally sees/updates/assigns tasks whose
  `clientMatterId` is a matter they lead — and no other tasks.
- **`server/routers.ts`**:
  - `clientMatters.update` → `protectedProcedure` with authz FIRST: base
    matter/client managers edit freely; otherwise the ONLY path is the overlay —
    must be the matter's lead lawyer AND may change only the **editable-field
    allowlist**: `matterDescription, matterStatus, balanceWorkLeft,
    achievementPercentage, achievementStatus, priority, opposingParty`.
    Assignment / practice (`matterType`) / financial (`billingType`) / identifier
    fields are excluded.
  - `clientMatters.create` → rejects a non-null `leadLawyerId` unless the actor
    holds `matters:assign_lawyer` (**prevents self-designation on create**).
  - `clientMatters.matterFinancials` (new) → READ-ONLY, matter-filtered financial
    records; allowed for base `financial:view` OR the matter's lead lawyer (the
    Executive-Associate case). Never grants financial mutation; never exposes
    other matters.
- **Designation changes** remain gated by `matters:assign_lawyer` (Phase-1 guard
  on generic update + `reassignLeadLawyer`); Lead Lawyer changes are audit-logged
  by the existing `reassignLeadLawyer` path.
- **`0025_lead_lawyer_overlay_indexes.sql`** (additive, **not executed**):
  indexes on `client_matters.lead_lawyer_id` and `tasks.client_matter_id`.

### Overlay decision flow

`allowed = base-role authorize(cap) OR (matter.leadLawyerId === actor.id AND cap
∈ overlay grants)`, applied only to that matter, additive, financial read-only,
edit restricted to the allowlist. Removing the designation removes overlay access
immediately (it is recomputed from `lead_lawyer_id` every request).

### Deferred within phase

Target-role (non-legacy) lead lawyers reaching the **task** routes needs the task
gates migrated to `capabilityProcedure` — that is Phase 8 (final task policy). The
overlay itself is enforced for any caller who reaches the route (verified here
with a legacy `lawyer` for tasks and an `executive_associate` for financial/matter
paths).

## Phase 7 — financial authorization & scoped projections (this change)

Scopes every financial read/write/report/export/dashboard path.

- **`server/scoping.ts::financialScopeWhere`**: from `financial:view` — ALL → no
  restriction; ASSIGNED → `client_matter_id IS NOT NULL AND EXISTS(client_matters
  cm WHERE cm.id = client_matter_id AND actor ∈ 7 assignment FKs)` (**null-matter
  records excluded from ASSIGNED**, §B/§G); else deny.
- **`server/db.ts`**: `getFinancialRecords`, `getFinancialRecordById`,
  `getFinancialSummary` take an actor and apply the predicate — so the **summary
  aggregates reconcile exactly with the visible detail rows**.
- **`server/financialReports.ts`**: the actor threads through the single `whereOf`
  chokepoint → **every report, `details` page and CSV `export` gets the identical
  scope** (an export never contains rows the screen hides). Report routes gated by
  `financialReports:view` (admin/manager/HoP/finance) — Coordinator and the legal
  grades cannot run reports.
- **`server/routers.ts`**:
  - Financial reads → `capabilityProcedure("financial:view")` + actor.
  - **Coordinator projection**: `financial.list/get` null out every sensitive
    value (fees, revenue, all money, discounts, rates, notes, responsible-lawyer)
    while keeping payment-status/tracking fields — a Coordinator never receives
    the values.
  - Financial mutations → `capabilityProcedure("financial:create|edit|delete")` +
    **HoP OWN_PRACTICE** via `assertOwnPracticeWrite` on the record's practice
    (`financialRecordPracticeKey` = client city + matter/client type), validating
    BOTH current and proposed on edit. Finance/admin unrestricted; others denied.
  - `financial.auditLog` returns entries only if the caller can see the record.

### Roles → financial (verified)

| Role | Records | Reports | Mutations |
|---|---|---|---|
| Admin / Finance | ALL | yes | full |
| Manager / HoP | ALL read | yes | Manager none; HoP OWN_PRACTICE create/edit |
| Senior Associate | ASSIGNED read-only | no | none |
| Exec Assoc & lower | none (base) | no | none |
| Coordinator | ALL, payment-status DTO | no | none |
| Lead Lawyer (overlay) | one matter read-only (Phase 6) | no | none |

### Safe-by-construction (no new leak)

- **AI analytics** (`aiAnalytics.gatherCrmData`) already includes firm-wide
  financial ONLY for admin/manager/finance (all ALL-scope) — ASSIGNED roles get
  no financial section. No change; no leak.
- **Dashboard** financial totals are zeroed for every target role by the Phase-1
  guard (`hasPermission(role,"financial:view")`) — safe. Scoped dashboard totals
  for ASSIGNED financial viewers are deferred (no leak; just zeroed).
- **Reports/export scope** is defense-in-depth: current report viewers all hold
  `financial:view = ALL`, so the predicate is inert for them but applies the
  moment a scoped role is ever granted `financialReports:view`.
- **No migration**: the ASSIGNED predicate resolves via a `client_matters` PK
  lookup; no index proven necessary (§H).

## Deferred to later phases

- **Route migration**: move each `permissionProcedure("x:manage")` to
  `capabilityProcedure("x:create"|...)`. Remove the bridge when none remain.
- **Scope enforcement in queries**: `db.ts` reads mostly ignore the actor. Wire
  `ctx.authz.scope` (`OWN_PRACTICE` / `ASSIGNED` / `REGISTRY` / `OWN`) into query
  filters. Requires the schema work below.
- **Schema**: per-record Head-of-Practice reference (location + matter type) for
  `OWN_PRACTICE`; matter-team membership for `ASSIGNED`.
- **Lead Lawyer overlay wiring**: implement `MatterOverlayResolver` against the
  `matter.lead_lawyer_id` flag and fold `matterOverlayGrants` into enforcement.
- **Account migration**: re-grade users (`partner→head_of_practice`,
  `lawyer→{senior_associate,…}`, `staff→coordinator`, add `paralegal`), then flip
  the shared-name roles to `TARGET_POLICY`.
- **Target-role capability gaps**: capabilities the approved matrix does not
  address (Payment Tracker, notes, companies, client action log, AI) are listed
  in `matrix.ts` `DEFERRED_TARGET_CAPABILITIES` and fail closed for target roles
  pending business-owner confirmation.

## Frontend note

`shared/policy` is import-safe on the client (no server dependencies). UI may use
the same capability names / `can()` for button gating, but this is **advisory
only** — the server decision is always authoritative (BR-09).
