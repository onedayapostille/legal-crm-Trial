/**
 * The authorization matrix — the single source of truth for role → capability →
 * scope. Two eras coexist (see roles.ts):
 *
 *  - LEGACY_POLICY reproduces the CURRENT (post–Phase-1) behavior of the seven
 *    live roles EXACTLY, always at scope ALL (the app has no record-level scoping
 *    yet). This is what `authorize` uses today, so migrating a route to the new
 *    engine changes nothing for existing accounts.
 *
 *  - TARGET_POLICY encodes the approved Roles & Permissions Specification v1.1
 *    (companion matrix workbook) for the target account roles. No live account
 *    holds a target role, so these grants are inert until account migration — we
 *    represent the future without granting it prematurely (spec §H).
 *
 * Lead Lawyer is NOT a base role here — it is an additive per-matter overlay
 * (see overlay.ts, spec §3/BR-03).
 *
 * Mutation/ancillary capabilities the approved matrix does not enumerate
 * (payments create/edit, notes create/delete, companies, client action log, ai)
 * fail closed for target roles pending a later phase rather than being invented
 * here. The VIEW of Payment Tracker and Notes is the exception: BR-08's read-only
 * Manager "views everything", so `payments:view`/`notes:view` ARE granted (to
 * Manager). Everything stays fully specified for LEGACY roles so the compatibility
 * bridge is faithful. See DEFERRED_TARGET_CAPABILITIES below.
 */
import type { DataScope } from "./scopes";
import type { KnownCapability } from "./capabilities";
import { CAPABILITIES } from "./capabilities";
import type { LegacyRole, TargetRole } from "./roles";

export type RolePolicy = Partial<Record<KnownCapability, DataScope>>;

/** Grant every known capability at scope ALL (Admin). */
function fullAccess(): RolePolicy {
  const p: RolePolicy = {};
  for (const c of CAPABILITIES) p[c] = "ALL";
  return p;
}

// ─── LEGACY_POLICY (live now — mirrors post–Phase-1 ROLE_PERMISSIONS) ──────────
// Every capability a legacy role holds is scope ALL. `:manage` from Phase-1 is
// expanded into its explicit operations (view/create/edit/delete[/assign]).

const LEGACY_MANAGER: RolePolicy = {
  "dashboard:view": "ALL",
  "clients:view": "ALL",
  "leads:view": "ALL",
  "matters:view": "ALL",
  "tasks:view": "ALL",
  "actions:view": "ALL",
  "notes:view": "ALL",
  "analytics:view": "ALL",
  "payments:view": "ALL",
  "financial:view": "ALL",
  "financialReports:view": "ALL",
  "financialReports:export": "ALL",
  "rates:view": "ALL",
  "audit:view": "ALL",
  "ai:use": "ALL",
};

// partner (Phase-1): clients/leads/matters/tasks/actions manage, notes manage,
// matters:assign_lawyer, payments:view, financial:view, audit:view.
const LEGACY_PARTNER: RolePolicy = {
  "dashboard:view": "ALL",
  "clients:view": "ALL", "clients:create": "ALL", "clients:edit": "ALL", "clients:delete": "ALL",
  "leads:view": "ALL", "leads:create": "ALL", "leads:edit": "ALL", "leads:delete": "ALL", "leads:updateStatus": "ALL",
  "matters:view": "ALL", "matters:create": "ALL", "matters:edit": "ALL", "matters:delete": "ALL", "matters:assign": "ALL",
  "tasks:view": "ALL", "tasks:create": "ALL", "tasks:edit": "ALL", "tasks:delete": "ALL", "tasks:assign": "ALL",
  "actions:view": "ALL", "actions:create": "ALL", "actions:edit": "ALL", "actions:delete": "ALL",
  "notes:view": "ALL", "notes:create": "ALL", "notes:delete": "ALL",
  "companies:create": "ALL", "companies:edit": "ALL",
  "analytics:view": "ALL",
  "payments:view": "ALL",
  "financial:view": "ALL",
  "financialReports:view": "ALL", "financialReports:export": "ALL",
  "rates:view": "ALL",
  "audit:view": "ALL",
  "ai:use": "ALL",
};

// lawyer (Phase-1): like partner but NO matters:assign, NO payments/financial/audit.
const LEGACY_LAWYER: RolePolicy = {
  "dashboard:view": "ALL",
  "clients:view": "ALL", "clients:create": "ALL", "clients:edit": "ALL", "clients:delete": "ALL",
  "leads:view": "ALL", "leads:create": "ALL", "leads:edit": "ALL", "leads:delete": "ALL", "leads:updateStatus": "ALL",
  "matters:view": "ALL", "matters:create": "ALL", "matters:edit": "ALL", "matters:delete": "ALL",
  "tasks:view": "ALL", "tasks:create": "ALL", "tasks:edit": "ALL", "tasks:delete": "ALL", "tasks:assign": "ALL",
  "actions:view": "ALL", "actions:create": "ALL", "actions:edit": "ALL", "actions:delete": "ALL",
  "notes:view": "ALL", "notes:create": "ALL", "notes:delete": "ALL",
  "companies:create": "ALL", "companies:edit": "ALL",
  "analytics:view": "ALL",
  "ai:use": "ALL",
};

// finance (Phase-1): clients/matters view, notes view, financial manage, payments
// view+manage, analytics, ai. NO tasks, NO leads.
const LEGACY_FINANCE: RolePolicy = {
  "dashboard:view": "ALL",
  "clients:view": "ALL",
  "matters:view": "ALL",
  "notes:view": "ALL",
  "financial:view": "ALL", "financial:create": "ALL", "financial:edit": "ALL", "financial:delete": "ALL",
  "financialReports:view": "ALL", "financialReports:export": "ALL",
  "rates:view": "ALL", "rates:create": "ALL", "rates:edit": "ALL", "rates:delete": "ALL",
  "payments:view": "ALL", "payments:create": "ALL", "payments:edit": "ALL",
  "analytics:view": "ALL",
  "ai:use": "ALL",
};

// staff (Phase-1): clients/leads/tasks/actions manage, notes manage. NO matters,
// NO financial/payments/audit/ai.
const LEGACY_STAFF: RolePolicy = {
  "dashboard:view": "ALL",
  "clients:view": "ALL", "clients:create": "ALL", "clients:edit": "ALL", "clients:delete": "ALL",
  "leads:view": "ALL", "leads:create": "ALL", "leads:edit": "ALL", "leads:delete": "ALL", "leads:updateStatus": "ALL",
  "tasks:view": "ALL", "tasks:create": "ALL", "tasks:edit": "ALL", "tasks:delete": "ALL", "tasks:assign": "ALL",
  "actions:view": "ALL", "actions:create": "ALL", "actions:edit": "ALL", "actions:delete": "ALL",
  "notes:view": "ALL", "notes:create": "ALL", "notes:delete": "ALL",
  "companies:create": "ALL", "companies:edit": "ALL",
  "analytics:view": "ALL",
};

const LEGACY_VIEWER: RolePolicy = {
  "dashboard:view": "ALL",
  "clients:view": "ALL",
  "analytics:view": "ALL",
};

export const LEGACY_POLICY: Record<LegacyRole, RolePolicy> = {
  admin: fullAccess(),
  manager: LEGACY_MANAGER,
  partner: LEGACY_PARTNER,
  lawyer: LEGACY_LAWYER,
  finance: LEGACY_FINANCE,
  staff: LEGACY_STAFF,
  viewer: LEGACY_VIEWER,
};

// ─── TARGET_POLICY (approved spec v1.1 — inert until account migration) ────────

// Manager: firm-wide READ-ONLY oversight (BR-08 — "views everything: clients,
// matters, financial records, tasks, reports — with no create/edit rights").
// BR-08's "views everything" rule takes PRECEDENCE over the permission matrix's
// silence on modules it does not enumerate: a read-only overseer still sees Payment
// Tracker and Notes, so `payments:view` and `notes:view` are granted (VIEW only),
// even though those modules have no dedicated matrix row. `rates:view` likewise
// mirrors `financial:view`. Manager holds NO create/edit/delete/assign/manage
// capability anywhere — the read grants below are the whole of its authority.
const TARGET_MANAGER: RolePolicy = {
  "dashboard:view": "ALL",
  "clients:view": "ALL",
  "leads:view": "ALL",
  "matters:view": "ALL",
  "tasks:view": "ALL",
  "financial:view": "ALL",
  "financialReports:view": "ALL",
  "rates:view": "ALL",
  "payments:view": "ALL",
  "notes:view": "ALL",
  "audit:view": "ALL",
  "analytics:view": "ALL",
};

// Head of Practice: views all; creates/edits within OWN_PRACTICE; sees & assigns
// all tasks; views financial reports (BR-14).
//   - `matters:assign` (designate the Lead Lawyer) has no explicit cell in the
//     approved matrix; retained at OWN_PRACTICE by decision — every matter reports
//     to a Head of Practice (BR-01) and a migrated Partner holds this today.
//   - `tasks:create` is an implementation capability the matrix does not list as a
//     distinct row (it names task view/update + assign only); granted to the ALL-
//     scope task managers (Admin, HoP). Other roles fail closed on create — least
//     privilege — since the source is silent.
const TARGET_HEAD_OF_PRACTICE: RolePolicy = {
  "dashboard:view": "ALL", "audit:view": "ALL", "analytics:view": "ALL",
  "clients:view": "ALL", "clients:create": "OWN_PRACTICE", "clients:edit": "OWN_PRACTICE",
  "leads:view": "ALL",
  "matters:view": "ALL", "matters:create": "OWN_PRACTICE", "matters:edit": "OWN_PRACTICE", "matters:assign": "OWN_PRACTICE",
  "financial:view": "ALL", "financial:create": "OWN_PRACTICE", "financial:edit": "OWN_PRACTICE",
  "financialReports:view": "ALL",
  "rates:view": "ALL", "rates:create": "OWN_PRACTICE", "rates:edit": "OWN_PRACTICE",
  "tasks:view": "ALL", "tasks:edit": "ALL", "tasks:create": "ALL", "tasks:assign": "ALL",
};

// Senior Associate: assigned-matter scope; may VIEW (never edit) financials of
// assigned matters (BR-04/05); own tasks; may assign tasks (BR-10).
const TARGET_SENIOR_ASSOCIATE: RolePolicy = {
  "dashboard:view": "ASSIGNED", "audit:view": "ASSIGNED", "analytics:view": "ASSIGNED",
  "clients:view": "ASSIGNED",
  "matters:view": "ASSIGNED", "matters:edit": "ASSIGNED",
  "financial:view": "ASSIGNED",
  "rates:view": "ASSIGNED",
  "tasks:view": "OWN", "tasks:edit": "OWN", "tasks:assign": "OWN",
};

// Executive Associate: assigned-matter scope, NO financial visibility (BR-05),
// own tasks, may assign (BR-10).
const TARGET_EXECUTIVE_ASSOCIATE: RolePolicy = {
  "dashboard:view": "ASSIGNED", "audit:view": "ASSIGNED", "analytics:view": "ASSIGNED",
  "clients:view": "ASSIGNED",
  "matters:view": "ASSIGNED", "matters:edit": "ASSIGNED",
  "tasks:view": "OWN", "tasks:edit": "OWN", "tasks:assign": "OWN",
};

// Associate / Junior Lawyer / Trainee share one profile: assigned-matter scope,
// NO financial, own tasks, may NOT assign (BR-10).
const TARGET_ASSOCIATE_TIER: RolePolicy = {
  "dashboard:view": "ASSIGNED", "audit:view": "ASSIGNED", "analytics:view": "ASSIGNED",
  "clients:view": "ASSIGNED",
  "matters:view": "ASSIGNED", "matters:edit": "ASSIGNED",
  "tasks:view": "OWN", "tasks:edit": "OWN",
};

// Paralegal: views & edits ALL clients/matters (no create), NO financial, own
// tasks only, no assign (BR-11).
const TARGET_PARALEGAL: RolePolicy = {
  "dashboard:view": "ALL", "audit:view": "ALL", "analytics:view": "ALL",
  "clients:view": "ALL", "clients:edit": "ALL",
  "matters:view": "ALL", "matters:edit": "ALL",
  "tasks:view": "OWN", "tasks:edit": "OWN",
};

// Finance: full clients/matters (create+edit, no delete) and full financial
// (incl. delete); views reports; manages own tasks (BR-12).
const TARGET_FINANCE: RolePolicy = {
  "dashboard:view": "ALL", "audit:view": "ALL", "analytics:view": "ALL",
  "clients:view": "ALL", "clients:create": "ALL", "clients:edit": "ALL",
  "matters:view": "ALL", "matters:create": "ALL", "matters:edit": "ALL",
  "financial:view": "ALL", "financial:create": "ALL", "financial:edit": "ALL", "financial:delete": "ALL",
  "financialReports:view": "ALL", "financialReports:export": "ALL",
  "rates:view": "ALL", "rates:create": "ALL", "rates:edit": "ALL", "rates:delete": "ALL",
  "tasks:view": "OWN", "tasks:edit": "OWN",
};

// Coordinator: registry-scoped clients + intake (Enquiries Log manage); full
// matters; follows & assigns all tasks; financial VIEW ONLY (BR-07/13/15).
const TARGET_COORDINATOR: RolePolicy = {
  "dashboard:view": "REGISTRY", "audit:view": "REGISTRY", "analytics:view": "REGISTRY",
  "clients:view": "REGISTRY", "clients:create": "REGISTRY", "clients:edit": "REGISTRY",
  "leads:view": "ALL", "leads:create": "ALL", "leads:edit": "ALL", "leads:updateStatus": "ALL",
  "matters:view": "ALL", "matters:create": "ALL", "matters:edit": "ALL",
  "financial:view": "ALL", // read-only: no financial:create/edit
  "tasks:view": "ALL", "tasks:edit": "ALL", "tasks:assign": "ALL",
};

/**
 * Target account roles ONLY (Lead Lawyer excluded — it is an overlay, overlay.ts).
 * `authorize` consults this map when a live account has been migrated to a
 * target-only role; in the current legacy era it is exercised only by tests.
 */
export type TargetAccountRole = Exclude<TargetRole, "lead_lawyer">;

export const TARGET_POLICY: Record<TargetAccountRole, RolePolicy> = {
  admin: fullAccess(),
  manager: TARGET_MANAGER,
  head_of_practice: TARGET_HEAD_OF_PRACTICE,
  senior_associate: TARGET_SENIOR_ASSOCIATE,
  executive_associate: TARGET_EXECUTIVE_ASSOCIATE,
  associate: TARGET_ASSOCIATE_TIER,
  junior_lawyer: TARGET_ASSOCIATE_TIER,
  trainee: TARGET_ASSOCIATE_TIER,
  paralegal: TARGET_PARALEGAL,
  finance: TARGET_FINANCE,
  coordinator: TARGET_COORDINATOR,
};

/**
 * Capabilities not yet granted to any target role in this phase — MUTATION and
 * ancillary capabilities the approved matrix does not enumerate, which fail closed
 * for target roles until a later phase resolves them with the business owner.
 * NOTE: `payments:view` and `notes:view` are intentionally NOT here — BR-08's
 * read-only overseer (Manager) sees those modules, so their VIEW grant is live
 * (their create/edit/delete remain deferred). Documented so the gap is explicit.
 */
export const DEFERRED_TARGET_CAPABILITIES: readonly KnownCapability[] = [
  "payments:create", "payments:edit",
  "notes:create", "notes:delete",
  "companies:create", "companies:edit",
  "actions:view", "actions:create", "actions:edit", "actions:delete",
  "ai:use",
];
