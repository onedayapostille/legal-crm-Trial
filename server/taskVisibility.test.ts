import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function callerFor(role: string, id: number) {
  const user: AuthenticatedUser = {
    id,
    openId: `test-${role}-${id}`,
    email: `u${id}@example.com`,
    name: `User ${id}`,
    loginMethod: "manus",
    role: role as any,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}
const admin = () => callerFor("admin", 1);
const PW = "Passw0rd123";

/**
 * Role-based task visibility (backend enforced) — AGP spec v1.1 matrix:
 *   admin / manager / head_of_practice / coordinator → ALL tasks
 *   lawyer grades / paralegal / finance → OWN tasks (assignee or creator),
 *     plus (Lead Lawyer overlay) all tasks of matters they lead
 * The old reports_to_id-based partner visibility is superseded: a Head of
 * Practice now sees every task firm-wide.
 */
describe("Role-based task visibility (backend enforced)", () => {
  async function seed() {
    const a = admin();
    const stamp = Date.now();
    const hop = await a.users.create({ name: `HoP ${stamp}`, email: `p${stamp}@x.com`, password: PW, role: "head_of_practice" });
    const lawyerA = await a.users.create({ name: `LawyerA ${stamp}`, email: `la${stamp}@x.com`, password: PW, role: "associate", reportsToId: hop.id });
    const lawyerB = await a.users.create({ name: `LawyerB ${stamp}`, email: `lb${stamp}@x.com`, password: PW, role: "associate", reportsToId: hop.id });
    const lawyerC = await a.users.create({ name: `LawyerC ${stamp}`, email: `lc${stamp}@x.com`, password: PW, role: "associate" }); // no supervisor

    // Every task must be client-scoped (no orphan tasks); visibility is by
    // assignee/creator/role, so a shared client doesn't affect these assertions.
    const client = await a.clients.create({ clientName: `VisClient ${stamp}`, clientStatus: "Existing Client" });

    // Tasks created by admin, assigned variously.
    const tA = await a.tasks.create({ title: `tA ${stamp}`, clientId: client.id, assignedTo: lawyerA.id });
    const tB = await a.tasks.create({ title: `tB ${stamp}`, clientId: client.id, assignedTo: lawyerB.id });
    const tC = await a.tasks.create({ title: `tC ${stamp}`, clientId: client.id, assignedTo: lawyerC.id });
    const tP = await a.tasks.create({ title: `tP ${stamp}`, clientId: client.id, assignedTo: hop.id });
    const tNone = await a.tasks.create({ title: `tNone ${stamp}`, clientId: client.id }); // unassigned, created by admin

    const taskIds = [tA, tB, tC, tP, tNone].map(t => t.id);
    async function cleanup() {
      for (const id of taskIds) await a.tasks.delete({ id });
      await a.clients.delete({ id: client.id });
      // Delete supervised lawyers BEFORE their supervising HoP (reports_to_id FK).
      for (const u of [lawyerA, lawyerB, lawyerC, hop]) await a.users.delete({ userId: u.id });
    }
    return { a, hop, lawyerA, lawyerB, lawyerC, client, tA, tB, tC, tP, tNone, taskIds, cleanup };
  }

  it("Admin and Manager see all tasks", async () => {
    const s = await seed();
    try {
      const adminIds = (await admin().tasks.list()).map(t => t.id);
      const managerIds = (await callerFor("manager", 2).tasks.list()).map(t => t.id);
      for (const id of s.taskIds) {
        expect(adminIds).toContain(id);
        expect(managerIds).toContain(id);
      }
    } finally {
      await s.cleanup();
    }
  });

  it("Associate sees ONLY tasks assigned to or created by them", async () => {
    const s = await seed();
    try {
      const aIds = (await callerFor("associate", s.lawyerA.id).tasks.list()).map(t => t.id);
      expect(aIds).toContain(s.tA.id);            // assignee
      expect(aIds).not.toContain(s.tB.id);        // teammate's
      expect(aIds).not.toContain(s.tC.id);
      expect(aIds).not.toContain(s.tP.id);
      expect(aIds).not.toContain(s.tNone.id);     // unassigned admin task

      // created-by path: lawyerA creates an unassigned task → visible to A only.
      const own = await callerFor("associate", s.lawyerA.id).tasks.create({ title: `selfA ${Date.now()}`, clientId: s.client.id });
      try {
        const aIds2 = (await callerFor("associate", s.lawyerA.id).tasks.list()).map(t => t.id);
        expect(aIds2).toContain(own.id);
        const bIds = (await callerFor("associate", s.lawyerB.id).tasks.list()).map(t => t.id);
        expect(bIds).not.toContain(own.id);
      } finally {
        await s.a.tasks.delete({ id: own.id });
      }
    } finally {
      await s.cleanup();
    }
  });

  it("Head of Practice sees ALL tasks firm-wide (spec matrix: Tasks — view/update = All)", async () => {
    const s = await seed();
    try {
      const pIds = (await callerFor("head_of_practice", s.hop.id).tasks.list()).map(t => t.id);
      for (const id of s.taskIds) expect(pIds).toContain(id);
    } finally {
      await s.cleanup();
    }
  });

  it("Direct API: get/update of an unauthorized task is denied; delete is admin-only", async () => {
    const s = await seed();
    try {
      const cCaller = callerFor("associate", s.lawyerC.id);
      // get → null (no leak)
      expect(await cCaller.tasks.get({ id: s.tA.id })).toBeNull();
      // update → NOT_FOUND
      await expect(cCaller.tasks.update({ id: s.tA.id, status: "done" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      // delete → FORBIDDEN (task deletion is Admin-only under the new matrix,
      // even for the user's own tasks)
      await expect(cCaller.tasks.delete({ id: s.tA.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(cCaller.tasks.delete({ id: s.tC.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
      // …but the lawyer CAN act on their own task
      expect((await cCaller.tasks.get({ id: s.tC.id }))?.id).toBe(s.tC.id);
      await expect(cCaller.tasks.update({ id: s.tC.id, status: "in_progress" })).resolves.toBeTruthy();
    } finally {
      await s.cleanup();
    }
  });

  it("Pending-task KPI count respects visibility", async () => {
    const s = await seed();
    try {
      // Lawyer A has exactly one visible non-done task (tA).
      const aStats = await callerFor("associate", s.lawyerA.id).dashboard.stats();
      const before = aStats.pendingTasks;
      const extra = await s.a.tasks.create({ title: `extraA ${Date.now()}`, clientId: s.client.id, assignedTo: s.lawyerA.id });
      try {
        const after = (await callerFor("associate", s.lawyerA.id).dashboard.stats()).pendingTasks;
        expect(after - before).toBe(1); // only A's own task increments A's count
        // The unrelated lawyer C's count is unaffected.
        const cStats = await callerFor("associate", s.lawyerC.id).dashboard.stats();
        expect(cStats.pendingTasks).toBe(1); // only tC
      } finally {
        await s.a.tasks.delete({ id: extra.id });
      }
    } finally {
      await s.cleanup();
    }
  });
});
