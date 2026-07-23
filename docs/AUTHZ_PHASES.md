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
