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
