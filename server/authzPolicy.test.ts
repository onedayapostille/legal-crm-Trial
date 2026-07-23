/**
 * Phase 2 policy-engine unit tests — pure, no database.
 *
 * Exercises shared/policy directly: the typed capability set, the legacy/target
 * matrices, fail-closed behavior, scope resolution, the read-vs-mutate split,
 * Manager denial, the additive per-matter Lead Lawyer overlay, and the Phase-1
 * compatibility bridge (new policy must agree with old `hasPermission` for every
 * legacy role).
 */
import { describe, expect, it } from "vitest";
import {
  authorize, can, satisfiesLegacyPermission, legacyPermissionToCapabilities,
  CAPABILITIES, isCapability, DATA_SCOPES,
  LEGACY_ROLES, TARGET_ROLES, LEGACY_POLICY, TARGET_POLICY,
  matterOverlayGrants, isLeadLawyerOf, LEAD_LAWYER_OVERLAY_GRANTS,
  type Actor,
} from "../shared/policy";
import { ROLE_PERMISSIONS, hasPermission, USER_ROLES } from "../shared/const";

const actor = (role: string, id = 1): Actor => ({ id, role, status: "active" });

describe("capability & scope taxonomy", () => {
  it("capability set is closed and self-consistent", () => {
    expect(isCapability("clients:view")).toBe(true);
    expect(isCapability("clients:manage")).toBe(false); // legacy bundle is not a capability
    expect(isCapability("bogus:frobnicate")).toBe(false);
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length); // no duplicates
  });

  it("exposes the six required scopes", () => {
    expect([...DATA_SCOPES].sort()).toEqual(
      ["ALL", "ASSIGNED", "NONE", "OWN", "OWN_PRACTICE", "REGISTRY"],
    );
  });
});

describe("fail-closed behavior", () => {
  it("unknown role is denied with UNKNOWN_ROLE", () => {
    const d = authorize(actor("wizard"), "clients:view");
    expect(d.allowed).toBe(false);
    expect(d.scope).toBe("NONE");
    expect(d.reason).toBe("UNKNOWN_ROLE");
  });

  it("unknown capability is denied with UNKNOWN_CAPABILITY", () => {
    const d = authorize(actor("admin"), "clients:obliterate");
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("UNKNOWN_CAPABILITY");
  });

  it("missing/empty role and inactive status fail closed", () => {
    expect(authorize({ id: 1, role: null }, "clients:view").reason).toBe("UNKNOWN_ROLE");
    expect(authorize({ id: 1, role: "admin", status: "suspended" }, "clients:view").reason).toBe("INACTIVE");
  });
});

describe("every known role resolves", () => {
  it("legacy roles all produce a decision for a sample capability", () => {
    for (const r of LEGACY_ROLES) {
      const d = authorize(actor(r), "dashboard:view");
      expect(typeof d.allowed).toBe("boolean");
      expect(DATA_SCOPES).toContain(d.scope);
    }
  });
  it("target-only roles resolve via TARGET_POLICY", () => {
    for (const r of TARGET_ROLES) {
      if (r === "lead_lawyer") continue; // overlay, not a base role
      // admin/manager/finance are legacy-era names; the rest are target-only.
      const d = authorize(actor(r), "dashboard:view");
      expect(typeof d.allowed).toBe("boolean");
    }
  });
});

describe("admin is unrestricted", () => {
  it("admin holds every capability at scope ALL", () => {
    for (const c of CAPABILITIES) {
      const d = authorize(actor("admin"), c);
      expect(d.allowed).toBe(true);
      expect(d.scope).toBe("ALL");
    }
  });
});

describe("scope resolution (approved matrix)", () => {
  it("Head of Practice creates within OWN_PRACTICE but views ALL", () => {
    expect(authorize(actor("head_of_practice"), "clients:view").scope).toBe("ALL");
    expect(authorize(actor("head_of_practice"), "clients:create").scope).toBe("OWN_PRACTICE");
    expect(authorize(actor("head_of_practice"), "financial:create").scope).toBe("OWN_PRACTICE");
    expect(authorize(actor("head_of_practice"), "financialReports:view").scope).toBe("ALL"); // BR-14
  });

  it("Senior Associate views assigned-matter financials read-only (BR-04/05)", () => {
    expect(authorize(actor("senior_associate"), "financial:view").scope).toBe("ASSIGNED");
    expect(can(actor("senior_associate"), "financial:create")).toBe(false);
    expect(can(actor("senior_associate"), "financial:edit")).toBe(false);
  });

  it("Executive Associate and below have no financial visibility (BR-05)", () => {
    for (const r of ["executive_associate", "associate", "junior_lawyer", "trainee", "paralegal"]) {
      expect(can(actor(r), "financial:view")).toBe(false);
    }
  });

  it("Associate tier works OWN tasks and cannot assign (BR-10)", () => {
    expect(authorize(actor("associate"), "tasks:view").scope).toBe("OWN");
    expect(can(actor("associate"), "tasks:assign")).toBe(false);
    expect(can(actor("senior_associate"), "tasks:assign")).toBe(true); // may assign
  });

  it("Coordinator is registry-scoped on clients, full on matters, read-only financial", () => {
    expect(authorize(actor("coordinator"), "clients:view").scope).toBe("REGISTRY");
    expect(authorize(actor("coordinator"), "clients:create").scope).toBe("REGISTRY");
    expect(authorize(actor("coordinator"), "matters:create").scope).toBe("ALL");
    expect(authorize(actor("coordinator"), "financial:view").scope).toBe("ALL");
    expect(can(actor("coordinator"), "financial:create")).toBe(false); // BR-07 read-only
    expect(can(actor("coordinator"), "leads:create")).toBe(true); // manages enquiries (BR-15)
  });

  it("Paralegal edits all clients/matters but cannot create them (matrix)", () => {
    expect(authorize(actor("paralegal"), "clients:edit").scope).toBe("ALL");
    expect(can(actor("paralegal"), "clients:create")).toBe(false);
    expect(can(actor("paralegal"), "financial:view")).toBe(false);
  });
});

describe("no implicit mutation from view", () => {
  it("read-only roles never get create/edit/delete for a resource they can view", () => {
    // Manager (legacy era) and Paralegal both view clients; neither may delete.
    for (const r of ["manager", "paralegal", "senior_associate", "coordinator"]) {
      expect(can(actor(r), "clients:view") || r === "manager").toBe(true);
      expect(can(actor(r), "clients:delete")).toBe(false);
    }
  });
});

describe("Manager mutation denial (BR-08)", () => {
  const MUTATIONS = CAPABILITIES.filter(c =>
    /:(create|edit|delete|assign|updateStatus)$/.test(c) || c === "users:manage" || c === "settings:manage",
  );

  it("legacy Manager (live) is denied every mutation but keeps reads", () => {
    for (const c of MUTATIONS) expect(can(actor("manager"), c)).toBe(false);
    expect(can(actor("manager"), "clients:view")).toBe(true);
    expect(can(actor("manager"), "financial:view")).toBe(true);
    expect(can(actor("manager"), "financialReports:view")).toBe(true);
  });

  it("target Manager policy contains no mutation grant", () => {
    const caps = Object.keys(TARGET_POLICY.manager);
    expect(caps.some(c => /:(create|edit|delete|assign|updateStatus)$/.test(c))).toBe(false);
    expect(caps).not.toContain("users:manage");
  });
});

describe("Lead Lawyer overlay — additive & matter-specific (BR-03)", () => {
  const associate = actor("associate", 42);
  const ledMatter = { id: 100, leadLawyerId: 42 };
  const otherMatter = { id: 101, leadLawyerId: 99 };

  it("is not an account role", () => {
    expect(TARGET_ROLES).toContain("lead_lawyer");
    // ...but it has no base-policy entry — it only exists as an overlay.
    expect((TARGET_POLICY as Record<string, unknown>).lead_lawyer).toBeUndefined();
  });

  it("grants apply only on the matter the actor leads", () => {
    expect(isLeadLawyerOf(associate, ledMatter)).toBe(true);
    expect(isLeadLawyerOf(associate, otherMatter)).toBe(false);
    expect(matterOverlayGrants(associate, ledMatter)["financial:view"]).toBe("ASSIGNED");
    expect(matterOverlayGrants(associate, otherMatter)).toEqual({});
  });

  it("overlay ADDS a capability the base role lacks, scoped ASSIGNED", () => {
    // Associate base cannot view financials...
    expect(can(associate, "financial:view")).toBe(false);
    // ...but as lead lawyer of ledMatter, the overlay grants it (ASSIGNED).
    const withOverlay = authorize(associate, "financial:view", matterOverlayGrants(associate, ledMatter));
    expect(withOverlay.allowed).toBe(true);
    expect(withOverlay.scope).toBe("ASSIGNED");
    // On a matter they do not lead, still denied.
    expect(authorize(associate, "financial:view", matterOverlayGrants(associate, otherMatter)).allowed).toBe(false);
  });

  it("overlay never revokes or narrows base access", () => {
    // Admin has ALL; an overlay cannot downgrade it to ASSIGNED.
    const d = authorize(actor("admin"), "financial:view", LEAD_LAWYER_OVERLAY_GRANTS);
    expect(d.allowed).toBe(true);
    expect(d.scope).toBe("ALL");
  });

  it("overlay grants view but never create/edit on financials (BR-04)", () => {
    expect(LEAD_LAWYER_OVERLAY_GRANTS["financial:view"]).toBe("ASSIGNED");
    expect(LEAD_LAWYER_OVERLAY_GRANTS["financial:create" as keyof typeof LEAD_LAWYER_OVERLAY_GRANTS]).toBeUndefined();
    expect(LEAD_LAWYER_OVERLAY_GRANTS["financial:edit" as keyof typeof LEAD_LAWYER_OVERLAY_GRANTS]).toBeUndefined();
  });
});

describe("compatibility bridge agrees with Phase-1 hasPermission for every legacy role", () => {
  const legacyPermissionUniverse = Object.keys({
    "dashboard:view": 1, "analytics:view": 1, "audit:view": 1,
    "clients:view": 1, "clients:manage": 1,
    "leads:view": 1, "leads:manage": 1,
    "matters:view": 1, "matters:manage": 1, "matters:assign_lawyer": 1,
    "tasks:view": 1, "tasks:manage": 1,
    "actions:view": 1, "actions:manage": 1,
    "notes:view": 1, "notes:manage": 1,
    "payments:view": 1, "payments:manage": 1,
    "financial:view": 1, "financial:manage": 1,
    "ai:assistant": 1,
  });

  it("satisfiesLegacyPermission === hasPermission across all legacy roles × strings", () => {
    for (const role of USER_ROLES) {
      for (const perm of legacyPermissionUniverse) {
        expect(satisfiesLegacyPermission(actor(role), perm)).toBe(hasPermission(role, perm));
      }
    }
  });

  it("every capability a legacy role actually holds in ROLE_PERMISSIONS is reachable", () => {
    // For each legacy role, each granted permission string maps to capabilities
    // the new policy also allows (bridge is faithful, not merely equal on denial).
    for (const role of USER_ROLES) {
      for (const perm of ROLE_PERMISSIONS[role]) {
        if (perm === "*") continue;
        for (const cap of legacyPermissionToCapabilities(perm)) {
          expect(can(actor(role), cap)).toBe(true);
        }
      }
    }
  });
});

describe("legacy policy fidelity (live era)", () => {
  it("legacy finance keeps Phase-1 rights, NOT the expanded target-finance rights", () => {
    // Target finance can create clients/matters; legacy finance (live) cannot.
    expect(can(actor("finance"), "clients:create")).toBe(false);
    expect(can(actor("finance"), "matters:create")).toBe(false);
    // Target policy DOES define the future expansion (inert until migration).
    expect(TARGET_POLICY.finance["clients:create"]).toBe("ALL");
    expect(TARGET_POLICY.finance["matters:create"]).toBe("ALL");
    // Legacy finance still manages financials & payments.
    expect(can(actor("finance"), "financial:edit")).toBe(true);
    expect(can(actor("finance"), "payments:create")).toBe(true);
  });

  it("legacy partner keeps firm-wide manage rights (not HoP own-practice scoping)", () => {
    expect(authorize(actor("partner"), "clients:create").scope).toBe("ALL");
    expect(LEGACY_POLICY.partner["matters:assign"]).toBe("ALL");
  });
});
