/**
 * Phase 9 — the approved permission matrix, locked cell-by-cell.
 *
 * This table is an INDEPENDENT restatement of the authoritative source
 * (AGP_CRM_Roles_Permissions_Specification.docx §4 + companion
 * AGP_CRM_Roles_Permissions_Matrix.xlsx "Permission Matrix", BR-01..BR-15). Every
 * target account role × every capability is asserted against `authorize()`, so any
 * drift between the source and `shared/policy/matrix.ts` fails here.
 *
 * Scope legend (source → DataScope): All→ALL, Prac→OWN_PRACTICE, Asgn→ASSIGNED,
 * Own→OWN, Reg→REGISTRY, "—"→(absent, fail closed).
 *
 * Pure policy test — no database.
 */
import { describe, expect, it } from "vitest";
import { authorize, CAPABILITIES, LEAD_LAWYER_OVERLAY_GRANTS, TARGET_POLICY, type DataScope, type KnownCapability } from "../shared/policy";

const actor = (role: string) => ({ id: 1, role, status: "active" as const });

// Names shared by both eras resolve to LEGACY_POLICY until account migration, so
// their TARGET cells are validated at the DATA level; target-ONLY roles resolve to
// TARGET_POLICY and are additionally validated through the live authorize() path.
const SHARED_NAME_ROLES = ["admin", "manager", "finance"];
const TARGET_ONLY_ROLES = [
  "head_of_practice", "senior_associate", "executive_associate",
  "associate", "junior_lawyer", "trainee", "paralegal", "coordinator",
];

// ─── The approved matrix, per target account role (granted cells only) ────────
type Cells = Partial<Record<KnownCapability, DataScope>>;

const ASSIGNED_LEGAL_TIER: Cells = {
  "dashboard:view": "ASSIGNED", "analytics:view": "ASSIGNED", "audit:view": "ASSIGNED",
  "clients:view": "ASSIGNED",
  "matters:view": "ASSIGNED", "matters:edit": "ASSIGNED",
  "tasks:view": "OWN", "tasks:edit": "OWN",
};

const EXPECTED: Record<string, Cells> = {
  // Manager — firm-wide READ-ONLY (BR-08); Payment Tracker & Notes are not target modules.
  manager: {
    "dashboard:view": "ALL", "analytics:view": "ALL", "audit:view": "ALL",
    "clients:view": "ALL", "leads:view": "ALL", "matters:view": "ALL",
    "tasks:view": "ALL", "financial:view": "ALL", "financialReports:view": "ALL", "rates:view": "ALL",
  },
  // Head of Practice — views all, OWN_PRACTICE writes, all tasks + assign, reports (BR-02/14).
  head_of_practice: {
    "dashboard:view": "ALL", "analytics:view": "ALL", "audit:view": "ALL",
    "clients:view": "ALL", "clients:create": "OWN_PRACTICE", "clients:edit": "OWN_PRACTICE",
    "leads:view": "ALL",
    "matters:view": "ALL", "matters:create": "OWN_PRACTICE", "matters:edit": "OWN_PRACTICE", "matters:assign": "OWN_PRACTICE",
    "financial:view": "ALL", "financial:create": "OWN_PRACTICE", "financial:edit": "OWN_PRACTICE",
    "financialReports:view": "ALL",
    "rates:view": "ALL", "rates:create": "OWN_PRACTICE", "rates:edit": "OWN_PRACTICE",
    "tasks:view": "ALL", "tasks:edit": "ALL", "tasks:create": "ALL", "tasks:assign": "ALL",
  },
  // Senior Associate — assigned-matter scope; financial view-only (BR-04/05); own tasks + assign (BR-10).
  senior_associate: {
    "dashboard:view": "ASSIGNED", "analytics:view": "ASSIGNED", "audit:view": "ASSIGNED",
    "clients:view": "ASSIGNED",
    "matters:view": "ASSIGNED", "matters:edit": "ASSIGNED",
    "financial:view": "ASSIGNED", "rates:view": "ASSIGNED",
    "tasks:view": "OWN", "tasks:edit": "OWN", "tasks:assign": "OWN",
  },
  // Executive Associate — assigned-matter, NO finance (BR-05); own tasks + assign (BR-10).
  executive_associate: {
    "dashboard:view": "ASSIGNED", "analytics:view": "ASSIGNED", "audit:view": "ASSIGNED",
    "clients:view": "ASSIGNED",
    "matters:view": "ASSIGNED", "matters:edit": "ASSIGNED",
    "tasks:view": "OWN", "tasks:edit": "OWN", "tasks:assign": "OWN",
  },
  // Associate / Junior Lawyer / Trainee — one profile; own tasks, NO assign (BR-10).
  associate: ASSIGNED_LEGAL_TIER,
  junior_lawyer: ASSIGNED_LEGAL_TIER,
  trainee: ASSIGNED_LEGAL_TIER,
  // Paralegal — view+edit all clients/matters (no create), NO finance, own tasks (BR-11).
  paralegal: {
    "dashboard:view": "ALL", "analytics:view": "ALL", "audit:view": "ALL",
    "clients:view": "ALL", "clients:edit": "ALL",
    "matters:view": "ALL", "matters:edit": "ALL",
    "tasks:view": "OWN", "tasks:edit": "OWN",
  },
  // Finance — full clients/matters (no delete), full financial incl. delete, reports, own tasks (BR-12).
  finance: {
    "dashboard:view": "ALL", "analytics:view": "ALL", "audit:view": "ALL",
    "clients:view": "ALL", "clients:create": "ALL", "clients:edit": "ALL",
    "matters:view": "ALL", "matters:create": "ALL", "matters:edit": "ALL",
    "financial:view": "ALL", "financial:create": "ALL", "financial:edit": "ALL", "financial:delete": "ALL",
    "financialReports:view": "ALL", "financialReports:export": "ALL",
    "rates:view": "ALL", "rates:create": "ALL", "rates:edit": "ALL", "rates:delete": "ALL",
    "tasks:view": "OWN", "tasks:edit": "OWN",
  },
  // Coordinator — REGISTRY clients + intake, full matters, payment-status financial view, all tasks + assign (BR-07/13/15).
  coordinator: {
    "dashboard:view": "REGISTRY", "analytics:view": "REGISTRY", "audit:view": "REGISTRY",
    "clients:view": "REGISTRY", "clients:create": "REGISTRY", "clients:edit": "REGISTRY",
    "leads:view": "ALL", "leads:create": "ALL", "leads:edit": "ALL", "leads:updateStatus": "ALL",
    "matters:view": "ALL", "matters:create": "ALL", "matters:edit": "ALL",
    "financial:view": "ALL",
    "tasks:view": "ALL", "tasks:edit": "ALL", "tasks:assign": "ALL",
  },
};

// Admin holds every capability at ALL (fullAccess).
const ADMIN_CELLS: Cells = Object.fromEntries(CAPABILITIES.map(c => [c, "ALL"])) as Cells;
const EXPECTED_ALL: Record<string, Cells> = { ...EXPECTED, admin: ADMIN_CELLS };

describe("approved matrix — TARGET_POLICY data locked cell-by-cell to the source", () => {
  for (const role of Object.keys(EXPECTED_ALL)) {
    it(`TARGET_POLICY.${role} equals the approved matrix on all ${CAPABILITIES.length} capabilities`, () => {
      const cells = TARGET_POLICY[role as keyof typeof TARGET_POLICY];
      for (const cap of CAPABILITIES) {
        expect(cells?.[cap] ?? null, `${role} × ${cap}`).toBe(EXPECTED_ALL[role][cap] ?? null);
      }
    });
  }

  it("only Admin holds user management & system settings (BR-09)", () => {
    for (const role of Object.keys(EXPECTED)) { // every non-admin target role
      expect(TARGET_POLICY[role as keyof typeof TARGET_POLICY]["users:manage"]).toBeUndefined();
      expect(TARGET_POLICY[role as keyof typeof TARGET_POLICY]["settings:manage"]).toBeUndefined();
    }
  });

  it("Manager target policy carries no mutation cell (BR-08 read-only)", () => {
    for (const cap of Object.keys(TARGET_POLICY.manager)) {
      expect(/:(create|edit|delete|assign|updateStatus|manage)$/.test(cap), cap).toBe(false);
    }
  });
});

describe("live enforcement — authorize() resolves target-only roles to the matrix", () => {
  for (const role of TARGET_ONLY_ROLES) {
    it(`authorize(${role}) matches the approved matrix on every capability`, () => {
      for (const cap of CAPABILITIES) {
        const d = authorize(actor(role), cap);
        const exp = EXPECTED[role][cap];
        if (exp) {
          expect(d.allowed, `${role} should hold ${cap}`).toBe(true);
          expect(d.scope, `${role} ${cap} scope`).toBe(exp);
        } else {
          expect(d.allowed, `${role} must NOT hold ${cap}`).toBe(false);
          expect(d.scope).toBe("NONE");
        }
      }
    });
  }
});

describe("era isolation — shared-name roles stay LEGACY until account migration", () => {
  it("admin/manager/finance still resolve to LEGACY_POLICY, not their TARGET cells", () => {
    // Manager: TARGET withholds payments:view (conflict #1 fix) but LEGACY grants it.
    expect(TARGET_POLICY.manager["payments:view"]).toBeUndefined();
    expect(authorize(actor("manager"), "payments:view").allowed).toBe(true); // legacy still on
    // Finance: TARGET grants audit:view; LEGACY does not.
    expect(TARGET_POLICY.finance["audit:view"]).toBe("ALL");
    expect(authorize(actor("finance"), "audit:view").allowed).toBe(false); // legacy still off
  });
});

describe("Lead Lawyer overlay — additive, matter-scoped, financial read-only (BR-03/04/05)", () => {
  it("grants exactly the Lead Lawyer column, all at ASSIGNED", () => {
    expect(LEAD_LAWYER_OVERLAY_GRANTS).toEqual({
      "clients:view": "ASSIGNED",
      "matters:view": "ASSIGNED",
      "matters:edit": "ASSIGNED",
      "financial:view": "ASSIGNED",
      "rates:view": "ASSIGNED",
      "tasks:view": "ASSIGNED",
      "tasks:edit": "ASSIGNED",
      "tasks:assign": "ASSIGNED",
    });
  });

  it("never confers financial or matter mutation beyond view (BR-04/05)", () => {
    for (const cap of ["financial:create", "financial:edit", "financial:delete", "matters:create", "clients:create", "clients:edit"] as const) {
      expect((LEAD_LAWYER_OVERLAY_GRANTS as Record<string, unknown>)[cap]).toBeUndefined();
    }
  });

  it("is additive over a base role via authorize(overlayGrants)", () => {
    // A base Executive Associate (no financial) gains matter-scoped financial view
    // ONLY through the overlay, and only at ASSIGNED — never create/edit.
    const base = authorize(actor("executive_associate"), "financial:view");
    expect(base.allowed).toBe(false);
    const withOverlay = authorize(actor("executive_associate"), "financial:view", LEAD_LAWYER_OVERLAY_GRANTS);
    expect(withOverlay.allowed).toBe(true);
    expect(withOverlay.scope).toBe("ASSIGNED");
    // The overlay cannot grant a create it does not contain.
    expect(authorize(actor("executive_associate"), "financial:create", LEAD_LAWYER_OVERLAY_GRANTS).allowed).toBe(false);
  });
});

describe("legacy Lawyer / Staff receive NO accidental target authority (era isolation)", () => {
  it("legacy roles resolve to LEGACY_POLICY — every grant is scope ALL, never a target scope", () => {
    for (const role of ["lawyer", "staff"]) {
      for (const cap of CAPABILITIES) {
        const d = authorize(actor(role), cap);
        if (d.allowed) {
          expect(d.scope, `${role} ${cap} must be ALL, not a target scope`).toBe("ALL");
        }
      }
    }
  });

  it("legacy Lawyer does not gain a legal-grade's target profile", () => {
    // Target senior/associate scope tasks OWN and (senior) view finance ASSIGNED;
    // legacy lawyer keeps ALL tasks and NO finance — proving it is not re-graded.
    expect(authorize(actor("lawyer"), "tasks:view").scope).toBe("ALL");
    expect(authorize(actor("lawyer"), "financial:view").allowed).toBe(false);
  });

  it("legacy Staff does not gain Coordinator's REGISTRY/intake profile", () => {
    // Coordinator is REGISTRY on clients; legacy staff is ALL. Staff has no leads:updateStatus target grant beyond legacy.
    expect(authorize(actor("staff"), "clients:view").scope).toBe("ALL");
    expect(authorize(actor("staff"), "financial:view").allowed).toBe(false);
  });
});
