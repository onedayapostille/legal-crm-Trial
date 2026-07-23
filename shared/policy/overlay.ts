/**
 * Lead Lawyer overlay — additive, per-matter, never a role (spec §3, BR-03).
 *
 * "Lead Lawyer is an assignment, not a grade: any lawyer of any grade can be
 * designated Lead Lawyer on a specific matter." It is modelled as a per-matter
 * flag (matter.lead_lawyer_id) that ADDS authority for THAT matter only.
 *
 * This module defines the OVERLAY mechanism, not its query wiring: it declares
 * the additive grant set and a resolver interface. Actually resolving "is this
 * actor the lead lawyer of this matter?" against the DB, and folding the overlay
 * into query filtering, is deferred to a later phase (see docs/AUTHZ_PHASES.md).
 *
 * The overlay is strictly additive: it may only widen access (grant capabilities
 * at ASSIGNED scope for the one matter); it can never remove a capability the
 * base role already holds.
 */
import type { DataScope } from "./scopes";
import type { KnownCapability } from "./capabilities";

/**
 * The capabilities the Lead Lawyer designation confers, scoped to the single
 * matter the actor leads (the "Lead Lwr" column of the approved matrix).
 */
export const LEAD_LAWYER_OVERLAY_GRANTS: Partial<Record<KnownCapability, DataScope>> = {
  "clients:view": "ASSIGNED",
  "matters:view": "ASSIGNED",
  "matters:edit": "ASSIGNED",
  "financial:view": "ASSIGNED", // view only — BR-04: never create/edit
  "rates:view": "ASSIGNED",
  "tasks:view": "ASSIGNED",
  "tasks:edit": "ASSIGNED",
  "tasks:assign": "ASSIGNED",
};

/** A matter the overlay can apply to. Minimal shape; the real row has more. */
export interface OverlayMatter {
  id: number;
  leadLawyerId: number | null;
}

/** Does this actor hold the Lead Lawyer designation on this matter? */
export function isLeadLawyerOf(
  actor: { id: number },
  matter: OverlayMatter,
): boolean {
  return matter.leadLawyerId != null && matter.leadLawyerId === actor.id;
}

/**
 * The additive grants an actor receives FOR A SPECIFIC MATTER via the overlay.
 * Empty unless the actor is that matter's lead lawyer. Pure — the caller supplies
 * the matter row (resolved from the DB in the enforcement layer, later phase).
 */
export function matterOverlayGrants(
  actor: { id: number },
  matter: OverlayMatter,
): Partial<Record<KnownCapability, DataScope>> {
  return isLeadLawyerOf(actor, matter) ? { ...LEAD_LAWYER_OVERLAY_GRANTS } : {};
}

/**
 * Resolver interface the enforcement layer will implement to fetch the matter row
 * (and thus decide the overlay) for actor-aware checks. Declared here so server
 * code can depend on the abstraction now and wire the DB later.
 */
export interface MatterOverlayResolver {
  getMatter(matterId: number): Promise<OverlayMatter | null>;
}
