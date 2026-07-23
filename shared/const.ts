export const COOKIE_NAME = "crm_session";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

export const USER_ROLES = ["admin", "manager", "partner", "lawyer", "finance", "staff", "viewer"] as const;
export const USER_STATUSES = ["active", "inactive", "suspended"] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin",
  manager: "Manager",
  partner: "Partner",
  lawyer: "Lawyer",
  finance: "Finance",
  staff: "Staff",
  viewer: "Viewer",
};

// Capability model: ":view" grants read-only access; ":manage" grants mutation
// AND implies the matching ":view" (see hasPermission). Read gates on routes use
// ":view" strings so a role can be granted visibility without write access.
// Manager is firm-wide READ-ONLY: every string it holds is a ":view" grant —
// the server rejects all Manager mutations with FORBIDDEN.
export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  admin: ["*"],
  manager: [
    "dashboard:view",
    "clients:view",
    "leads:view",
    "matters:view",
    "tasks:view",
    "actions:view",
    "notes:view",
    "analytics:view",
    "payments:view",
    "financial:view",
    "audit:view",
    "ai:assistant",
  ],
  partner: [
    "dashboard:view",
    "clients:manage",
    "leads:manage",
    "matters:manage",
    "matters:assign_lawyer",
    "tasks:manage",
    "notes:manage",
    "analytics:view",
    "payments:view",
    "financial:view",
    "audit:view",
    "actions:manage",
    "ai:assistant",
  ],
  lawyer: [
    "dashboard:view",
    "clients:manage",
    "leads:manage",
    "matters:manage",
    "tasks:manage",
    "notes:manage",
    "analytics:view",
    "actions:manage",
    "ai:assistant",
  ],
  finance: [
    "dashboard:view",
    "clients:view",
    "matters:view",
    "notes:view",
    "financial:manage",
    "payments:view",
    "payments:manage",
    "analytics:view",
    "ai:assistant",
  ],
  staff: [
    "dashboard:view",
    "clients:manage",
    "leads:manage",
    "tasks:manage",
    "notes:manage",
    "analytics:view",
    "actions:manage",
  ],
  viewer: ["dashboard:view", "clients:view", "analytics:view"],
};

// ─── Communication Channel (two-level: type → medium) ────────────────────────
export const CHANNEL_TYPES = [
  "Digital Channels",
  "Referral",
  "Walk-in",
  "Event / Conference",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

// Level-2 mediums when channel_type = "Digital Channels".
export const DIGITAL_MEDIUMS = ["LinkedIn", "Email", "Phone", "WhatsApp", "Website"] as const;

/** channel_medium is required only for Digital Channels and Referral. */
export function channelMediumRequired(type: string | null | undefined): boolean {
  return type === "Digital Channels" || type === "Referral";
}

/** Label for the medium field given the channel type (or null if no field). */
export function channelMediumLabel(type: string | null | undefined): string | null {
  switch (type) {
    case "Digital Channels": return "Medium";
    case "Referral":         return "Referral Name";
    case "Event / Conference": return "Event Name";
    default:                 return null; // Walk-in → no medium field
  }
}

// ─── Matter Type (client_matters.matter_type) ────────────────────────────────
// The single source of truth for supported Matter Type values. Stored value ==
// display label ("Litigation" / "Corporate") because ALL existing rows, the
// client-level matter_type enum, seeds, and tests already use these capitalized
// values — introducing lowercase variants would create mixed historical data.
// The column stays varchar: legacy values on old matters remain readable and
// are preserved on edit unless the user explicitly picks a supported value
// (change-only validation server-side).
export const MATTER_TYPES = ["Litigation", "Corporate"] as const;
export type MatterType = (typeof MATTER_TYPES)[number];

export function isSupportedMatterType(v: string | null | undefined): v is MatterType {
  return typeof v === "string" && (MATTER_TYPES as readonly string[]).includes(v);
}

export const DISCOUNT_APPROVAL_VALUES = ["N/A", "P&L Head Lawyers", "CEO", "Board"] as const;
export type DiscountApproval = (typeof DISCOUNT_APPROVAL_VALUES)[number];

export const DISCOUNT_RATES: Record<DiscountApproval, number> = {
  "N/A": 0,
  "P&L Head Lawyers": 5,
  "CEO": 10,
  "Board": 15,
};

export function hasPermission(role: UserRole | string | null | undefined, permission: string) {
  if (!role || !(role in ROLE_PERMISSIONS)) return false;
  const permissions = ROLE_PERMISSIONS[role as UserRole];
  if (permissions.includes("*") || permissions.includes(permission)) return true;
  // :manage implies :view for the same resource
  if (permission.endsWith(":view")) {
    const manageVariant = permission.replace(":view", ":manage");
    return permissions.includes(manageVariant);
  }
  return false;
}
