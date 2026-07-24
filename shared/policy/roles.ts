/**
 * Role model — legacy (live now) vs target (approved, not yet migrated).
 *
 * The DB `users.role` column currently holds only LEGACY roles. The target roles
 * from the approved spec v1.1 exist here as TYPES and DATA so the policy engine
 * and tests can represent them, but — per the phased rollout (§H) — no live
 * account holds a target role, so encoding their grants grants nobody anything
 * until account migration (a later phase).
 *
 * `authorize` resolves a live legacy role against LEGACY_POLICY and a target-only
 * role against TARGET_POLICY (see matrix.ts / authorize.ts). The names shared by
 * both eras (admin, manager, finance) deliberately resolve to the LEGACY policy
 * while the app is in the legacy era, so `finance` keeps its pre-migration rights
 * until a later phase explicitly promotes it — never prematurely.
 */

/** The seven roles currently persisted in users.role (shared/const.ts USER_ROLES). */
export const LEGACY_ROLES = [
  "admin",
  "manager",
  "partner",
  "lawyer",
  "finance",
  "staff",
  "viewer",
] as const;
export type LegacyRole = (typeof LEGACY_ROLES)[number];

/** The twelve target roles from the approved specification (§3). */
export const TARGET_ROLES = [
  "admin",
  "manager",
  "head_of_practice",
  "lead_lawyer",
  "senior_associate",
  "executive_associate",
  "associate",
  "junior_lawyer",
  "trainee",
  "paralegal",
  "finance",
  "coordinator",
] as const;
export type TargetRole = (typeof TARGET_ROLES)[number];

export type PolicyRole = LegacyRole | TargetRole;

const LEGACY_SET: ReadonlySet<string> = new Set(LEGACY_ROLES);
const TARGET_SET: ReadonlySet<string> = new Set(TARGET_ROLES);

export function isLegacyRole(v: unknown): v is LegacyRole {
  return typeof v === "string" && LEGACY_SET.has(v);
}
export function isTargetRole(v: unknown): v is TargetRole {
  return typeof v === "string" && TARGET_SET.has(v);
}

/** Target-only roles (present in the target set but never a live legacy value). */
export function isTargetOnlyRole(v: unknown): v is Exclude<TargetRole, LegacyRole> {
  return isTargetRole(v) && !isLegacyRole(v);
}

/**
 * Persistable account roles — the exact value set the `user_role` DB enum carries
 * after the Phase-3 additive migration: every legacy role plus every TARGET
 * account role. Excludes `lead_lawyer` (a per-matter overlay, never stored on an
 * account). This is the single source of truth the drizzle enum in
 * `drizzle/schema.ts` is drift-checked against (see roleMigration.test.ts).
 *
 * Ordering: legacy first, then target — mirrors the enum's ADD VALUE append order
 * (cosmetic; the app never orders by role).
 */
export const ACCOUNT_ROLE_VALUES = [
  // legacy (retained for coexistence)
  "admin", "manager", "partner", "lawyer", "finance", "staff", "viewer",
  // target account roles (added additively in migration 0023)
  "head_of_practice", "senior_associate", "executive_associate", "associate",
  "junior_lawyer", "trainee", "paralegal", "coordinator",
] as const;
export type AccountRole = (typeof ACCOUNT_ROLE_VALUES)[number];

const ACCOUNT_ROLE_SET: ReadonlySet<string> = new Set(ACCOUNT_ROLE_VALUES);

/** True for any value the `user_role` column may legitimately store. */
export function isAccountRole(v: unknown): v is AccountRole {
  return typeof v === "string" && ACCOUNT_ROLE_SET.has(v);
}

/** Target account roles only (target set minus the overlay and legacy-only names). */
export const TARGET_ACCOUNT_ROLE_VALUES = [
  "head_of_practice", "senior_associate", "executive_associate", "associate",
  "junior_lawyer", "trainee", "paralegal", "coordinator",
] as const;

/**
 * The 11 APPROVED persistent account roles offered for NEW assignment in User
 * Management (spec §3 — every target role except the Lead Lawyer overlay). The
 * four legacy-only roles (partner/lawyer/staff/viewer) are excluded from new
 * assignments but remain displayable on existing accounts during coexistence.
 * Lead Lawyer is never here — it is a per-matter overlay, not an account role.
 */
export const APPROVED_ACCOUNT_ROLES = [
  "admin", "manager", "head_of_practice", "senior_associate", "executive_associate",
  "associate", "junior_lawyer", "trainee", "paralegal", "finance", "coordinator",
] as const satisfies readonly AccountRole[];

const LEGACY_ONLY_ROLES: ReadonlySet<string> = new Set(["partner", "lawyer", "staff", "viewer"]);

/** A legacy-only role: still valid on existing accounts, never offered for new assignment. */
export function isLegacyOnlyAccountRole(v: unknown): boolean {
  return typeof v === "string" && LEGACY_ONLY_ROLES.has(v);
}

/** Human labels for every persistable account role (legacy + target), for the UI. */
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
  // Legacy-only — shown for existing accounts, not offered for new assignment.
  partner: "Partner (legacy)",
  lawyer: "Lawyer (legacy)",
  staff: "Staff (legacy)",
  viewer: "Viewer (legacy)",
};

/**
 * Migration mapping (spec §6) — informational only. Consumed by no runtime path
 * in this phase; documents how a later account migration should re-grade users.
 * `null` = a target designation with no source legacy role (new).
 */
export const MIGRATION_MAP: Record<LegacyRole, TargetRole[] | null> = {
  admin: ["admin"],
  manager: ["manager"],
  partner: ["head_of_practice"],
  // HR confirms each lawyer's grade at migration.
  lawyer: [
    "senior_associate",
    "executive_associate",
    "associate",
    "junior_lawyer",
    "trainee",
  ],
  finance: ["finance"],
  staff: ["coordinator"],
  viewer: null, // no target equivalent; retire or map manually
};
