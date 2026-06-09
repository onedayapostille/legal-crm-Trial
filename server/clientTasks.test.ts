import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function adminCaller() {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-admin",
    email: "admin@example.com",
    name: "Admin",
    loginMethod: "manus",
    role: "admin",
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

describe("Client tasks — client/matter scoping, filters, rejected lock", () => {
  it("creates a client-scoped task (and a no-matter task) and lists them by clientId", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `TaskClient ${stamp}`, clientStatus: "Existing Client" });
    const matter = await caller.clientMatters.create({ clientId: client.id, matterReference: `TM-${stamp}` });
    const ids: number[] = [];
    try {
      const withMatter = await caller.tasks.create({
        title: `On matter ${stamp}`, clientId: client.id, clientMatterId: matter.id,
      });
      const noMatter = await caller.tasks.create({
        title: `Pre-matter ${stamp}`, clientId: client.id, // "N/A — No matter yet"
      });
      ids.push(withMatter.id, noMatter.id);

      expect(withMatter.clientId).toBe(client.id);
      expect(withMatter.clientMatterId).toBe(matter.id);
      expect(noMatter.clientMatterId == null).toBe(true);

      const clientTasks = await caller.tasks.list({ clientId: client.id });
      expect(clientTasks.map(t => t.id).sort()).toEqual([withMatter.id, noMatter.id].sort());
      // assignee/matter joins surface on rows
      const row = clientTasks.find(t => t.id === withMatter.id) as any;
      expect(row.matterReference).toBe(`TM-${stamp}`);
    } finally {
      for (const id of ids) await caller.tasks.delete({ id });
      await caller.clientMatters.delete({ id: matter.id });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("filters tasks by matter and status", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `FilterClient ${stamp}`, clientStatus: "Existing Client" });
    const m1 = await caller.clientMatters.create({ clientId: client.id, matterReference: `M1-${stamp}` });
    const ids: number[] = [];
    try {
      const a = await caller.tasks.create({ title: `A ${stamp}`, clientId: client.id, clientMatterId: m1.id, status: "todo" });
      const b = await caller.tasks.create({ title: `B ${stamp}`, clientId: client.id, status: "done" });
      ids.push(a.id, b.id);

      const byMatter = await caller.tasks.list({ clientId: client.id, clientMatterId: m1.id });
      expect(byMatter.map(t => t.id)).toContain(a.id);
      expect(byMatter.map(t => t.id)).not.toContain(b.id);

      const byStatus = await caller.tasks.list({ clientId: client.id, status: "done" });
      expect(byStatus.map(t => t.id)).toContain(b.id);
      expect(byStatus.map(t => t.id)).not.toContain(a.id);
    } finally {
      for (const id of ids) await caller.tasks.delete({ id });
      await caller.clientMatters.delete({ id: m1.id });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("Related Tasks: lists tasks by clientMatterId", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `RelClient ${stamp}`, clientStatus: "Existing Client" });
    const matter = await caller.clientMatters.create({ clientId: client.id, matterReference: `RM-${stamp}` });
    let taskId: number | undefined;
    try {
      const t = await caller.tasks.create({ title: `Rel ${stamp}`, clientId: client.id, clientMatterId: matter.id });
      taskId = t.id;
      const related = await caller.tasks.list({ clientMatterId: matter.id });
      expect(related.some(x => x.id === t.id)).toBe(true);
    } finally {
      if (taskId) await caller.tasks.delete({ id: taskId });
      await caller.clientMatters.delete({ id: matter.id });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("rejected clients cannot get new tasks (lock enforced)", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `RejTask ${stamp}`, clientStatus: "Rejected" });
    try {
      await expect(
        caller.tasks.create({ title: `Nope ${stamp}`, clientId: client.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("global task creation (no client) still works for cross-client view", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    let id: number | undefined;
    try {
      const t = await caller.tasks.create({ title: `Global ${stamp}` });
      id = t.id;
      expect(t.id).toBeGreaterThan(0);
      expect(t.clientId == null).toBe(true);
    } finally {
      if (id) await caller.tasks.delete({ id });
    }
  });
});
