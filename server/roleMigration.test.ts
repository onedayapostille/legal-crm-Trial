/**
 * Phase 3 — additive target-role schema support & migration-readiness.
 *
 * Type/mapping/preflight assertions are pure (no DB). One round-trip test proves
 * the session/context path reads the role from the DATABASE (not the JWT); it
 * uses LEGACY roles only, because the additive enum migration (0023) is NOT
 * executed in this phase, so the local DB does not yet carry target values.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { userRoleEnum } from "../drizzle/schema";
import {
  ACCOUNT_ROLE_VALUES, TARGET_ACCOUNT_ROLE_VALUES, isAccountRole,
  LEGACY_ROLES, TARGET_ROLES,
  mapLegacyRole, buildPreflightReport, APPROVED_ROLE_MAPPING,
} from "../shared/policy";
import { USER_ROLES } from "../shared/const";
import * as db from "./db";

const TARGET_ACCOUNT = [
  "head_of_practice", "senior_associate", "executive_associate", "associate",
  "junior_lawyer", "trainee", "paralegal", "coordinator",
] as const;

describe("additive enum: new values accepted by schema & types", () => {
  it("drizzle user_role enum carries every legacy AND target account value", () => {
    const values = userRoleEnum.enumValues;
    for (const legacy of USER_ROLES) expect(values).toContain(legacy);
    for (const target of TARGET_ACCOUNT) expect(values).toContain(target);
  });

  it("drizzle enum exactly matches the canonical ACCOUNT_ROLE_VALUES (drift guard)", () => {
    expect([...userRoleEnum.enumValues].sort()).toEqual([...ACCOUNT_ROLE_VALUES].sort());
  });

  it("isAccountRole accepts legacy and target values", () => {
    for (const r of [...LEGACY_ROLES, ...TARGET_ACCOUNT]) expect(isAccountRole(r)).toBe(true);
    expect(isAccountRole("bogus")).toBe(false);
  });
});

describe("Lead Lawyer is never an account role", () => {
  it("absent from the enum, ACCOUNT_ROLE_VALUES, USER_ROLES, and TARGET_ACCOUNT_ROLE_VALUES", () => {
    expect(userRoleEnum.enumValues).not.toContain("lead_lawyer");
    expect(ACCOUNT_ROLE_VALUES as readonly string[]).not.toContain("lead_lawyer");
    expect(USER_ROLES as readonly string[]).not.toContain("lead_lawyer");
    expect(TARGET_ACCOUNT_ROLE_VALUES as readonly string[]).not.toContain("lead_lawyer");
    expect(isAccountRole("lead_lawyer")).toBe(false);
    // ...even though it exists in the policy role set (as an overlay identity).
    expect(TARGET_ROLES as readonly string[]).toContain("lead_lawyer");
  });
});

describe("legacy and target coexistence", () => {
  it("all seven legacy values remain valid alongside the eight target values", () => {
    for (const legacy of ["admin", "manager", "partner", "lawyer", "finance", "staff", "viewer"]) {
      expect(isAccountRole(legacy)).toBe(true);
      expect(userRoleEnum.enumValues).toContain(legacy);
    }
    expect(userRoleEnum.enumValues.length).toBe(7 + 8);
  });
});

describe("deterministic mapping (approved plan)", () => {
  it("maps the auto roles 1:1 and is deterministic", () => {
    const expected: Record<string, string> = {
      admin: "admin", manager: "manager", partner: "head_of_practice",
      finance: "finance", staff: "coordinator",
    };
    for (const [src, tgt] of Object.entries(expected)) {
      const a = mapLegacyRole(src);
      const b = mapLegacyRole(src);
      expect(a.disposition).toBe("auto");
      expect(a.target).toBe(tgt);
      expect(a).toEqual(b); // deterministic
    }
  });

  it("NEVER auto-maps Lawyer — it is manual (HR grade)", () => {
    const r = mapLegacyRole("lawyer");
    expect(r.disposition).toBe("manual");
    expect(r.target).toBeNull();
  });

  it("Viewer is unmapped pending an explicit decision", () => {
    const r = mapLegacyRole("viewer");
    expect(r.disposition).toBe("decision");
    expect(r.target).toBeNull();
  });

  it("unknown roles fail closed", () => {
    expect(mapLegacyRole("sorcerer").disposition).toBe("unknown");
    expect(mapLegacyRole("sorcerer").target).toBeNull();
  });

  it("an already-target role is a no-op, not 'unknown'", () => {
    const r = mapLegacyRole("head_of_practice");
    expect(r.disposition).toBe("already_target");
    expect(r.target).toBe("head_of_practice");
  });

  it("'new' maps to paralegal but only matters if such rows exist", () => {
    expect(APPROVED_ROLE_MAPPING.new.target).toBe("paralegal");
  });
});

describe("preflight report (pure, no personal data)", () => {
  it("buckets Lawyer as manual, Viewer as decision, unknown as unknown", () => {
    const report = buildPreflightReport([
      { role: "admin", count: 2 },
      { role: "lawyer", count: 5 },
      { role: "viewer", count: 1 },
      { role: "partner", count: 3 },
      { role: "ghost", count: 4 }, // unrecognized
    ]);
    expect(report.totalAccounts).toBe(15);
    expect(report.manual.map(r => r.source)).toEqual(["lawyer"]);
    expect(report.needsDecision.map(r => r.source)).toEqual(["viewer"]);
    expect(report.unknown.map(r => r.source)).toEqual(["ghost"]);
    expect(report.autoMappable.map(r => r.source).sort()).toEqual(["admin", "partner"]);
    expect(report.hasNewRole).toBe(false);
    // report is counts/dispositions only — no email/name fields exist on rows
    for (const row of report.rows) {
      expect(Object.keys(row).sort()).toEqual(["count", "disposition", "reason", "source", "target"]);
    }
  });

  it("detects 'new' rows when present", () => {
    const report = buildPreflightReport([{ role: "new", count: 1 }]);
    expect(report.hasNewRole).toBe(true);
    expect(report.autoMappable.map(r => r.target)).toContain("paralegal");
  });
});

describe("additive migration SQL is structurally safe (not executed)", () => {
  const raw = readFileSync(
    resolve(process.cwd(), "drizzle/migrations/0023_target_roles_additive.sql"),
    "utf-8",
  );
  // Validate the EXECUTABLE SQL only — strip `-- ...` comment lines so prose in
  // the header (which legitimately mentions "renamed", "lead_lawyer", etc.)
  // cannot trigger the destructive-statement guards.
  const sql = raw
    .split("\n")
    .filter(line => !line.trim().startsWith("--"))
    .join("\n");

  it("adds each target account role with ADD VALUE IF NOT EXISTS", () => {
    for (const t of TARGET_ACCOUNT) {
      expect(sql).toContain(`ADD VALUE IF NOT EXISTS '${t}'`);
    }
  });

  it("is purely additive — no destructive or data-mutating statements", () => {
    expect(sql).not.toMatch(/DROP\s+TYPE/i);
    expect(sql).not.toMatch(/RENAME/i);
    expect(sql).not.toMatch(/UPDATE\s+users/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toContain("lead_lawyer"); // overlay, never an account role
    expect(sql).not.toMatch(/ADD VALUE IF NOT EXISTS 'viewer'/); // viewer stays unmapped
  });
});

describe("session/context reads the role from the database (not the JWT)", () => {
  it("getUserById reflects a role changed in the DB", async () => {
    const stamp = Date.now();
    const created = await db.createUser({
      name: `RoleSrc ${stamp}`,
      email: `rolesrc-${stamp}@example.com`,
      passwordHash: "x", // not exercised by this test
      role: "staff", // legacy value (target enum values not migrated locally)
      status: "active",
      reportsToId: null,
    } as any);
    try {
      expect((await db.getUserById(created.id))?.role).toBe("staff");
      await db.updateUserRole(created.id, "lawyer");
      // The context/session path calls getUserById on every request, so a DB
      // role change is observed without re-issuing the JWT.
      expect((await db.getUserById(created.id))?.role).toBe("lawyer");
    } finally {
      await db.deleteUser(created.id);
    }
  });
});
