import type { UserRole } from "./const";
import { LEAD_LAWYER_ELIGIBLE_ROLES } from "./permissions";

// ─── Lawyer-assignment eligibility (single source of truth) ───────────────────
//
// Which user roles may be newly assigned to each lawyer field on a Matter or
// Financial Record. Used by the server to filter the eligible-lawyer dropdown
// source AND to validate submitted assignments (defense in depth), and by the
// client for field labels. Do not duplicate these role lists in components.
//
// Role-model mapping (AGP Roles & Permissions Spec v1.1):
//   • Leadership tier (Lead Lawyer / Lead Partner, Attorney Head): the
//     Lead-Lawyer-eligible grades — Head of Practice, Senior/Executive
//     Associate, Associate, Junior Lawyer (Trainee excluded per the Excel
//     Position Mapping; legacy partner/lawyer retained for un-migrated
//     accounts).
//   • Legal team tier (Support Lead, Attorney 1–4, Responsible Lawyer): all
//     lawyer grades including Trainee. admin/manager were removed from NEW
//     team assignments (they are not lawyer positions); historical
//     assignments are preserved via change-only validation.
//
// Only ACTIVE users are ever eligible for NEW assignments; existing/historical
// assignments to now-inactive users are preserved and displayed, but cannot be
// re-selected (enforced server-side, change-only validation).

/** Roles that may lead a matter (Lead Lawyer designation set). */
export const LEADERSHIP_ASSIGNMENT_ROLES: readonly UserRole[] =
  LEAD_LAWYER_ELIGIBLE_ROLES as readonly UserRole[];

/** Roles that may work on / own a matter (matter-team tier). */
export const LEGAL_TEAM_ASSIGNMENT_ROLES: readonly UserRole[] = [
  "head_of_practice",
  "senior_associate",
  "executive_associate",
  "associate",
  "junior_lawyer",
  "trainee",
  "partner",
  "lawyer",
];

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
