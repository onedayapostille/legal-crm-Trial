/**
 * Phase 10 — server-side Finance-transition guard (temporary, pending the
 * legacy/target policy-era discriminator).
 *
 * User Management must not CREATE a Finance account or TRANSITION another role into
 * Finance, because `authorize()` resolves `finance` to LEGACY finance (not the
 * approved target Finance) — assigning it would misrepresent the role. Existing
 * Finance accounts stay fully readable/editable and keep their legacy financial
 * behavior. These call the real router middleware, not just helpers.
 *
 * DB-touching — runs against the configured (disposable, local) DATABASE_URL.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { createUser, deleteUser } from "./db";
import { hashPassword } from "./_core/auth";
// NOTE: the UI-dropdown/server agreement and legacy-Finance policy behavior are
// covered by uiPolicyPhase10 (frontend PR) and eraResolutionPhase10 (foundation PR)
// respectively, so this server test stays self-contained (no client import).

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;
function callerFor(role: string, id = 1) {
  const user: AuthenticatedUser = {
    id, openId: `test-${role}`, email: `${role}@example.com`, name: role,
    loginMethod: "manus", role: role as any, status: "active",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}
let seq = 0;
const seed = (role: string) =>
  createUser({
    name: `${role} fixture`,
    email: `p10-${role}-${Date.now()}-${seq++}@example.com`,
    passwordHash: "x", role: role as any, status: "active",
  } as any);

describe("Phase 10 — Finance role assignment is blocked server-side", () => {
  let adminId: number;
  let paralegalId: number;
  let financeId: number;
  // Admin caller bound to a REAL seeded admin id (a freshly-migrated test DB has no
  // users, so we must not assume id 1 — otherwise the caller could collide with a
  // fixture and trip the self-role-change guard).
  const admin = () => callerFor("admin", adminId);

  beforeAll(async () => {
    adminId = (await seed("admin")).id;
    paralegalId = (await seed("paralegal")).id;
    // Legacy Finance fixture seeded directly (the create API now rejects Finance).
    financeId = (await createUser({
      name: "Legacy Finance", email: `p10-fin-${Date.now()}@example.com`,
      passwordHash: await hashPassword("Finance123"), role: "finance", status: "active",
    } as any)).id;
  });
  afterAll(async () => {
    if (paralegalId) await deleteUser(paralegalId);
    if (financeId) await deleteUser(financeId);
    if (adminId) await deleteUser(adminId);
  });

  it("users.create rejects a NEW Finance account (CONFLICT)", async () => {
    await expect(
      admin().users.create({
        name: "Nope", email: `p10-newfin-${Date.now()}@example.com`,
        password: "Finance123", role: "finance", status: "active",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("users.update rejects a non-Finance → Finance transition (CONFLICT)", async () => {
    await expect(
      admin().users.update({
        userId: paralegalId, name: "Para", email: `p10-para-upd-${Date.now()}@example.com`,
        role: "finance", status: "active",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("users.updateRole rejects a non-Finance → Finance transition (CONFLICT)", async () => {
    await expect(
      admin().users.updateRole({ userId: paralegalId, role: "finance" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("an EXISTING Finance account may remain Finance (update, unchanged role)", async () => {
    const res = await admin().users.update({
      userId: financeId, name: "Legacy Finance (edited)",
      email: `p10-fin-keep-${Date.now()}@example.com`, role: "finance", status: "active",
    });
    expect(res.role).toBe("finance");
  });

  it("an EXISTING Finance account may remain Finance (updateRole, unchanged role)", async () => {
    await expect(
      admin().users.updateRole({ userId: financeId, role: "finance" }),
    ).resolves.toBeTruthy();
  });

  it("a non-Finance role change is still allowed (guard is Finance-specific)", async () => {
    await expect(
      admin().users.updateRole({ userId: paralegalId, role: "coordinator" }),
    ).resolves.toBeTruthy();
    // restore for cleanup determinism
    await admin().users.updateRole({ userId: paralegalId, role: "paralegal" });
  });
});
