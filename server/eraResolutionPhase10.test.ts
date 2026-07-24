/**
 * Migration 0026 — explicit legacy/target policy-era resolution.
 *
 * Pure policy tests. Every actor supplies an era explicitly; missing/invalid era
 * is tested separately and must fail closed.
 */
import { describe, expect, it } from "vitest";
import {
  authorize,
  CAPABILITIES,
  LEGACY_POLICY,
  TARGET_POLICY,
  policyForRole,
  resolveAuthorizationTransition,
  type PolicyEra,
} from "@shared/policy";

const actor = (role: string, authorizationModel: PolicyEra) => ({
  id: 1,
  role,
  authorizationModel,
  status: "active" as const,
});

const LEGACY_ONLY = ["partner", "lawyer", "staff", "viewer"] as const;
const TARGET_ONLY = [
  "head_of_practice",
  "senior_associate",
  "executive_associate",
  "associate",
  "junior_lawyer",
  "trainee",
  "paralegal",
  "coordinator",
] as const;

describe("shared role names resolve by the explicit account era", () => {
  for (const role of ["admin", "manager", "finance"] as const) {
    it(`${role}: legacy and target select their respective matrices`, () => {
      for (const cap of CAPABILITIES) {
        const legacy = authorize(actor(role, "legacy"), cap);
        const target = authorize(actor(role, "target"), cap);
        expect(legacy.scope).toBe(LEGACY_POLICY[role][cap] ?? "NONE");
        expect(target.scope).toBe(TARGET_POLICY[role][cap] ?? "NONE");
      }
    });
  }
});

describe("role/era compatibility truth table", () => {
  it("legacy-only roles work only in legacy", () => {
    for (const role of LEGACY_ONLY) {
      expect(policyForRole(role, "legacy")).toBe(LEGACY_POLICY[role]);
      expect(policyForRole(role, "target")).toBeNull();
    }
  });

  it("target-only roles work only in target", () => {
    for (const role of TARGET_ONLY) {
      expect(policyForRole(role, "target")).toBe(TARGET_POLICY[role]);
      expect(policyForRole(role, "legacy")).toBeNull();
    }
  });

  it("Lead Lawyer and unknown roles are never base identities", () => {
    expect(policyForRole("lead_lawyer", "target")).toBeNull();
    expect(policyForRole("wizard", "legacy")).toBeNull();
    expect(policyForRole("wizard", "target")).toBeNull();
  });

  it("missing and invalid era deny before policy lookup", () => {
    for (const authorizationModel of [undefined, null, "", "future"]) {
      expect(authorize({
        id: 1,
        role: "admin",
        authorizationModel,
        status: "active",
      }, "clients:view")).toMatchObject({
        allowed: false,
        scope: "NONE",
        reason: "NO_ERA",
      });
    }
  });
});

describe("approved audited transition mapping", () => {
  it("supports shared-name activation and deterministic renames", () => {
    expect(resolveAuthorizationTransition(
      { role: "finance", authorizationModel: "legacy" },
      "finance",
      true,
    )).toEqual({ role: "finance", authorizationModel: "target" });
    expect(resolveAuthorizationTransition(
      { role: "partner", authorizationModel: "legacy" },
      "head_of_practice",
    )).toEqual({ role: "head_of_practice", authorizationModel: "target" });
    expect(resolveAuthorizationTransition(
      { role: "staff", authorizationModel: "legacy" },
      "coordinator",
    )).toEqual({ role: "coordinator", authorizationModel: "target" });
  });

  it("requires a Lawyer grade and blocks Viewer", () => {
    expect(resolveAuthorizationTransition(
      { role: "lawyer", authorizationModel: "legacy" },
      "senior_associate",
    )).toEqual({ role: "senior_associate", authorizationModel: "target" });
    expect(resolveAuthorizationTransition(
      { role: "lawyer", authorizationModel: "legacy" },
      "finance",
    )).toBeNull();
    expect(resolveAuthorizationTransition(
      { role: "viewer", authorizationModel: "legacy" },
      "paralegal",
    )).toBeNull();
  });

  it("never permits target-to-legacy rollback", () => {
    expect(resolveAuthorizationTransition(
      { role: "associate", authorizationModel: "target" },
      "lawyer",
    )).toBeNull();
  });
});
