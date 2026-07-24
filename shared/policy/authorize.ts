/**
 * The authorization decision function.
 *
 * `authorize(actor, capability)` returns a typed PolicyDecision — never a bare
 * boolean — carrying the resolved DataScope and a machine-readable reason. It is
 * PURE and fails closed: an unknown role, an unknown capability, or a role that
 * simply lacks the capability all yield `allowed: false, scope: NONE`.
 *
 * Era resolution (see roles.ts / matrix.ts): a live LEGACY role resolves against
 * LEGACY_POLICY (current behavior, scope ALL); a migrated TARGET-only role
 * resolves against TARGET_POLICY (approved scoped matrix). Names shared by both
 * eras (admin/manager/finance) resolve to LEGACY while the app is in the legacy
 * era, so no account gains target rights prematurely.
 *
 * NOTHING here reads role or scope from request input — the actor comes from the
 * authenticated session only. This module is import-safe on both server & client,
 * but on the client it is advisory (UI gating) and MUST NOT be treated as
 * enforcement; the server decision is authoritative.
 */
import type { DataScope } from "./scopes";
import { isCapability, type KnownCapability } from "./capabilities";
import {
  isLegacyRole,
  isPolicyEra,
  isTargetRole,
  isValidRoleEra,
  type PolicyEra,
} from "./roles";
import { LEGACY_POLICY, TARGET_POLICY, type RolePolicy, type TargetAccountRole } from "./matrix";

/** The authenticated actor. Role is a plain string so unknown values fail closed. */
export interface Actor {
  id: number;
  role: string | null | undefined;
  authorizationModel: PolicyEra | string | null | undefined;
  status?: string | null;
}

export type PolicyReason =
  | "OK"
  | "NO_CAPABILITY"
  | "UNKNOWN_ROLE"
  | "UNKNOWN_CAPABILITY"
  | "NO_ERA"
  | "INACTIVE";

export interface PolicyDecision {
  allowed: boolean;
  /** The capability that was evaluated (echoed for logging/telemetry). */
  capability: string;
  /** Effective scope when allowed; NONE when not. */
  scope: DataScope;
  /** Machine-readable outcome code. */
  reason: PolicyReason;
  /** Human-readable explanation (safe to log; never leaks record existence). */
  detail: string;
}

function deny(capability: string, reason: PolicyReason, detail: string): PolicyDecision {
  return { allowed: false, capability, scope: "NONE", reason, detail };
}

/** Resolve the policy map for a role, honoring the active (legacy) era. */
export function policyForRole(role: string, era: PolicyEra): RolePolicy | null {
  if (!isValidRoleEra(role, era)) return null;
  if (era === "legacy" && isLegacyRole(role)) return LEGACY_POLICY[role];
  // Lead Lawyer is a per-matter overlay, never a base account role — no base
  // policy, so it fails closed here and is granted only via the overlay path.
  if (era === "target" && isTargetRole(role) && role !== "lead_lawyer") {
    return TARGET_POLICY[role as TargetAccountRole] ?? null;
  }
  return null;
}

/**
 * Core decision. Optional `overlayGrants` (e.g. the Lead Lawyer per-matter
 * overlay) is additive: it can only grant a capability the base role lacks, never
 * revoke one.
 */
export function authorize(
  actor: Actor,
  capability: string,
  overlayGrants?: Partial<Record<KnownCapability, DataScope>>,
): PolicyDecision {
  if (!isCapability(capability)) {
    return deny(capability, "UNKNOWN_CAPABILITY", `Unknown capability "${capability}".`);
  }
  if (actor.status != null && actor.status !== "active") {
    return deny(capability, "INACTIVE", "Account is not active.");
  }
  if (!isPolicyEra(actor.authorizationModel)) {
    return deny(capability, "NO_ERA", "Actor has no valid authorization model.");
  }
  const role = actor.role;
  if (!role || typeof role !== "string") {
    return deny(capability, "UNKNOWN_ROLE", "No role on actor.");
  }
  const policy = policyForRole(role, actor.authorizationModel);
  if (!policy) {
    return deny(
      capability,
      "UNKNOWN_ROLE",
      `Role "${role}" is invalid for authorization model "${actor.authorizationModel}".`,
    );
  }

  const baseScope = policy[capability];
  if (baseScope && baseScope !== "NONE") {
    return { allowed: true, capability, scope: baseScope, reason: "OK", detail: "Granted by role." };
  }

  // Additive overlay (never removes access).
  const overlayScope = overlayGrants?.[capability];
  if (overlayScope && overlayScope !== "NONE") {
    return { allowed: true, capability, scope: overlayScope, reason: "OK", detail: "Granted by matter overlay." };
  }

  return deny(capability, "NO_CAPABILITY", `Role "${role}" lacks "${capability}".`);
}

/** Boolean convenience for UI gating. Server enforcement should use the decision. */
export function can(
  actor: Actor,
  capability: string,
  overlayGrants?: Partial<Record<KnownCapability, DataScope>>,
): boolean {
  return authorize(actor, capability, overlayGrants).allowed;
}

// ─── Compatibility bridge (Phase-1 permission strings → capabilities) ──────────
// Maps a legacy `resource:view|manage` string to the explicit capabilities it
// covers, reproducing Phase-1 `hasPermission` semantics (`:manage` implies
// `:view`). Used to keep unmigrated routes correct and to prove, in tests, that
// the new policy agrees with the old boolean for every legacy role.
// @deprecated Remove once all routes use capability names directly.

const LEGACY_PERMISSION_MAP: Record<string, KnownCapability[]> = {
  "dashboard:view": ["dashboard:view"],
  "analytics:view": ["analytics:view"],
  "audit:view": ["audit:view"],
  "clients:view": ["clients:view"],
  "clients:manage": ["clients:view", "clients:create", "clients:edit", "clients:delete", "companies:create", "companies:edit"],
  "leads:view": ["leads:view"],
  "leads:manage": ["leads:view", "leads:create", "leads:edit", "leads:delete", "leads:updateStatus"],
  "matters:view": ["matters:view"],
  "matters:manage": ["matters:view", "matters:create", "matters:edit", "matters:delete"],
  "matters:assign_lawyer": ["matters:assign"],
  "tasks:view": ["tasks:view"],
  "tasks:manage": ["tasks:view", "tasks:create", "tasks:edit", "tasks:delete", "tasks:assign"],
  "actions:view": ["actions:view"],
  "actions:manage": ["actions:view", "actions:create", "actions:edit", "actions:delete"],
  "notes:view": ["notes:view"],
  "notes:manage": ["notes:view", "notes:create", "notes:delete"],
  "payments:view": ["payments:view"],
  "payments:manage": ["payments:view", "payments:create", "payments:edit"],
  "financial:view": ["financial:view", "financialReports:view", "financialReports:export", "rates:view"],
  "financial:manage": [
    "financial:view", "financial:create", "financial:edit", "financial:delete",
    "financialReports:view", "financialReports:export",
    "rates:view", "rates:create", "rates:edit", "rates:delete",
  ],
  "ai:assistant": ["ai:use"],
};

/** The explicit capabilities a legacy permission string maps to (empty if none). */
export function legacyPermissionToCapabilities(permission: string): KnownCapability[] {
  return LEGACY_PERMISSION_MAP[permission] ?? [];
}

/**
 * Bridge helper: does the actor satisfy a legacy permission string under the new
 * policy? True iff the actor is allowed EVERY capability the legacy string maps
 * to. Mirrors Phase-1 `hasPermission` for legacy roles.
 */
export function satisfiesLegacyPermission(actor: Actor, permission: string): boolean {
  const caps = legacyPermissionToCapabilities(permission);
  if (caps.length === 0) return false;
  return caps.every(c => authorize(actor, c).allowed);
}
