import { useAuth } from "@/_core/hooks/useAuth";
import {
  can,
  scopeFor,
  isLeadLawyerEligible,
  type Capability,
  type Scope,
} from "@shared/permissions";

/**
 * Single frontend entry point for permission checks. Wraps the central
 * capability × scope policy (shared/permissions.ts) around the authenticated
 * user — components never compare role strings or duplicate the matrix.
 *
 * The frontend is NOT the security boundary: every rule checked here is also
 * enforced server-side. These checks only decide what UI to render.
 */
export function usePermissions() {
  const { user, loading, isAuthenticated } = useAuth();
  const role = user?.role ?? null;

  return {
    user,
    loading,
    isAuthenticated,
    role,
    /** Whether the current user holds a capability at any scope. */
    can: (capability: Capability) => can(role, capability),
    /** The data scope the current user holds for a capability. */
    scope: (capability: Capability): Scope => scopeFor(role, capability),
    /** May hold the per-matter Lead Lawyer designation (overlay). */
    leadLawyerEligible: isLeadLawyerEligible(role),
  };
}
