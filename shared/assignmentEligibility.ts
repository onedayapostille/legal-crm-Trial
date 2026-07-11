import type { UserRole } from "./const";

// ─── Lawyer-assignment eligibility (single source of truth) ───────────────────
//
// Which user roles may be newly assigned to each lawyer field on a Matter or
// Financial Record. Used by the server to filter the eligible-lawyer dropdown
// source AND to validate submitted assignments (defense in depth), and by the
// client for field labels. Do not duplicate these role lists in components.
//
// Role-model mapping (the project has no distinct "Head of Practice" role, so
// leadership-tier fields map to the existing partner/lawyer set used by the
// pre-existing Lead Partner dropdown, and team-tier fields map to the broader
// set already used for hourly-rate lawyer assignment):
//   • Leadership tier (Lead Partner, Attorney Head): partner, lawyer
//   • Legal team tier (Support Lead, Attorney 1–4, Responsible Lawyer):
//     admin, manager, partner, lawyer
//
// Only ACTIVE users are ever eligible for NEW assignments; existing/historical
// assignments to now-inactive users are preserved and displayed, but cannot be
// re-selected (enforced server-side, change-only validation).

/** Roles that may lead a matter (existing Lead Partner dropdown set). */
export const LEADERSHIP_ASSIGNMENT_ROLES: readonly UserRole[] = ["partner", "lawyer"];

/** Roles that may work on / own a matter (existing hourly-rates set). */
export const LEGAL_TEAM_ASSIGNMENT_ROLES: readonly UserRole[] = ["admin", "manager", "partner", "lawyer"];

export const ASSIGNMENT_FIELDS = {
  leadPartner:       { label: "Lead Partner",       roles: LEADERSHIP_ASSIGNMENT_ROLES },
  supportLead:       { label: "Support Lead",       roles: LEGAL_TEAM_ASSIGNMENT_ROLES },
  attorneyHead:      { label: "Attorney Head",      roles: LEADERSHIP_ASSIGNMENT_ROLES },
  attorney1:         { label: "Attorney 1",         roles: LEGAL_TEAM_ASSIGNMENT_ROLES },
  attorney2:         { label: "Attorney 2",         roles: LEGAL_TEAM_ASSIGNMENT_ROLES },
  attorney3:         { label: "Attorney 3",         roles: LEGAL_TEAM_ASSIGNMENT_ROLES },
  attorney4:         { label: "Attorney 4",         roles: LEGAL_TEAM_ASSIGNMENT_ROLES },
  responsibleLawyer: { label: "Responsible Lawyer", roles: LEGAL_TEAM_ASSIGNMENT_ROLES },
} as const;

export type AssignmentField = keyof typeof ASSIGNMENT_FIELDS;

export const ASSIGNMENT_FIELD_NAMES = Object.keys(ASSIGNMENT_FIELDS) as AssignmentField[];
