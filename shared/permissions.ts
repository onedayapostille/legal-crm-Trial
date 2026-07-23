// ─── Central authorization policy (single source of truth) ───────────────────
//
// Implements the approved AGP Roles & Permissions Specification v1.1
// (14 Jul 2026, BR-01..BR-15) as a capability × scope matrix.
//
// Both the server (procedure guards + SQL scope filters) and the client
// (navigation / button visibility) read THIS module. The client is never the
// security boundary: every rule here is enforced server-side in
// server/authorization.ts + server/db.ts.
//
// Lead Lawyer is NOT an account role. It is a per-matter designation carried
// by client_matters.lead_lawyer_id and applied as an additive overlay on top
// of the base role (see LEAD_LAWYER_OVERLAY notes below and
// docs/roles-permissions-implementation.md).

// ─── Roles ────────────────────────────────────────────────────────────────────

/** The 11 persistent account roles an Admin may assign (User Management). */
export const ACCOUNT_ROLES = [
  "admin",
  "manager",
  "head_of_practice",
  "senior_associate",
  "executive_associate",
  "associate",
  "junior_lawyer",
  "trainee",
  "paralegal",
  "finance",
  "coordinator",
] as const;

export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/**
 * Legacy roles that may still exist on user rows (enum values are never
 * dropped). They are NOT selectable in User Management:
 *   partner → behaves as head_of_practice (approved migration mapping)
 *   staff   → behaves as coordinator      (approved migration mapping)
 *   lawyer  → awaiting explicit HR grade mapping; behaves as the
 *             least-privilege lawyer baseline (= associate profile)
 *   viewer  → not part of the approved role set; no capabilities. Flagged by
 *             scripts/role-migration-report.ts for admin reassignment.
 */
export const LEGACY_ROLES = ["partner", "lawyer", "staff", "viewer"] as const;
export type LegacyRole = (typeof LEGACY_ROLES)[number];

export type AnyRole = AccountRole | LegacyRole;

export const ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = {
  admin: "Admin",
  manager: "Manager",
  head_of_practice: "Head of Practice",
  senior_associate: "Senior Associate",
  executive_associate: "Executive Associate",
  associate: "Associate",
  junior_lawyer: "Junior Lawyer",
  trainee: "Trainee",
  paralegal: "Paralegal",
  finance: "Finance",
  coordinator: "Coordinator",
};

/** Concise descriptions shown in the User Management role dropdown. */
export const ACCOUNT_ROLE_DESCRIPTIONS: Record<AccountRole, string> = {
  admin: "Unrestricted access to every module, including User Management and System Settings.",
  manager: "Read-only oversight of all clients, matters, financials, tasks and reports.",
  head_of_practice:
    "Views everything firm-wide; creates and edits clients, matters and financials within own practice (location + matter type).",
  senior_associate:
    "Assigned matters and their clients; views their financial records read-only; own tasks; can assign tasks.",
  executive_associate:
    "Assigned matters and their clients; no financial visibility; own tasks; can assign tasks.",
  associate: "Assigned matters and their clients; no financial visibility; own tasks only.",
  junior_lawyer: "Assigned matters and their clients; no financial visibility; own tasks only.",
  trainee: "Assigned matters and their clients; no financial visibility; own tasks only.",
  paralegal:
    "Views/edits existing clients and all matters; no financial visibility; own tasks only.",
  finance:
    "Full clients, matters and financial records access; views financial reports; own tasks.",
  coordinator:
    "Intake & registry: manages enquiries, leads and existing clients (and their matters); read-only financials; all tasks; can assign tasks.",
};

export const LEGACY_ROLE_LABELS: Record<LegacyRole, string> = {
  partner: "Partner (legacy — behaves as Head of Practice)",
  lawyer: "Lawyer (legacy — awaiting HR grade mapping)",
  staff: "Staff (legacy — behaves as Coordinator)",
  viewer: "Viewer (legacy — no access)",
};

/**
 * Lawyer-grade account roles (the seniority ladder). Used for grade dropdowns
 * and the legacy-lawyer migration report.
 */
export const LAWYER_GRADE_ROLES: readonly AccountRole[] = [
  "head_of_practice",
  "senior_associate",
  "executive_associate",
  "associate",
  "junior_lawyer",
  "trainee",
];

/**
 * Roles that may be NEWLY designated Lead Lawyer on a matter.
 *
 * KNOWN SPECIFICATION CONFLICT (documented, least privilege applied):
 * the Word spec §2 says "any lawyer of any grade", while the Excel Position
 * Mapping lists "Head of Practice, Senior, Executive, Associate, or Junior" —
 * omitting Trainee. Trainee is therefore NOT eligible.
 * Legacy 'partner'/'lawyer' stay eligible so un-migrated accounts keep
 * working (existing approved behavior: LEAD_LAWYER_ROLES = partner|lawyer).
 */
export const LEAD_LAWYER_ELIGIBLE_ROLES: readonly AnyRole[] = [
  "head_of_practice",
  "senior_associate",
  "executive_associate",
  "associate",
  "junior_lawyer",
  "partner",
  "lawyer",
];

// ─── Scopes ───────────────────────────────────────────────────────────────────

export const SCOPES = ["ALL", "OWN_PRACTICE", "ASSIGNED", "REGISTRY", "OWN", "NONE"] as const;

/**
 * ALL          — firm-wide records of the resource type.
 * OWN_PRACTICE — records whose responsible Head of Practice is the user,
 *                resolved by (city, matter type) via the practice_heads table.
 * ASSIGNED     — matters where the user is the Lead Lawyer or a member of the
 *                matter team (the authoritative user-FK columns
 *                lead_lawyer_id / support_lead_id / attorney_head_id /
 *                attorney_1_id..attorney_4_id), plus the clients those
 *                matters belong to. Never resolved from free-text names.
 * REGISTRY     — the client registry (existing / leads / rejected lists);
 *                does not by itself grant matter or financial authority.
 * OWN          — records assigned directly to the user (e.g. tasks).
 * NONE         — no access.
 */
export type Scope = (typeof SCOPES)[number];

// ─── Capabilities ─────────────────────────────────────────────────────────────

export const CAPABILITIES = [
  "clients.view",
  "clients.create",
  "clients.edit",
  "clients.delete",
  "matters.view",
  "matters.create",
  "matters.edit",
  "matters.assignTeam",
  "matters.delete",
  "financial.view",
  "financial.create",
  "financial.edit",
  "financial.delete",
  "financialReports.view",
  "enquiries.view",
  "enquiries.manage",
  "enquiries.delete",
  "tasks.view",
  "tasks.update",
  "tasks.assign",
  "tasks.delete",
  "dashboard.view",
  "users.manage",
  "settings.manage",
  "ai.use",
  "import.clients",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Roles carrying their own policy row. partner/staff alias onto their
 * canonical successors; lawyer and viewer have explicit legacy rows.
 */
type PolicyRole = AccountRole | "lawyer" | "viewer";

function toPolicyRole(role: string | null | undefined): PolicyRole | null {
  switch (role) {
    case "partner":
      return "head_of_practice";
    case "staff":
      return "coordinator";
    default:
      return (ACCOUNT_ROLES as readonly string[]).includes(role ?? "") ||
        role === "lawyer" ||
        role === "viewer"
        ? (role as PolicyRole)
        : null;
  }
}

// ─── The permission matrix ────────────────────────────────────────────────────
// Source-of-truth order: BR-01..BR-15, then the Excel capability rows, then
// role authority summaries. Delete rights follow the Excel F-codes: Admin is
// the only role with Full (incl. delete) on clients/matters/tasks/enquiries;
// Finance additionally holds Full on financial records (both pre-existing).
// No new delete rights were invented; several existing over-broad delete
// grants were tightened to match the matrix (see docs).
//
// A missing role entry means NONE.

const M: Record<Capability, Partial<Record<PolicyRole, Scope>>> = {
  "clients.view": {
    admin: "ALL",
    manager: "ALL",
    head_of_practice: "ALL",
    senior_associate: "ASSIGNED",
    executive_associate: "ASSIGNED",
    associate: "ASSIGNED",
    junior_lawyer: "ASSIGNED",
    trainee: "ASSIGNED",
    lawyer: "ASSIGNED",
    paralegal: "ALL",
    finance: "ALL",
    coordinator: "REGISTRY",
  },
  "clients.create": {
    admin: "ALL",
    head_of_practice: "OWN_PRACTICE",
    finance: "ALL",
    coordinator: "REGISTRY", // leads & existing clients (BR-13)
  },
  "clients.edit": {
    admin: "ALL",
    head_of_practice: "OWN_PRACTICE",
    // Least-privilege reading of "views and edits all existing clients":
    // paralegal edits Existing Client records only (enforced server-side).
    paralegal: "ALL",
    finance: "ALL",
    // Coordinator edits leads & existing clients; rejected records stay
    // locked except the approved reactivation workflow (server-enforced).
    coordinator: "REGISTRY",
  },
  "clients.delete": { admin: "ALL" },

  "matters.view": {
    admin: "ALL",
    manager: "ALL",
    head_of_practice: "ALL",
    senior_associate: "ASSIGNED",
    executive_associate: "ASSIGNED",
    associate: "ASSIGNED",
    junior_lawyer: "ASSIGNED",
    trainee: "ASSIGNED",
    lawyer: "ASSIGNED",
    paralegal: "ALL",
    finance: "ALL",
    coordinator: "ALL",
  },
  "matters.create": {
    admin: "ALL",
    head_of_practice: "OWN_PRACTICE",
    finance: "ALL",
    coordinator: "ALL",
  },
  "matters.edit": {
    admin: "ALL",
    head_of_practice: "OWN_PRACTICE",
    senior_associate: "ASSIGNED",
    executive_associate: "ASSIGNED",
    associate: "ASSIGNED",
    junior_lawyer: "ASSIGNED",
    trainee: "ASSIGNED",
    lawyer: "ASSIGNED",
    paralegal: "ALL",
    finance: "ALL",
    coordinator: "ALL",
  },
  // Authorization-defining matter fields (lead lawyer, team membership,
  // matter type, client link). "Edit matter details" does NOT include these.
  // Creators may set the initial team when creating a matter; changing them
  // afterwards requires this capability.
  "matters.assignTeam": {
    admin: "ALL",
    head_of_practice: "OWN_PRACTICE",
  },
  "matters.delete": { admin: "ALL" },

  "financial.view": {
    admin: "ALL",
    manager: "ALL",
    head_of_practice: "ALL",
    senior_associate: "ASSIGNED", // read-only (BR-04)
    finance: "ALL",
    coordinator: "ALL", // strictly read-only (BR-07)
  },
  "financial.create": {
    admin: "ALL",
    head_of_practice: "OWN_PRACTICE", // BR-06
    finance: "ALL",
  },
  "financial.edit": {
    admin: "ALL",
    head_of_practice: "OWN_PRACTICE",
    finance: "ALL",
  },
  // Pre-existing delete surface (financial:manage = admin, finance); Excel
  // grants F(All) to both. HoP gets C+E only — no delete.
  "financial.delete": { admin: "ALL", finance: "ALL" },

  "financialReports.view": {
    admin: "ALL",
    manager: "ALL",
    head_of_practice: "ALL", // BR-14
    finance: "ALL", // BR-12
  },

  "enquiries.view": {
    admin: "ALL",
    manager: "ALL",
    head_of_practice: "ALL",
    coordinator: "ALL",
  },
  "enquiries.manage": {
    admin: "ALL",
    coordinator: "ALL", // BR-15
  },
  "enquiries.delete": { admin: "ALL" },

  "tasks.view": {
    admin: "ALL",
    manager: "ALL", // view only; tasks.update is NONE (BR-08)
    head_of_practice: "ALL",
    senior_associate: "OWN",
    executive_associate: "OWN",
    associate: "OWN",
    junior_lawyer: "OWN",
    trainee: "OWN",
    lawyer: "OWN",
    paralegal: "OWN", // BR-11
    finance: "OWN", // BR-12
    coordinator: "ALL",
  },
  "tasks.update": {
    admin: "ALL",
    head_of_practice: "ALL",
    senior_associate: "OWN",
    executive_associate: "OWN",
    associate: "OWN",
    junior_lawyer: "OWN",
    trainee: "OWN",
    lawyer: "OWN",
    paralegal: "OWN",
    finance: "OWN",
    coordinator: "ALL",
  },
  // BR-10. The Lead Lawyer overlay additionally grants assignment for the
  // led matter's tasks (server-enforced, see hasLeadLawyerAuthority).
  "tasks.assign": {
    admin: "ALL",
    head_of_practice: "ALL",
    senior_associate: "ALL",
    executive_associate: "ALL",
    coordinator: "ALL",
  },
  "tasks.delete": { admin: "ALL" },

  "dashboard.view": {
    admin: "ALL",
    manager: "ALL",
    head_of_practice: "ALL",
    senior_associate: "ASSIGNED",
    executive_associate: "ASSIGNED",
    associate: "ASSIGNED",
    junior_lawyer: "ASSIGNED",
    trainee: "ASSIGNED",
    lawyer: "ASSIGNED",
    paralegal: "ALL",
    finance: "ALL",
    coordinator: "REGISTRY",
  },

  "users.manage": { admin: "ALL" },
  "settings.manage": { admin: "ALL" },

  // Existing module, preserved for the roles that held it (staff/coordinator
  // and paralegal never had it). Data returned is scoped by role inside
  // server/aiAnalytics.ts (financial sections require financial.view = ALL).
  "ai.use": {
    admin: "ALL",
    manager: "ALL",
    head_of_practice: "ALL",
    senior_associate: "ASSIGNED",
    executive_associate: "ASSIGNED",
    associate: "ASSIGNED",
    junior_lawyer: "ASSIGNED",
    trainee: "ASSIGNED",
    lawyer: "ASSIGNED",
    finance: "ALL",
  },

  // Bulk import writes clients + matters + financial fields firm-wide.
  "import.clients": { admin: "ALL", finance: "ALL" },
};

// ─── Evaluation ───────────────────────────────────────────────────────────────

/** Data scope the role holds for a capability (NONE when not granted). */
export function scopeFor(role: string | null | undefined, capability: Capability): Scope {
  const policyRole = toPolicyRole(role);
  if (!policyRole) return "NONE";
  return M[capability]?.[policyRole] ?? "NONE";
}

/** Whether the role holds the capability at any scope. */
export function can(role: string | null | undefined, capability: Capability): boolean {
  return scopeFor(role, capability) !== "NONE";
}

/** Whether the role may be newly designated Lead Lawyer on a matter. */
export function isLeadLawyerEligible(role: string | null | undefined): boolean {
  return LEAD_LAWYER_ELIGIBLE_ROLES.includes((role ?? "") as AnyRole);
}

/**
 * Whether the Lead Lawyer overlay is honored for this role. Mirrors
 * eligibility: designations held by non-eligible roles (e.g. a user later
 * demoted to trainee) confer no authority until the designation is moved.
 */
export function leadLawyerOverlayApplies(role: string | null | undefined): boolean {
  return isLeadLawyerEligible(role);
}

/**
 * Least-privilege spec reading (documented ambiguity): the Paralegal's
 * "views and edits all existing clients" grants edit rights over Existing
 * Client records ONLY — no general edit rights over Leads or Rejected.
 */
export function clientEditLimitedToExistingClients(role: string | null | undefined): boolean {
  return role === "paralegal";
}

/** Label for any role value, including legacy ones. */
export function roleLabel(role: string | null | undefined): string {
  if ((ACCOUNT_ROLES as readonly string[]).includes(role ?? "")) {
    return ACCOUNT_ROLE_LABELS[role as AccountRole];
  }
  if ((LEGACY_ROLES as readonly string[]).includes(role ?? "")) {
    return LEGACY_ROLE_LABELS[role as LegacyRole];
  }
  return role ?? "Unknown";
}
