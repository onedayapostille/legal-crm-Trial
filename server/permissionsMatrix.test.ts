import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ROLES,
  CAPABILITIES,
  LEAD_LAWYER_ELIGIBLE_ROLES,
  can,
  scopeFor,
  isLeadLawyerEligible,
  leadLawyerOverlayApplies,
  clientEditLimitedToExistingClients,
  type AccountRole,
  type Capability,
  type Scope,
} from "../shared/permissions";

/**
 * Matrix-driven role/capability tests (pure — no DB).
 *
 * EXPECTED is transcribed from the approved AGP Roles & Permissions
 * Specification v1.1 (BR-01..BR-15 + the Excel capability matrix). If the
 * policy in shared/permissions.ts drifts from the approved matrix, these
 * tests fail row by row.
 */

const EXPECTED: Record<Capability, Partial<Record<AccountRole, Scope>>> = {
  "clients.view": {
    admin: "ALL", manager: "ALL", head_of_practice: "ALL",
    senior_associate: "ASSIGNED", executive_associate: "ASSIGNED",
    associate: "ASSIGNED", junior_lawyer: "ASSIGNED", trainee: "ASSIGNED",
    paralegal: "ALL", finance: "ALL", coordinator: "REGISTRY",
  },
  "clients.create": {
    admin: "ALL", head_of_practice: "OWN_PRACTICE", finance: "ALL", coordinator: "REGISTRY",
  },
  "clients.edit": {
    admin: "ALL", head_of_practice: "OWN_PRACTICE", paralegal: "ALL",
    finance: "ALL", coordinator: "REGISTRY",
  },
  "clients.delete": { admin: "ALL" },
  "matters.view": {
    admin: "ALL", manager: "ALL", head_of_practice: "ALL",
    senior_associate: "ASSIGNED", executive_associate: "ASSIGNED",
    associate: "ASSIGNED", junior_lawyer: "ASSIGNED", trainee: "ASSIGNED",
    paralegal: "ALL", finance: "ALL", coordinator: "ALL",
  },
  "matters.create": {
    admin: "ALL", head_of_practice: "OWN_PRACTICE", finance: "ALL", coordinator: "ALL",
  },
  "matters.edit": {
    admin: "ALL", head_of_practice: "OWN_PRACTICE",
    senior_associate: "ASSIGNED", executive_associate: "ASSIGNED",
    associate: "ASSIGNED", junior_lawyer: "ASSIGNED", trainee: "ASSIGNED",
    paralegal: "ALL", finance: "ALL", coordinator: "ALL",
  },
  "matters.assignTeam": { admin: "ALL", head_of_practice: "OWN_PRACTICE" },
  "matters.delete": { admin: "ALL" },
  "financial.view": {
    admin: "ALL", manager: "ALL", head_of_practice: "ALL",
    senior_associate: "ASSIGNED", finance: "ALL", coordinator: "ALL",
  },
  "financial.create": { admin: "ALL", head_of_practice: "OWN_PRACTICE", finance: "ALL" },
  "financial.edit": { admin: "ALL", head_of_practice: "OWN_PRACTICE", finance: "ALL" },
  "financial.delete": { admin: "ALL", finance: "ALL" },
  "financialReports.view": { admin: "ALL", manager: "ALL", head_of_practice: "ALL", finance: "ALL" },
  "enquiries.view": { admin: "ALL", manager: "ALL", head_of_practice: "ALL", coordinator: "ALL" },
  "enquiries.manage": { admin: "ALL", coordinator: "ALL" },
  "enquiries.delete": { admin: "ALL" },
  "tasks.view": {
    admin: "ALL", manager: "ALL", head_of_practice: "ALL",
    senior_associate: "OWN", executive_associate: "OWN", associate: "OWN",
    junior_lawyer: "OWN", trainee: "OWN", paralegal: "OWN", finance: "OWN",
    coordinator: "ALL",
  },
  "tasks.update": {
    admin: "ALL", head_of_practice: "ALL",
    senior_associate: "OWN", executive_associate: "OWN", associate: "OWN",
    junior_lawyer: "OWN", trainee: "OWN", paralegal: "OWN", finance: "OWN",
    coordinator: "ALL",
  },
  "tasks.assign": {
    admin: "ALL", head_of_practice: "ALL", senior_associate: "ALL",
    executive_associate: "ALL", coordinator: "ALL",
  },
  "tasks.delete": { admin: "ALL" },
  "dashboard.view": {
    admin: "ALL", manager: "ALL", head_of_practice: "ALL",
    senior_associate: "ASSIGNED", executive_associate: "ASSIGNED",
    associate: "ASSIGNED", junior_lawyer: "ASSIGNED", trainee: "ASSIGNED",
    paralegal: "ALL", finance: "ALL", coordinator: "REGISTRY",
  },
  "users.manage": { admin: "ALL" },
  "settings.manage": { admin: "ALL" },
  "ai.use": {
    admin: "ALL", manager: "ALL", head_of_practice: "ALL",
    senior_associate: "ASSIGNED", executive_associate: "ASSIGNED",
    associate: "ASSIGNED", junior_lawyer: "ASSIGNED", trainee: "ASSIGNED",
    finance: "ALL",
  },
  "import.clients": { admin: "ALL", finance: "ALL" },
};

describe("Permission matrix (all 11 persistent roles × every capability)", () => {
  for (const capability of CAPABILITIES) {
    for (const role of ACCOUNT_ROLES) {
      const expected: Scope = EXPECTED[capability]?.[role] ?? "NONE";
      it(`${role} × ${capability} → ${expected}`, () => {
        expect(scopeFor(role, capability)).toBe(expected);
        expect(can(role, capability)).toBe(expected !== "NONE");
      });
    }
  }
});

describe("Manager is strictly read-only (BR-08)", () => {
  const mutationCapabilities: Capability[] = [
    "clients.create", "clients.edit", "clients.delete",
    "matters.create", "matters.edit", "matters.assignTeam", "matters.delete",
    "financial.create", "financial.edit", "financial.delete",
    "enquiries.manage", "enquiries.delete",
    "tasks.update", "tasks.assign", "tasks.delete",
    "users.manage", "settings.manage", "import.clients",
  ];
  it.each(mutationCapabilities)("manager lacks %s", capability => {
    expect(can("manager", capability)).toBe(false);
  });
  it("manager keeps read access everywhere", () => {
    for (const cap of [
      "clients.view", "matters.view", "financial.view",
      "financialReports.view", "enquiries.view", "tasks.view", "dashboard.view",
    ] as Capability[]) {
      expect(scopeFor("manager", cap)).toBe("ALL");
    }
  });
});

describe("Legacy role aliasing (retained enum values)", () => {
  it("partner behaves as head_of_practice (approved mapping)", () => {
    for (const cap of CAPABILITIES) {
      expect(scopeFor("partner", cap)).toBe(scopeFor("head_of_practice", cap));
    }
  });
  it("staff behaves as coordinator (approved mapping)", () => {
    for (const cap of CAPABILITIES) {
      expect(scopeFor("staff", cap)).toBe(scopeFor("coordinator", cap));
    }
  });
  it("legacy lawyer gets the least-privilege associate baseline (no auto grade)", () => {
    expect(scopeFor("lawyer", "matters.view")).toBe("ASSIGNED");
    expect(scopeFor("lawyer", "matters.edit")).toBe("ASSIGNED");
    expect(scopeFor("lawyer", "financial.view")).toBe("NONE");
    expect(scopeFor("lawyer", "tasks.assign")).toBe("NONE");
    expect(scopeFor("lawyer", "enquiries.manage")).toBe("NONE");
  });
  it("legacy viewer has no capabilities (not part of the approved role set)", () => {
    for (const cap of CAPABILITIES) {
      expect(can("viewer", cap)).toBe(false);
    }
  });
  it("unknown/absent roles have no capabilities", () => {
    for (const role of [null, undefined, "", "lead_lawyer", "superuser"]) {
      expect(can(role as any, "clients.view")).toBe(false);
    }
  });
});

describe("Lead Lawyer designation eligibility (documented spec conflict)", () => {
  it("lead_lawyer is NOT an account role", () => {
    expect((ACCOUNT_ROLES as readonly string[]).includes("lead_lawyer")).toBe(false);
  });
  it("Trainee is NOT eligible (Excel Position Mapping omits Trainee — least privilege)", () => {
    expect(isLeadLawyerEligible("trainee")).toBe(false);
    expect(leadLawyerOverlayApplies("trainee")).toBe(false);
  });
  it("eligible grades match the Excel Position Mapping (+ legacy partner/lawyer)", () => {
    expect([...LEAD_LAWYER_ELIGIBLE_ROLES].sort()).toEqual(
      [
        "head_of_practice", "senior_associate", "executive_associate",
        "associate", "junior_lawyer", "partner", "lawyer",
      ].sort(),
    );
  });
  it("non-lawyer roles are never overlay-eligible", () => {
    for (const role of ["manager", "paralegal", "finance", "coordinator", "admin", "viewer", "staff"]) {
      expect(leadLawyerOverlayApplies(role)).toBe(false);
    }
  });
});

describe("Paralegal least-privilege client editing", () => {
  it("only paralegal is limited to Existing Client records", () => {
    expect(clientEditLimitedToExistingClients("paralegal")).toBe(true);
    for (const role of ACCOUNT_ROLES.filter(r => r !== "paralegal")) {
      expect(clientEditLimitedToExistingClients(role)).toBe(false);
    }
  });
});
