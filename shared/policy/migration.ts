/**
 * Migration-readiness (Phase 3) — deterministic legacy→target role mapping and
 * a pure preflight report builder. NOTHING here mutates data or the database; it
 * classifies what a later controlled re-grade migration would need to do.
 *
 * Approved mapping (spec §B):
 *   admin  → admin            (auto)
 *   manager→ manager          (auto)
 *   partner→ head_of_practice (auto)
 *   finance→ finance          (auto)
 *   staff  → coordinator      (auto)
 *   lawyer → MANUAL HR grade  (never auto-mapped — HR assigns the grade)
 *   viewer → NEEDS DECISION   (unmapped pending explicit approval)
 *   "new"  → paralegal        (only if such rows actually exist — see §H)
 *
 * Unknown roles fail closed (disposition "unknown"), surfaced for human review.
 */
import type { TargetAccountRole } from "./matrix";
import { TARGET_ACCOUNT_ROLE_VALUES } from "./roles";

const TARGET_ACCOUNT_SET: ReadonlySet<string> = new Set(TARGET_ACCOUNT_ROLE_VALUES);

export type MappingDisposition =
  | "auto" // deterministic, approved 1:1 mapping
  | "already_target" // already a target account role — no migration needed
  | "manual" // requires HR input (Lawyer grade)
  | "decision" // requires an explicit business decision (Viewer)
  | "unknown"; // role not recognized — fail closed

export interface RoleMappingResult {
  /** The source role string as stored today. */
  source: string;
  disposition: MappingDisposition;
  /** The approved target account role, or null when not auto-mappable. */
  target: TargetAccountRole | null;
  /** Human-readable rationale (no personal data). */
  reason: string;
}

/**
 * The approved mapping as data. `"new"` is included because the spec's mapping
 * names it, but it is applied ONLY if preflight proves such rows exist (§H); it
 * is not a legacy enum value.
 */
export const APPROVED_ROLE_MAPPING: Record<string, RoleMappingResult> = {
  admin: { source: "admin", disposition: "auto", target: "admin", reason: "Unchanged." },
  manager: { source: "manager", disposition: "auto", target: "manager", reason: "Unchanged (read-only)." },
  partner: { source: "partner", disposition: "auto", target: "head_of_practice", reason: "Rename & rescope to own practice." },
  finance: { source: "finance", disposition: "auto", target: "finance", reason: "Unchanged in name; rights per matrix." },
  staff: { source: "staff", disposition: "auto", target: "coordinator", reason: "Rename & rescope (registry + intake)." },
  lawyer: { source: "lawyer", disposition: "manual", target: null, reason: "HR must assign the specific grade (Senior/Executive/Associate/Junior/Trainee)." },
  viewer: { source: "viewer", disposition: "decision", target: null, reason: "No approved target — awaiting an explicit decision." },
  new: { source: "new", disposition: "auto", target: "paralegal", reason: "New hires default to Paralegal (only if such rows exist)." },
};

/**
 * Deterministic classification of a single stored role. Pure. Never auto-maps
 * Lawyer or Viewer. Unrecognized roles fail closed as "unknown".
 */
export function mapLegacyRole(role: string): RoleMappingResult {
  const known = APPROVED_ROLE_MAPPING[role];
  if (known) return known;
  // Already a target account role (e.g. a partially-migrated env)? No-op — such a
  // row needs nothing from the controlled migration.
  if (TARGET_ACCOUNT_SET.has(role)) {
    return {
      source: role,
      disposition: "already_target",
      target: role as TargetAccountRole,
      reason: "Already a target account role — no migration needed.",
    };
  }
  return {
    source: role,
    disposition: "unknown",
    target: null,
    reason: "Unrecognized role — requires manual review before migration.",
  };
}

// ─── Preflight report (pure; the DB query lives in scripts/preflight-roles.ts) ──

/** A (role, count) pair — the only DB-derived input. No personal data. */
export interface RoleCount {
  role: string;
  count: number;
}

export interface PreflightRow extends RoleMappingResult {
  count: number;
}

export interface PreflightReport {
  totalAccounts: number;
  distinctRoles: number;
  rows: PreflightRow[];
  /** Buckets for the controlled migration to act on. */
  autoMappable: PreflightRow[];
  alreadyTarget: PreflightRow[]; // already a target role — no action
  manual: PreflightRow[]; // Lawyer accounts (HR grade)
  needsDecision: PreflightRow[]; // Viewer accounts
  unknown: PreflightRow[]; // roles not in the approved set — fail closed
  /** Whether any "new" rows were actually found (drives §H handling). */
  hasNewRole: boolean;
  note: string;
}

/**
 * Build the preflight report from role counts alone. Deterministic and pure so it
 * is fully unit-testable without a database. Never emits names/emails or any
 * per-account data — counts and dispositions only.
 */
export function buildPreflightReport(counts: RoleCount[]): PreflightReport {
  const rows: PreflightRow[] = counts
    .map(c => ({ ...mapLegacyRole(c.role), count: c.count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));

  const totalAccounts = rows.reduce((n, r) => n + r.count, 0);
  return {
    totalAccounts,
    distinctRoles: rows.length,
    rows,
    autoMappable: rows.filter(r => r.disposition === "auto"),
    alreadyTarget: rows.filter(r => r.disposition === "already_target"),
    manual: rows.filter(r => r.disposition === "manual"),
    needsDecision: rows.filter(r => r.disposition === "decision"),
    unknown: rows.filter(r => r.disposition === "unknown"),
    hasNewRole: rows.some(r => r.source === "new" && r.count > 0),
    note:
      "Read-only preflight. No account rows are modified. Lawyer accounts need " +
      "HR grade assignment; Viewer accounts need an explicit decision; unknown " +
      "roles must be reviewed manually before any controlled migration.",
  };
}

/** Render the report as plain text for a console/report artifact (no PII). */
export function formatPreflightReport(r: PreflightReport): string {
  const lines: string[] = [];
  lines.push("AGP CRM — role migration preflight (read-only)");
  lines.push(`Total accounts: ${r.totalAccounts} across ${r.distinctRoles} distinct role(s)`);
  lines.push("");
  lines.push("role                 count  disposition  → target");
  lines.push("-------------------- -----  -----------  --------");
  for (const row of r.rows) {
    lines.push(
      `${row.source.padEnd(20)} ${String(row.count).padStart(5)}  ` +
        `${row.disposition.padEnd(11)}  ${row.target ?? "—"}`,
    );
  }
  lines.push("");
  lines.push(`auto-mappable: ${r.autoMappable.reduce((n, x) => n + x.count, 0)} account(s)`);
  lines.push(`already target (no action): ${r.alreadyTarget.reduce((n, x) => n + x.count, 0)} account(s)`);
  lines.push(`manual (Lawyer → HR grade): ${r.manual.reduce((n, x) => n + x.count, 0)} account(s)`);
  lines.push(`needs decision (Viewer): ${r.needsDecision.reduce((n, x) => n + x.count, 0)} account(s)`);
  lines.push(`unknown (review): ${r.unknown.reduce((n, x) => n + x.count, 0)} account(s)`);
  lines.push(`"new" rows present: ${r.hasNewRole ? "yes" : "no"}`);
  return lines.join("\n");
}
