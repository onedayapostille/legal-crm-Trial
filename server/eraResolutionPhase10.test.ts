/**
 * Phase 10 — legacy⇄target policy-era resolution for overlapping role names.
 *
 * `authorize()` picks a role's policy by STRING ONLY: `isLegacyRole(role)` is
 * checked FIRST, so the names shared by both eras — admin, manager, finance —
 * ALWAYS resolve to LEGACY_POLICY. There is NO per-account era discriminator.
 * Consequently:
 *   - Assigning admin/manager/finance in User Management yields LEGACY behavior,
 *     unchanged from before — existing accounts never change silently.
 *   - TARGET_FINANCE (and target admin/manager grants) are UNREACHABLE via any
 *     assignable role string, so widening roleSchema cannot prematurely activate
 *     target Finance. A real transition needs a future explicit discriminator.
 *   - Only the target-ONLY names (head_of_practice, senior/executive associate,
 *     associate, junior_lawyer, trainee, paralegal, coordinator) resolve to
 *     TARGET_POLICY — and their enforcement is complete (Phases 4–9); anything the
 *     matrix does not enforce fails closed.
 *
 * Pure — no database.
 */
import { describe, expect, it } from "vitest";
import {
  authorize, CAPABILITIES, LEGACY_POLICY, TARGET_POLICY, DEFERRED_TARGET_CAPABILITIES,
  APPROVED_ACCOUNT_ROLES, isTargetOnlyRole, mapLegacyRole,
} from "@shared/policy";

const actor = (role: string) => ({ id: 1, role, status: "active" });
const scopeOf = (cells: Record<string, string>, cap: string) => cells[cap] ?? null;

const TARGET_ONLY_ROLES = [
  "head_of_practice", "senior_associate", "executive_associate",
  "associate", "junior_lawyer", "trainee", "paralegal", "coordinator",
];

describe("shared-name roles resolve to LEGACY, never TARGET (no era discriminator)", () => {
  for (const role of ["admin", "manager", "finance"] as const) {
    it(`authorize("${role}") matches LEGACY_POLICY.${role} on every capability`, () => {
      const legacy = LEGACY_POLICY[role] as Record<string, string>;
      for (const cap of CAPABILITIES) {
        const d = authorize(actor(role), cap);
        const expected = scopeOf(legacy, cap);
        expect(d.allowed, `${role} ${cap} allowed`).toBe(expected != null && expected !== "NONE");
        if (d.allowed) expect(d.scope, `${role} ${cap} scope`).toBe(expected);
      }
    });
  }

  it("manager and finance have DIFFERENT legacy vs target policies (so the match above is meaningful)", () => {
    for (const role of ["manager", "finance"] as const) {
      const legacy = LEGACY_POLICY[role] as Record<string, string>;
      const target = TARGET_POLICY[role] as Record<string, string>;
      const differs = CAPABILITIES.some(cap => scopeOf(legacy, cap) !== scopeOf(target, cap));
      expect(differs, `${role} legacy vs target should differ`).toBe(true);
    }
  });
});

describe("target Finance cannot be silently activated via User Management", () => {
  it("the 'finance' string resolves to LEGACY_FINANCE, which lacks target-only grants", () => {
    // TARGET_FINANCE grants these; LEGACY_FINANCE does not — so a live/assigned
    // 'finance' account provably gets legacy behavior.
    for (const cap of ["audit:view", "clients:create", "clients:edit", "matters:create", "tasks:view"] as const) {
      expect(TARGET_POLICY.finance[cap], `target finance ${cap} granted`).toBeTruthy();
      expect(authorize(actor("finance"), cap).allowed, `legacy finance ${cap} denied`).toBe(false);
    }
  });

  it("no assignable role string maps to the TARGET policy for a shared name", () => {
    // Only target-ONLY names route to TARGET_POLICY; the shared names never do.
    expect(isTargetOnlyRole("finance")).toBe(false);
    expect(isTargetOnlyRole("manager")).toBe(false);
    expect(isTargetOnlyRole("admin")).toBe(false);
    expect(isTargetOnlyRole("head_of_practice")).toBe(true);
  });

  it("existing Finance access is unchanged (still full financial, no tasks/audit)", () => {
    expect(authorize(actor("finance"), "financial:edit").allowed).toBe(true);   // legacy finance keeps this
    expect(authorize(actor("finance"), "tasks:view").allowed).toBe(false);       // legacy finance never had tasks
    expect(authorize(actor("finance"), "audit:view").allowed).toBe(false);
  });
});

describe("target role assignment cannot activate unenforced authority (§5)", () => {
  it("every target-only role fails closed on all deferred (unenforced) capabilities", () => {
    for (const role of TARGET_ONLY_ROLES) {
      for (const cap of DEFERRED_TARGET_CAPABILITIES) {
        expect(authorize(actor(role), cap).allowed, `${role} ${cap} must be denied`).toBe(false);
      }
    }
  });
});

describe("legacy Partner/Lawyer/Staff/Viewer transition rules (§6)", () => {
  it("Lawyer requires MANUAL grading; Viewer stays UNMAPPED", () => {
    expect(mapLegacyRole("lawyer").disposition).toBe("manual");
    expect(mapLegacyRole("lawyer").target).toBeNull();
    expect(mapLegacyRole("viewer").disposition).toBe("decision");
    expect(mapLegacyRole("viewer").target).toBeNull();
  });

  it("none of the legacy-only roles are offered for new assignment", () => {
    for (const legacy of ["partner", "lawyer", "staff", "viewer"]) {
      expect(APPROVED_ACCOUNT_ROLES as readonly string[]).not.toContain(legacy);
    }
  });

  it("but legacy roles still resolve (so existing accounts keep working)", () => {
    for (const legacy of ["partner", "lawyer", "staff", "viewer"]) {
      expect(authorize(actor(legacy), "clients:view").allowed).toBe(true);
    }
  });
});
