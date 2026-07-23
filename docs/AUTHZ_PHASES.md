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
