/**
 * Centralized authorization policy (Phase 2 foundation).
 *
 * Typed capabilities + data scopes + a role→capability→scope matrix, exposed
 * through a pure `authorize(actor, capability): PolicyDecision`. Server code
 * enforces with this; client code may use the same capability names for UI gating
 * only (never as enforcement).
 *
 * Rollout status: the engine and matrix exist, but routes still use the Phase-1
 * `permissionProcedure` bridge and DB queries are not yet scope-filtered. See
 * docs/AUTHZ_PHASES.md for what remains.
 */
export * from "./scopes";
export * from "./capabilities";
export * from "./roles";
export * from "./matrix";
export * from "./overlay";
export * from "./authorize";
export * from "./migration";
