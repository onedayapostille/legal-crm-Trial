/**
 * Actor-aware record scoping (Phase 4).
 *
 * Turns an actor's authorization DECISION into a SQL predicate applied inside the
 * data layer (never in the router or after load). Each resource resolves its own
 * scope from `authorize(actor, <resource-capability>)` — independent of whichever
 * capability gated the route — so, e.g., a Coordinator (clients:view = REGISTRY
 * but matters:view = ALL) scopes clients and matters differently.
 *
 * Return contract: `SQL | undefined`
 *   - `undefined`  → NO row restriction (scope ALL, or REGISTRY for the client
 *                    registry which is firm-wide by definition).
 *   - a predicate  → ASSIGNED filtering.
 *   - `sql\`false\`` → FAIL CLOSED (OWN_PRACTICE is deferred to Phase 5; OWN /
 *                    NONE / unknown are denied) — the query returns zero rows.
 *
 * Because every LIVE account holds a legacy role (scope ALL), these predicates
 * are no-ops for current users; they only bite once target roles go live.
 *
 * SECURITY: `actor.id` is the authenticated session user id (never request
 * input); it is parameterized by drizzle. Deferred layers not applied here:
 * OWN_PRACTICE (Phase 5), the Lead Lawyer overlay (Phase 6), financial (Phase 7),
 * final task policy (Phase 8).
 */
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { authorize, type DataScope, type PolicyEra } from "@shared/policy";
import { clientMatters, leads, matters, financialRecords } from "../drizzle/schema";

export interface Actor {
  id: number;
  role: string | null | undefined;
  authorizationModel: PolicyEra | string | null | undefined;
  status?: string | null;
}

/** Always-false predicate → zero rows (fail closed). */
const DENY: SQL = sql`false`;

function scopeOf(actor: Actor, capability: string): DataScope {
  return authorize({
    id: actor.id,
    role: actor.role,
    authorizationModel: actor.authorizationModel,
    status: actor.status,
  }, capability).scope;
}

/**
 * A clientMatters row is "assigned" to the actor if they hold any of the seven
 * assignment roles on it. Used directly when querying clientMatters.
 */
export function actorAssignedToMatter(actor: Pick<Actor, "id">): SQL {
  return or(
    eq(clientMatters.leadLawyerId, actor.id),
    eq(clientMatters.supportLeadId, actor.id),
    eq(clientMatters.attorneyHeadId, actor.id),
    eq(clientMatters.attorney1Id, actor.id),
    eq(clientMatters.attorney2Id, actor.id),
    eq(clientMatters.attorney3Id, actor.id),
    eq(clientMatters.attorney4Id, actor.id),
  )!;
}

/**
 * Clients scope. ASSIGNED = clients that either (a) own a matter the actor is
 * assigned to, or (b) name the actor as their lead-assigned lawyer
 * (client_lead_details). Correlated EXISTS so it composes into any `clients`
 * query. Column names are raw (subquery tables), the outer client id is the
 * drizzle-qualified reference.
 */
export function clientScopeWhere(actor: Actor): SQL | undefined {
  const scope = scopeOf(actor, "clients:view");
  if (scope === "ALL" || scope === "REGISTRY") return undefined;
  if (scope === "ASSIGNED") {
    const id = actor.id;
    return sql`(
      EXISTS (
        SELECT 1 FROM "client_matters" cm
         WHERE cm."client_id" = "clients"."id"
           AND (cm."lead_lawyer_id" = ${id} OR cm."support_lead_id" = ${id}
             OR cm."attorney_head_id" = ${id} OR cm."attorney_1_id" = ${id}
             OR cm."attorney_2_id" = ${id} OR cm."attorney_3_id" = ${id}
             OR cm."attorney_4_id" = ${id})
      )
      OR EXISTS (
        SELECT 1 FROM "client_lead_details" cld
         WHERE cld."client_id" = "clients"."id"
           AND cld."assigned_lawyer_id" = ${id}
      )
    )`;
  }
  return DENY; // OWN_PRACTICE (Phase 5), OWN, NONE, unknown → fail closed
}

/** Client-matters scope, resolved from matters:view (NOT the gate's clients:view). */
export function matterScopeWhere(actor: Actor): SQL | undefined {
  const scope = scopeOf(actor, "matters:view");
  if (scope === "ALL") return undefined;
  if (scope === "ASSIGNED") return actorAssignedToMatter(actor);
  return DENY;
}

/**
 * Scope for the `client_matters` table specifically. These routes are gated by
 * `clients:view` (legacy `staff`/`viewer` reach client-matters through CLIENT
 * access, not a matters capability). So when the actor holds no `matters:view`,
 * fall back to their client visibility instead of failing closed — otherwise a
 * legacy `clients:view` holder without `matters:view` would be wrongly denied.
 */
export function clientMatterScopeWhere(actor: Actor): SQL | undefined {
  const m = scopeOf(actor, "matters:view");
  if (m === "ALL") return undefined;
  if (m === "ASSIGNED") return actorAssignedToMatter(actor);
  // No matters:view — defer to client visibility (the route's gating capability).
  const c = scopeOf(actor, "clients:view");
  if (c === "ALL" || c === "REGISTRY") return undefined;
  if (c === "ASSIGNED") return actorAssignedToMatter(actor);
  return DENY;
}

/**
 * Standalone `matters` table scope (distinct from client_matters). It carries a
 * single `assigned_to` FK, so ASSIGNED filters on that.
 */
export function standaloneMatterScopeWhere(actor: Actor): SQL | undefined {
  const scope = scopeOf(actor, "matters:view");
  if (scope === "ALL") return undefined;
  if (scope === "ASSIGNED") return eq(matters.assignedTo, actor.id);
  return DENY;
}

/**
 * Leads (Enquiries Log) scope. No target role holds leads:view at a non-ALL
 * scope, so this is ALL-or-fail-closed; ASSIGNED (if ever granted) filters by the
 * lead's assignee.
 */
export function leadScopeWhere(actor: Actor): SQL | undefined {
  const scope = scopeOf(actor, "leads:view");
  if (scope === "ALL") return undefined;
  if (scope === "ASSIGNED") return eq(leads.assignedTo, actor.id);
  return DENY;
}

/**
 * True when the actor has firm-wide (ALL) read on a capability — used by callers
 * that must fail closed entirely for non-ALL scopes they cannot yet derive
 * (e.g. entity-level activity scoping, deferred within this phase).
 */
export function hasAllScope(actor: Actor, capability: string): boolean {
  return scopeOf(actor, capability) === "ALL";
}

/**
 * Financial record scope (Phase 7), from `financial:view`.
 *   - ALL      → no restriction (admin/manager/HoP/finance/coordinator).
 *   - ASSIGNED → the record's matter is one the actor is assigned to. CLIENT-LEVEL
 *                records (null client_matter_id) are EXCLUDED from ASSIGNED access
 *                (§B/§G) — they can't be attributed to an assigned matter.
 *   - else     → deny (Executive Associate and lower have no BASE financial; they
 *                reach a single matter's records only via the Lead Lawyer overlay,
 *                Phase 6).
 * The predicate references `financial_records.client_matter_id`, so it composes
 * into both the plain records query and the reporting joins.
 */
export function financialScopeWhere(actor: Actor): SQL | undefined {
  const scope = scopeOf(actor, "financial:view");
  if (scope === "ALL") return undefined;
  if (scope === "ASSIGNED") {
    const id = actor.id;
    return sql`(
      ${financialRecords.clientMatterId} IS NOT NULL AND EXISTS (
        SELECT 1 FROM "client_matters" cm
         WHERE cm."id" = ${financialRecords.clientMatterId}
           AND (cm."lead_lawyer_id" = ${id} OR cm."support_lead_id" = ${id}
             OR cm."attorney_head_id" = ${id} OR cm."attorney_1_id" = ${id}
             OR cm."attorney_2_id" = ${id} OR cm."attorney_3_id" = ${id}
             OR cm."attorney_4_id" = ${id})
      )
    )`;
  }
  return DENY;
}

/** Combine a base condition with a scope predicate (either may be undefined). */
export function withScope(base: SQL | undefined, scope: SQL | undefined): SQL | undefined {
  if (base && scope) return and(base, scope);
  return base ?? scope;
}
