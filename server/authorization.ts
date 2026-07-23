// ─── Server-side authorization primitives ─────────────────────────────────────
//
// SQL scope-filter builders and field-level rules implementing the capability ×
// scope policy from shared/permissions.ts. Record-level asserts that need a DB
// round-trip live in server/db.ts (which imports these builders); routers use
// capabilityProcedure(...) from server/_core/trpc.ts as the gate.
//
// Design rules (spec: BR-01..BR-15):
//  • The acting user always comes from the authenticated session (ctx.user,
//    re-read from the DB per request) — never from request input.
//  • Assignment is resolved ONLY from authoritative user-id FK columns
//    (client_matters.lead_lawyer_id / support_lead_id / attorney_head_id /
//    attorney_1_id..attorney_4_id) — never from free-text name mirrors.
//  • Lead Lawyer is a per-matter overlay keyed on client_matters.lead_lawyer_id.
//  • OWN_PRACTICE resolves through practice_heads (city, matter_type) — an
//    unmapped combination belongs to no practice (null-safe least privilege).

import { SQL, or, eq, sql } from "drizzle-orm";
import { clientMatters, clients, financialRecords, practiceHeads, tasks } from "../drizzle/schema";
import {
  can,
  leadLawyerOverlayApplies,
  scopeFor,
  type Capability,
  type Scope,
} from "../shared/permissions";

/** Minimal acting-user shape (always ctx.user, never request input). */
export type AuthUser = { id: number; role: string };

// ─── Matter-team membership (authoritative FK columns only) ──────────────────

/** The 7 authoritative team FK columns on client_matters. */
export const MATTER_TEAM_FIELDS = [
  "leadLawyerId",
  "supportLeadId",
  "attorneyHeadId",
  "attorney1Id",
  "attorney2Id",
  "attorney3Id",
  "attorney4Id",
] as const;

export type MatterTeamField = (typeof MATTER_TEAM_FIELDS)[number];

/**
 * Authorization-defining matter fields. "Edit matter details" NEVER includes
 * these: changing them requires matters.assignTeam (admin firm-wide, Head of
 * Practice within own practice). Creators may set them at creation time.
 *  - team FKs / lead lawyer → who gains ASSIGNED access
 *  - clientId → which client's data the matter (and its financials) belong to
 *  - matterType → practice ownership dimension (BR-01)
 */
export const MATTER_SCOPE_DEFINING_FIELDS = [
  ...MATTER_TEAM_FIELDS,
  "clientId",
  "matterType",
] as const;

/** Authorization-defining client fields (practice ownership dimensions). */
export const CLIENT_SCOPE_DEFINING_FIELDS = ["city", "matterType"] as const;

/**
 * Authorization-defining financial-record fields (ownership/link fields that
 * decide who can see the record).
 */
export const FINANCIAL_SCOPE_DEFINING_FIELDS = ["clientId", "clientMatterId"] as const;

/** Condition over a client_matters row: user is on the matter team. */
export function matterTeamCondition(userId: number): SQL {
  return or(
    eq(clientMatters.leadLawyerId, userId),
    eq(clientMatters.supportLeadId, userId),
    eq(clientMatters.attorneyHeadId, userId),
    eq(clientMatters.attorney1Id, userId),
    eq(clientMatters.attorney2Id, userId),
    eq(clientMatters.attorney3Id, userId),
    eq(clientMatters.attorney4Id, userId),
  )!;
}

/** Condition over a client_matters row: user is the designated Lead Lawyer. */
export function ledMatterCondition(userId: number): SQL {
  return eq(clientMatters.leadLawyerId, userId);
}

/** JS-side team-membership test for an already-fetched matter row. */
export function isMatterAssignedToUser(
  matter: Partial<Record<MatterTeamField, number | null>>,
  userId: number,
): boolean {
  return MATTER_TEAM_FIELDS.some(f => matter[f] === userId);
}

/** JS-side Lead Lawyer test for an already-fetched matter row (overlay). */
export function isLeadLawyerOfMatter(
  matter: { leadLawyerId?: number | null },
  user: AuthUser,
): boolean {
  return leadLawyerOverlayApplies(user.role) && matter.leadLawyerId === user.id;
}

// Raw-SQL variant of team membership for correlated subqueries with an alias.
function teamMemberSqlFor(alias: string, userId: number): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.lead_lawyer_id = ${userId} OR ${a}.support_lead_id = ${userId} OR ${a}.attorney_head_id = ${userId} OR ${a}.attorney_1_id = ${userId} OR ${a}.attorney_2_id = ${userId} OR ${a}.attorney_3_id = ${userId} OR ${a}.attorney_4_id = ${userId})`;
}

// ─── Head-of-Practice (OWN_PRACTICE) conditions ───────────────────────────────

/**
 * Condition over a clients row: the client belongs to one of the user's
 * practices (practice_heads on city + matter_type). NULL city/matter_type
 * never matches (least privilege).
 */
export function clientInUserPracticeCondition(userId: number): SQL {
  return sql`EXISTS (
    SELECT 1 FROM practice_heads ph_c
    WHERE ph_c.head_of_practice_id = ${userId}
      AND ph_c.city = ${clients.city}
      AND ph_c.matter_type = ${clients.matterType}
  )`;
}

/**
 * Condition over a client_matters row: the matter belongs to one of the
 * user's practices. The matter's own matter_type wins when it is a supported
 * value; otherwise the client's matter_type is used (legacy varchar values).
 */
export function matterInUserPracticeCondition(userId: number): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM practice_heads ph_m
    JOIN clients pc ON pc.id = ${clientMatters.clientId}
    WHERE ph_m.head_of_practice_id = ${userId}
      AND pc.city = ph_m.city
      AND ph_m.matter_type::text = CASE
        WHEN ${clientMatters.matterType} IN ('Litigation', 'Corporate')
          THEN ${clientMatters.matterType}
        ELSE pc.matter_type::text
      END
  )`;
}

/** Practice key ("city|matterType") helpers for JS-side record checks. */
export function practiceKey(city: string | null, matterType: string | null): string | null {
  if (!city || !matterType) return null;
  return `${city}|${matterType}`;
}

export function effectiveMatterType(
  matterMatterType: string | null | undefined,
  clientMatterType: string | null | undefined,
): string | null {
  if (matterMatterType === "Litigation" || matterMatterType === "Corporate") {
    return matterMatterType;
  }
  return clientMatterType ?? null;
}

// ─── Scope filters per resource ───────────────────────────────────────────────
// Return value contract: undefined = unrestricted; an SQL condition otherwise.
// NONE deliberately compiles to FALSE so a mis-wired call can never widen access.

const FALSE_CONDITION = sql`FALSE`;

/** Row filter for clients queries. */
export function clientScopeCondition(user: AuthUser, scope: Scope): SQL | undefined {
  switch (scope) {
    case "ALL":
    case "REGISTRY": // registry = the client lists themselves
      return undefined;
    case "OWN_PRACTICE":
      return clientInUserPracticeCondition(user.id);
    case "ASSIGNED":
      return sql`EXISTS (
        SELECT 1 FROM client_matters cm_scope
        WHERE cm_scope.client_id = ${clients.id}
          AND ${teamMemberSqlFor("cm_scope", user.id)}
      )`;
    default:
      return FALSE_CONDITION;
  }
}

/** Row filter for client_matters queries. */
export function matterScopeCondition(user: AuthUser, scope: Scope): SQL | undefined {
  switch (scope) {
    case "ALL":
    case "REGISTRY":
      return undefined;
    case "OWN_PRACTICE":
      return matterInUserPracticeCondition(user.id);
    case "ASSIGNED":
      return matterTeamCondition(user.id);
    default:
      return FALSE_CONDITION;
  }
}

/**
 * Row filter for financial_records queries, combining the base
 * financial.view scope with the Lead Lawyer overlay:
 *  • ALL → unrestricted (read-only-ness is enforced by mutation capabilities)
 *  • ASSIGNED (Senior Associate) → matter-linked records of team matters
 *  • base NONE but Lead-Lawyer-overlay-eligible → matter-linked records of
 *    matters the user LEADS only
 * Client-level records (client_matter_id IS NULL) are visible only to
 * ALL-scope viewers: the spec ties assigned/lead visibility to "financial
 * records of their assigned matters" (BR-04/BR-05) — least privilege.
 */
export function financialViewCondition(user: AuthUser): SQL | undefined {
  const scope = scopeFor(user.role, "financial.view");
  switch (scope) {
    case "ALL":
      return undefined;
    case "ASSIGNED":
      return sql`(${financialRecords.clientMatterId} IS NOT NULL AND EXISTS (
        SELECT 1 FROM client_matters cm_fin
        WHERE cm_fin.id = ${financialRecords.clientMatterId}
          AND ${teamMemberSqlFor("cm_fin", user.id)}
      ))`;
    default:
      if (leadLawyerOverlayApplies(user.role)) {
        return sql`(${financialRecords.clientMatterId} IS NOT NULL AND EXISTS (
          SELECT 1 FROM client_matters cm_led
          WHERE cm_led.id = ${financialRecords.clientMatterId}
            AND cm_led.lead_lawyer_id = ${user.id}
        ))`;
      }
      return FALSE_CONDITION;
  }
}

/** Whether the role may reach financial read endpoints at all (base or overlay). */
export function mayViewAnyFinancial(user: AuthUser): boolean {
  return can(user.role, "financial.view") || leadLawyerOverlayApplies(user.role);
}

/**
 * Task visibility condition (row filter for tasks queries).
 *  • tasks.view ALL → unrestricted
 *  • OWN → own tasks (assignee or creator) plus, via the Lead Lawyer overlay,
 *    every task of matters the user leads (client_matter_id link)
 *  • NONE → nothing
 */
export function taskScopeCondition(user: AuthUser): SQL | undefined {
  const scope = scopeFor(user.role, "tasks.view");
  if (scope === "ALL") return undefined;
  if (scope === "NONE") return FALSE_CONDITION;
  const own = or(eq(tasks.assignedTo, user.id), eq(tasks.createdBy, user.id))!;
  if (!leadLawyerOverlayApplies(user.role)) return own;
  return or(
    own,
    sql`(${tasks.clientMatterId} IS NOT NULL AND EXISTS (
      SELECT 1 FROM client_matters cm_task
      WHERE cm_task.id = ${tasks.clientMatterId}
        AND cm_task.lead_lawyer_id = ${user.id}
    ))`,
  )!;
}

// ─── Field-level authorization helpers ────────────────────────────────────────

/**
 * Which authorization-defining fields an update payload actually changes.
 * A field counts as changed only when it is present in the input (not
 * undefined) and differs from the current record value.
 */
export function changedScopeDefiningFields<T extends Record<string, unknown>>(
  existing: T,
  input: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.filter(f => {
    if (!(f in input) || input[f] === undefined) return false;
    const oldVal = (existing as Record<string, unknown>)[f] ?? null;
    const newVal = input[f] ?? null;
    return oldVal !== newVal;
  });
}

/** Capability gate + scope for a router procedure (used by capabilityProcedure). */
export function requireScope(role: string | null | undefined, capability: Capability): Scope {
  return scopeFor(role, capability);
}
