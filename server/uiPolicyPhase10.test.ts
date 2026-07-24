/**
 * Phase 10 — the client UI authorization metadata, locked to the server policy.
 *
 * The frontend gates routes, sidebar entries and mutation controls with the SAME
 * pure policy engine the server enforces with. These tests prove that the client
 * helpers (`userCan`, `isActiveSession`) and the route→capability map agree with
 * `authorize()`, that only the 11 approved roles are offered for assignment, and
 * that inactive sessions and legacy roles behave correctly. Pure — no DOM, no DB.
 *
 * (Component-render tests are intentionally NOT here: adding a jsdom/testing-lib
 * harness is a dependency change, out of scope. Server-side enforcement is proven
 * by the router integration suites; the UI is advisory and validated here.)
 */
import { describe, expect, it } from "vitest";
import {
  userCan, isActiveSession, isPaymentStatusOnly, ROUTE_CAPABILITIES,
  assignableRoleOptions,
} from "@/lib/permissions";
import {
  authorize, isCapability, APPROVED_ACCOUNT_ROLES, ACCOUNT_ROLE_LABELS,
  ACCOUNT_ROLE_VALUES, isLegacyOnlyAccountRole, TARGET_ROLES,
  type KnownCapability,
} from "@shared/policy";

const targetActive = (role: string) => ({
  id: 1, role, authorizationModel: "target" as const, status: "active" as const,
});
const legacyActive = (role: string) => ({
  id: 1, role, authorizationModel: "legacy" as const, status: "active" as const,
});

describe("route→capability map is valid and matches the server", () => {
  it("every ROUTE_CAPABILITIES value is a real server capability", () => {
    for (const [path, cap] of Object.entries(ROUTE_CAPABILITIES)) {
      expect(isCapability(cap), `${path} → ${cap}`).toBe(true);
    }
  });

  it("userCan mirrors authorize() for the mapped capability, per role", () => {
    const roles = ["admin", "manager", "head_of_practice", "senior_associate", "paralegal", "coordinator", "finance"];
    for (const role of roles) {
      for (const cap of Object.values(ROUTE_CAPABILITIES)) {
        expect(userCan(targetActive(role), cap as KnownCapability)).toBe(
          authorize(targetActive(role), cap).allowed,
        );
      }
    }
  });
});

describe("userCan — session gating", () => {
  it("no session and inactive/suspended sessions can do nothing", () => {
    expect(userCan(null, "clients:view")).toBe(false);
    expect(userCan(undefined, "dashboard:view")).toBe(false);
    expect(userCan({
      id: 1, role: "admin", authorizationModel: "target", status: "inactive",
    }, "clients:view")).toBe(false);
    expect(userCan({
      id: 1, role: "admin", authorizationModel: "target", status: "suspended",
    }, "dashboard:view")).toBe(false);
    expect(isActiveSession({
      id: 1, role: "admin", authorizationModel: "target", status: "inactive",
    })).toBe(false);
    expect(userCan({
      id: 1, role: "admin", authorizationModel: null, status: "active",
    }, "clients:view")).toBe(false);
    expect(isActiveSession(null)).toBe(false);
  });

  it("an active admin session is fully capable", () => {
    expect(isActiveSession(targetActive("admin"))).toBe(true);
    expect(userCan(targetActive("admin"), "users:manage")).toBe(true);
    expect(userCan(targetActive("admin"), "financial:delete")).toBe(true);
  });
});

describe("Manager is read-only in the UI (BR-08)", () => {
  it("sees view routes but no create/edit/delete/assign/manage capability", () => {
    expect(userCan(targetActive("manager"), "clients:view")).toBe(true);
    expect(userCan(targetActive("manager"), "financial:view")).toBe(true);
    for (const cap of ["clients:create", "matters:create", "financial:create", "tasks:create", "tasks:edit", "tasks:assign", "users:manage"] as const) {
      expect(userCan(targetActive("manager"), cap), cap).toBe(false);
    }
  });
});

describe("representative role UI gating", () => {
  it("Paralegal may edit clients/matters but not create them, and has no finance", () => {
    expect(userCan(targetActive("paralegal"), "clients:edit")).toBe(true);
    expect(userCan(targetActive("paralegal"), "clients:create")).toBe(false);
    expect(userCan(targetActive("paralegal"), "clients:delete")).toBe(false);
    expect(userCan(targetActive("paralegal"), "matters:delete")).toBe(false);
    expect(userCan(targetActive("paralegal"), "financial:view")).toBe(false);
  });
  it("Head of Practice edit authority never implies delete authority", () => {
    const hop = targetActive("head_of_practice");
    expect(userCan(hop, "matters:edit")).toBe(true);
    expect(userCan(hop, "matters:delete")).toBe(false);
    expect(userCan(hop, "financial:edit")).toBe(true);
    expect(userCan(hop, "financial:delete")).toBe(false);
    expect(userCan(hop, "rates:edit")).toBe(true);
    expect(userCan(hop, "rates:delete")).toBe(false);
    expect(userCan(hop, "tasks:edit")).toBe(true);
    expect(userCan(hop, "tasks:delete")).toBe(false);
  });
  it("Coordinator manages intake, sees financial (read-only), assigns tasks", () => {
    expect(userCan(targetActive("coordinator"), "leads:create")).toBe(true);
    expect(userCan(targetActive("coordinator"), "financial:view")).toBe(true);
    expect(userCan(targetActive("coordinator"), "financial:create")).toBe(false);
    expect(userCan(targetActive("coordinator"), "tasks:assign")).toBe(true);
    expect(isPaymentStatusOnly(targetActive("coordinator"))).toBe(true);
    expect(isPaymentStatusOnly(targetActive("finance"))).toBe(false);
  });
  it("only Admin sees the User Management route", () => {
    const cap = ROUTE_CAPABILITIES["/user-management"];
    expect(userCan(targetActive("admin"), cap)).toBe(true);
    for (const role of ["manager", "head_of_practice", "coordinator", "finance", "senior_associate"]) {
      expect(userCan(targetActive(role), cap), role).toBe(false);
    }
  });
});

describe("role dropdown offers only the 11 approved persistent roles", () => {
  it("is exactly the target roles minus the Lead Lawyer overlay", () => {
    expect(APPROVED_ACCOUNT_ROLES.length).toBe(11);
    expect([...APPROVED_ACCOUNT_ROLES].sort()).toEqual(
      TARGET_ROLES.filter(r => r !== "lead_lawyer").slice().sort(),
    );
    expect(APPROVED_ACCOUNT_ROLES).not.toContain("lead_lawyer");
  });
  it("excludes every legacy-only role from new assignment", () => {
    for (const legacy of ["partner", "lawyer", "staff", "viewer"]) {
      expect(APPROVED_ACCOUNT_ROLES as readonly string[]).not.toContain(legacy);
      expect(isLegacyOnlyAccountRole(legacy)).toBe(true);
    }
    for (const target of APPROVED_ACCOUNT_ROLES) {
      expect(isLegacyOnlyAccountRole(target)).toBe(false);
    }
  });
  it("every persistable account role has a display label (legacy shown for coexistence)", () => {
    for (const role of ACCOUNT_ROLE_VALUES) {
      expect(ACCOUNT_ROLE_LABELS[role], role).toBeTruthy();
    }
    expect(ACCOUNT_ROLE_LABELS.partner).toMatch(/legacy/i);
  });
});

describe("target account role options after the era discriminator", () => {
  it("a NEW account can be assigned target Finance but no legacy-only role", () => {
    const opts = assignableRoleOptions(); // no edit target = new account
    expect(opts).toContain("finance");
    for (const legacy of ["partner", "lawyer", "staff", "viewer"]) {
      expect(opts).not.toContain(legacy);
    }
    expect(opts).toContain("head_of_practice");
    expect(opts).toContain("coordinator");
    expect(opts.length).toBe(APPROVED_ACCOUNT_ROLES.length);
  });

  it("target accounts may be explicitly reassigned to target Finance", () => {
    expect(assignableRoleOptions("senior_associate")).toContain("finance");
    expect(assignableRoleOptions("coordinator")).toContain("finance");
  });

  it("an EXISTING Finance account still displays/keeps its role (coexistence)", () => {
    expect(assignableRoleOptions("finance")).toContain("finance");
  });

  it("an existing legacy account still displays/keeps its legacy role", () => {
    expect(assignableRoleOptions("partner")).toContain("partner");
    expect(assignableRoleOptions("lawyer")).toContain("lawyer");
  });
});

describe("legacy accounts keep working in the UI during coexistence", () => {
  it("a legacy Lawyer's UI gates reflect LEGACY policy, not a target grade", () => {
    // Legacy lawyer can create clients (legacy :manage) but has no financial view.
    expect(userCan(legacyActive("lawyer"), "clients:create")).toBe(true);
    expect(userCan(legacyActive("lawyer"), "financial:view")).toBe(false);
    // Not accidentally treated as a target senior/associate (those are OWN-scope, different).
    expect(userCan(legacyActive("lawyer"), "tasks:view")).toBe(true);
  });
});
