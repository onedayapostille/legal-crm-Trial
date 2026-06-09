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

export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  admin: ["*"],
  manager: [
    "dashboard:view",
    "clients:view", "clients:manage",
    "leads:manage",
    "matters:view", "matters:manage",
    "tasks:manage",
    "analytics:view",
    "payments:view",
    "financial:view",
    "actions:manage",
  ],
  partner: [
    "dashboard:view",
    "clients:manage",
    "leads:manage",
    "matters:manage",
    "matters:assign_lawyer",
    "tasks:manage",
    "analytics:view",
    "payments:view",
    "financial:view",
    "actions:manage",
  ],
  lawyer: [
    "dashboard:view",
    "clients:manage",
    "leads:manage",
    "matters:manage",
    "tasks:manage",
    "analytics:view",
    "actions:manage",
  ],
  finance: [
    "dashboard:view",
    "clients:view",
    "matters:view",
    "financial:manage",
    "payments:view",
    "analytics:view",
  ],
  staff: [
    "dashboard:view",
    "clients:manage",
    "leads:manage",
    "tasks:manage",
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
