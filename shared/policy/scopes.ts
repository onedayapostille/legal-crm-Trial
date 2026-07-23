/**
 * DataScope — WHICH records a granted capability applies to.
 *
 * A capability answers "may this actor perform this operation at all"; the scope
 * answers "over which rows". Phase 2 defines the scope vocabulary and returns it
 * in every authorization decision; it does NOT yet wire scopes into the DB query
 * layer (that is deferred — see docs/AUTHZ_PHASES.md). Legacy roles always resolve
 * to ALL for capabilities they hold, exactly reproducing pre-migration behavior.
 *
 * Values (from the approved Roles & Permissions Specification v1.1, §2):
 *  - ALL          firm-wide access to the record type.
 *  - OWN_PRACTICE records of the actor's Head-of-Practice practice (location +
 *                 matter type). Requires a per-record HoP reference (not built yet).
 *  - ASSIGNED     matters the actor leads or works on, plus their clients.
 *  - REGISTRY     client registry lists only (existing / leads / rejected), no
 *                 matter detail.
 *  - OWN          records assigned to the actor (e.g. their own tasks).
 *  - NONE         no access. The scope reported whenever `allowed` is false.
 */
export const DATA_SCOPES = [
  "ALL",
  "OWN_PRACTICE",
  "ASSIGNED",
  "REGISTRY",
  "OWN",
  "NONE",
] as const;

export type DataScope = (typeof DATA_SCOPES)[number];

export function isDataScope(v: unknown): v is DataScope {
  return typeof v === "string" && (DATA_SCOPES as readonly string[]).includes(v);
}
