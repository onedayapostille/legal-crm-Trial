export const COOKIE_NAME = "crm_session";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

export const USER_ROLES = ["admin", "manager", "lawyer", "staff", "viewer"] as const;
export const USER_STATUSES = ["active", "inactive", "suspended"] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin",
  manager: "Manager",
  lawyer: "Lawyer",
  staff: "Staff",
  viewer: "Viewer",
};

export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  admin: ["*"],
  manager: [
    "dashboard:view",
    "leads:manage",
    "matters:manage",
    "tasks:manage",
    "analytics:view",
    "payments:view",
  ],
  lawyer: [
    "dashboard:view",
    "leads:manage",
    "matters:manage",
    "tasks:manage",
    "analytics:view",
  ],
  staff: ["dashboard:view", "leads:manage", "tasks:manage", "analytics:view"],
  viewer: ["dashboard:view", "analytics:view"],
};

export function hasPermission(role: UserRole | string | null | undefined, permission: string) {
  if (!role || !(role in ROLE_PERMISSIONS)) return false;
  const permissions = ROLE_PERMISSIONS[role as UserRole];
  return permissions.includes("*") || permissions.includes(permission);
}
