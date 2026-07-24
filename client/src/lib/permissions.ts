/**
 * Client-side authorization helpers (Phase 10).
 *
 * These drive UI VISIBILITY and read-only state only — they are ADVISORY. The
 * server `authorize()` decision is always authoritative (BR-09); disabling a
 * button is never the enforcement layer. The helpers reuse the SAME pure policy
 * engine the server uses, so the UI and the server agree for both legacy and
 * migrated (target) accounts.
 */
import { can, APPROVED_ACCOUNT_ROLES, isLegacyOnlyAccountRole, type KnownCapability } from "@shared/policy";

export type SessionUser = { id: number; role: string; status?: string | null } | null | undefined;

/** A session that is present AND active. An inactive/suspended user is treated as
 *  logged out (see useAuth) — never as an authenticated, capable actor. */
export function isActiveSession(user: SessionUser): boolean {
  return !!user && (user.status == null || user.status === "active");
}

/**
 * Whether the current user may perform `capability`. False for no session, an
 * inactive session, or a role the policy does not grant. Base-role only — the
 * per-matter Lead Lawyer overlay is resolved at the record level, not here.
 */
export function userCan(user: SessionUser, capability: KnownCapability): boolean {
  if (!isActiveSession(user)) return false;
  return can({ id: user!.id, role: user!.role, status: "active" }, capability);
}

/** Coordinator receives only the strict payment-status financial projection. */
export function isPaymentStatusOnly(user: SessionUser): boolean {
  return isActiveSession(user) && user!.role === "coordinator";
}

/**
 * Single source of truth for route/navigation gating: path → the capability
 * required to open it. Both `ProtectedRoute` (App.tsx) and the sidebar
 * (DashboardLayout) derive from this, and a policy test cross-checks it against
 * the server capability set so the client gate can never drift from server names.
 */
export const ROUTE_CAPABILITIES = {
  "/dashboard": "dashboard:view",
  "/clients": "clients:view",
  "/clients/new": "clients:create",
  "/clients/existing": "clients:view",
  "/clients/leads": "clients:view",
  "/clients/rejected": "clients:view",
  "/clients/:id": "clients:view",
  "/enquiries/log": "leads:view",
  "/enquiries/new": "leads:create",
  "/enquiries/:id": "leads:view",
  "/enquiries/:id/edit": "leads:view",
  "/leads/new": "leads:create",
  "/leads/:id": "leads:view",
  "/leads/:id/edit": "leads:view",
  "/client-actions": "actions:view",
  "/financial": "financial:view",
  "/financial-reports": "financialReports:view",
  "/import": "clients:create",
  "/matters": "matters:view",
  "/matters/new": "matters:create",
  "/tasks": "tasks:view",
  "/tasks/new": "tasks:create",
  "/status-tracker": "analytics:view",
  "/payment-tracker": "payments:view",
  "/ai-assistant": "ai:use",
  "/user-management": "users:manage",
} as const satisfies Record<string, KnownCapability>;

export type GatedRoute = keyof typeof ROUTE_CAPABILITIES;

/**
 * Roles the User Management dropdown may offer, given the account being edited.
 *
 * `finance` is WITHHELD from new/changed assignment: with no policy-era
 * discriminator, `authorize()` resolves `finance` to LEGACY finance, not the
 * approved TARGET Finance — so offering it in the approved list would misrepresent
 * the role and let an Admin "create/transition" a Finance account under a false
 * target expectation. Existing Finance (and legacy-only) accounts still surface
 * their current role when edited, so they display and can be kept unchanged
 * (coexistence) without being force-migrated.
 *
 * - No edit target (new account) → the approved roles minus `finance`.
 * - Editing an account whose current role is legacy-only OR `finance` → that role
 *   is appended so it remains visible/selectable for that account only.
 */
export function assignableRoleOptions(currentRole?: string | null): string[] {
  const opts = (APPROVED_ACCOUNT_ROLES as readonly string[]).filter(r => r !== "finance");
  if (currentRole && (isLegacyOnlyAccountRole(currentRole) || currentRole === "finance") && !opts.includes(currentRole)) {
    return [...opts, currentRole];
  }
  return [...opts];
}
