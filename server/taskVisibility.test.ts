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

describe("Role-based task visibility (backend enforced)", () => {
  async function seed() {
    const a = admin();
    const stamp = Date.now();
    const partner = await a.users.create({ name: `Partner ${stamp}`, email: `p${stamp}@x.com`, password: PW, role: "partner" });
    const lawyerA = await a.users.create({ name: `LawyerA ${stamp}`, email: `la${stamp}@x.com`, password: PW, role: "lawyer", reportsToId: partner.id });
    const lawyerB = await a.users.create({ name: `LawyerB ${stamp}`, email: `lb${stamp}@x.com`, password: PW, role: "lawyer", reportsToId: partner.id });
    const lawyerC = await a.users.create({ name: `LawyerC ${stamp}`, email: `lc${stamp}@x.com`, password: PW, role: "lawyer" }); // no supervisor

    // Tasks created by admin, assigned variously.
    const tA = await a.tasks.create({ title: `tA ${stamp}`, assignedTo: lawyerA.id });
    const tB = await a.tasks.create({ title: `tB ${stamp}`, assignedTo: lawyerB.id });
    const tC = await a.tasks.create({ title: `tC ${stamp}`, assignedTo: lawyerC.id });
    const tP = await a.tasks.create({ title: `tP ${stamp}`, assignedTo: partner.id });
    const tNone = await a.tasks.create({ title: `tNone ${stamp}` }); // unassigned, created by admin

    const taskIds = [tA, tB, tC, tP, tNone].map(t => t.id);
    async function cleanup() {
      for (const id of taskIds) await a.tasks.delete({ id });
      // Delete supervised lawyers BEFORE their supervising partner (reports_to_id FK).
      for (const u of [lawyerA, lawyerB, lawyerC, partner]) await a.users.delete({ userId: u.id });
    }
    return { a, partner, lawyerA, lawyerB, lawyerC, tA, tB, tC, tP, tNone, taskIds, cleanup };
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

  it("Lawyer sees ONLY tasks assigned to or created by them", async () => {
    const s = await seed();
    try {
      const aIds = (await callerFor("lawyer", s.lawyerA.id).tasks.list()).map(t => t.id);
      expect(aIds).toContain(s.tA.id);            // assignee
      expect(aIds).not.toContain(s.tB.id);        // teammate's
      expect(aIds).not.toContain(s.tC.id);
      expect(aIds).not.toContain(s.tP.id);
      expect(aIds).not.toContain(s.tNone.id);     // unassigned admin task

      // created-by path: lawyerA creates an unassigned task → visible to A only.
      const own = await callerFor("lawyer", s.lawyerA.id).tasks.create({ title: `selfA ${Date.now()}` });
      try {
        const aIds2 = (await callerFor("lawyer", s.lawyerA.id).tasks.list()).map(t => t.id);
        expect(aIds2).toContain(own.id);
        const bIds = (await callerFor("lawyer", s.lawyerB.id).tasks.list()).map(t => t.id);
        expect(bIds).not.toContain(own.id);
      } finally {
        await s.a.tasks.delete({ id: own.id });
      }
    } finally {
      await s.cleanup();
    }
  });

  it("Partner sees their team's assigned tasks + own (creator/assignee), not others", async () => {
    const s = await seed();
    try {
      const pIds = (await callerFor("partner", s.partner.id).tasks.list()).map(t => t.id);
      expect(pIds).toContain(s.tA.id);    // reporting lawyer A
      expect(pIds).toContain(s.tB.id);    // reporting lawyer B
      expect(pIds).toContain(s.tP.id);    // assigned to the partner
      expect(pIds).not.toContain(s.tC.id);    // lawyerC does not report to them
      expect(pIds).not.toContain(s.tNone.id); // unassigned, not their own
    } finally {
      await s.cleanup();
    }
  });

  it("Direct API: get/update/delete of an unauthorized task is denied", async () => {
    const s = await seed();
    try {
      const cCaller = callerFor("lawyer", s.lawyerC.id);
      // get → null (no leak)
      expect(await cCaller.tasks.get({ id: s.tA.id })).toBeNull();
      // update → NOT_FOUND
      await expect(cCaller.tasks.update({ id: s.tA.id, status: "done" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      // delete → NOT_FOUND
      await expect(cCaller.tasks.delete({ id: s.tA.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      // …but the lawyer CAN act on their own task
      expect((await cCaller.tasks.get({ id: s.tC.id }))?.id).toBe(s.tC.id);
    } finally {
      await s.cleanup();
    }
  });

  it("Pending-task KPI count respects visibility", async () => {
    const s = await seed();
    try {
      // Lawyer A has exactly one visible non-done task (tA).
      const aStats = await callerFor("lawyer", s.lawyerA.id).dashboard.stats();
      const before = aStats.pendingTasks;
      const extra = await s.a.tasks.create({ title: `extraA ${Date.now()}`, assignedTo: s.lawyerA.id });
      try {
        const after = (await callerFor("lawyer", s.lawyerA.id).dashboard.stats()).pendingTasks;
        expect(after - before).toBe(1); // only A's own task increments A's count
        // The unrelated lawyer C's count is unaffected.
        const cStats = await callerFor("lawyer", s.lawyerC.id).dashboard.stats();
        expect(cStats.pendingTasks).toBe(1); // only tC
      } finally {
        await s.a.tasks.delete({ id: extra.id });
      }
    } finally {
      await s.cleanup();
    }
  });
});
