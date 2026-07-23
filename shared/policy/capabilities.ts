/**
 * Typed capability taxonomy — Resource × Operation.
 *
 * Replaces the ambiguous `:manage` bundle with explicit operations so a role can
 * be granted, e.g., view without create, or edit without delete. The set is
 * CLOSED: `isCapability` accepts only members of CAPABILITIES, and unknown
 * capabilities fail closed in `authorize` (see authorize.ts).
 *
 * Not every Resource×Operation pair is a real capability — only the pairs listed
 * in CAPABILITIES exist. The template-literal `Capability` type is a convenience
 * upper bound; membership is the source of truth.
 */

export const RESOURCES = [
  "dashboard",
  "clients",
  "leads", // Enquiries Log (the leads/enquiries table), distinct from the client registry
  "matters",
  "tasks",
  "financial",
  "financialReports",
  "rates", // matter lawyer rates — a financial sub-resource
  "notes",
  "companies",
  "actions", // client action log
  "payments",
  "audit", // audit log + firm-wide activity feed + per-user activity stats
  "analytics",
  "users",
  "settings",
  "ai",
] as const;
export type Resource = (typeof RESOURCES)[number];

export const OPERATIONS = [
  "view",
  "create",
  "edit",
  "delete",
  "assign", // assign a task / designate a lead lawyer — a distinct privilege
  "updateStatus",
  "export",
  "use", // non-CRUD action capability (e.g. ai:use)
  "manage", // coarse admin bundle (users, settings) — intentionally kept coarse
] as const;
export type Operation = (typeof OPERATIONS)[number];

export type Capability = `${Resource}:${Operation}`;

/**
 * The closed set of real capabilities. Grouped by resource for readability.
 * Anything not here is not a capability — `authorize` fails closed on it.
 */
export const CAPABILITIES = [
  // Dashboard & cross-cutting reads
  "dashboard:view",
  "analytics:view",
  "audit:view",

  // Client registry
  "clients:view",
  "clients:create",
  "clients:edit",
  "clients:delete",

  // Enquiries Log (leads table)
  "leads:view",
  "leads:create",
  "leads:edit",
  "leads:delete",

  // Matters
  "matters:view",
  "matters:create",
  "matters:edit",
  "matters:delete",
  "matters:assign", // designate / reassign the Lead Lawyer

  // Tasks
  "tasks:view",
  "tasks:create",
  "tasks:edit",
  "tasks:delete",
  "tasks:assign", // assign a task to another user

  // Financial records + reports + rates
  "financial:view",
  "financial:create",
  "financial:edit",
  "financial:delete",
  "financialReports:view",
  "financialReports:export",
  "rates:view",
  "rates:create",
  "rates:edit",
  "rates:delete",

  // Payments (Payment Tracker)
  "payments:view",
  "payments:create",
  "payments:edit",

  // Notes / companies / action log
  "notes:view",
  "notes:create",
  "notes:delete",
  "companies:create",
  "companies:edit",
  "actions:view",
  "actions:create",
  "actions:edit",
  "actions:delete",

  // Chat submissions status
  "leads:updateStatus",

  // Administration
  "users:manage",
  "settings:manage",

  // AI assistant
  "ai:use",
] as const satisfies readonly Capability[];

export type KnownCapability = (typeof CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES);

export function isCapability(v: unknown): v is KnownCapability {
  return typeof v === "string" && CAPABILITY_SET.has(v);
}
