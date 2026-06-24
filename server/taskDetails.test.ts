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

describe("Task Details (tasks.get) — full context", () => {
  it("a matter-linked task returns client + matter context", async () => {
    const caller = admin();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `DetailMatter ${stamp}`, clientStatus: "Existing Client" });
    const matter = await caller.clientMatters.create({
      clientId: client.id, matterType: "Corporate", matterReference: `DM-${stamp}`,
    });
    let taskId: number | undefined;
    try {
      const t = await caller.tasks.create({
        title: `Matter task ${stamp}`,
        description: "Prepare filing",
        clientId: client.id,
        clientMatterId: matter.id,
        priority: "high",
      });
      taskId = t.id;

      const detail: any = await caller.tasks.get({ id: t.id });
      expect(detail).toBeTruthy();
      expect(detail.title).toBe(`Matter task ${stamp}`);
      expect(detail.description).toBe("Prepare filing");
      // Client context
      expect(detail.clientId).toBe(client.id);
      expect(detail.clientName).toBe(`DetailMatter ${stamp}`);
      expect(detail.clientStatus).toBe("Existing Client");
      // Matter context
      expect(detail.clientMatterId).toBe(matter.id);
      expect(detail.matterReference).toBe(`DM-${stamp}`);
      expect(detail.matterType).toBe("Corporate");
      // Creator is resolved
      expect(detail.creatorName).toBeTruthy();
    } finally {
      if (taskId) await caller.tasks.delete({ id: taskId });
      await caller.clientMatters.delete({ id: matter.id });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("a client-level task returns client context only (no matter)", async () => {
    const caller = admin();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `DetailClient ${stamp}`, clientStatus: "Existing Client" });
    let taskId: number | undefined;
    try {
      const t = await caller.tasks.create({ title: `Client task ${stamp}`, clientId: client.id });
      taskId = t.id;

      const detail: any = await caller.tasks.get({ id: t.id });
      expect(detail.clientId).toBe(client.id);
      expect(detail.clientName).toBe(`DetailClient ${stamp}`);
      // No matter linkage
      expect(detail.clientMatterId == null).toBe(true);
      expect(detail.matterReference == null).toBe(true);
      expect(detail.matterType == null).toBe(true);
    } finally {
      if (taskId) await caller.tasks.delete({ id: taskId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("a task created from an Action Log carries source context + a back-link id", async () => {
    const caller = admin();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `DetailSource ${stamp}`, clientStatus: "Existing Client" });
    let taskId: number | undefined;
    let actionId: number | undefined;
    try {
      const action = await caller.clientActions.create({
        clientId: client.id,
        actionType: "Call",
        actionDetails: "Follow up with client about contract",
      });
      actionId = action.id;

      const t = await caller.tasks.create({
        title: `From action ${stamp}`,
        clientId: client.id,
        sourceType: "action_log",
        sourceId: action.id,
        clientActionLogId: action.id,
      });
      taskId = t.id;

      const detail: any = await caller.tasks.get({ id: t.id });
      expect(detail.sourceType).toBe("action_log");
      expect(detail.sourceId).toBe(action.id);
      // The joined action-log context lets the UI jump back to the source.
      expect(detail.actionLogId).toBe(action.id);
      expect(detail.actionLogType).toBe("Call");
    } finally {
      if (taskId) await caller.tasks.delete({ id: taskId });
      // Action log cascades with the client; deleting the client is enough.
      await caller.clients.delete({ id: client.id });
    }
  });

  it("rejected client: historical task stays viewable (read-only history), new ones are blocked", async () => {
    const caller = admin();
    const stamp = Date.now();
    // Create the client active, add a task, THEN reject it (mirrors real history).
    const client = await caller.clients.create({ clientName: `RejDetail ${stamp}`, clientStatus: "Existing Client" });
    let taskId: number | undefined;
    try {
      const t = await caller.tasks.create({ title: `Hist ${stamp}`, clientId: client.id });
      taskId = t.id;

      await caller.clients.update({ id: client.id, clientStatus: "Rejected" });

      // Existing task detail is still viewable for audit/history.
      const detail: any = await caller.tasks.get({ id: t.id });
      expect(detail).toBeTruthy();
      expect(detail.clientStatus).toBe("Rejected");

      // But no NEW task can be created under the rejected client.
      await expect(
        caller.tasks.create({ title: `New on rejected ${stamp}`, clientId: client.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      if (taskId) await caller.tasks.delete({ id: taskId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("unauthorized viewer cannot read another user's task details (returns null)", async () => {
    const a = admin();
    const stamp = Date.now();
    const lawyer = await a.users.create({ name: `Solo ${stamp}`, email: `solo${stamp}@x.com`, password: PW, role: "lawyer" });
    const other = await a.users.create({ name: `Other ${stamp}`, email: `other${stamp}@x.com`, password: PW, role: "lawyer" });
    let taskId: number | undefined;
    try {
      // Task assigned to + created for `other`, with no link to `lawyer`.
      const t = await a.tasks.create({ title: `Private ${stamp}`, assignedTo: other.id });
      taskId = t.id;

      const lawyerCaller = callerFor("lawyer", lawyer.id);
      const detail = await lawyerCaller.tasks.get({ id: t.id });
      expect(detail).toBeNull();

      // Admin still sees it (full access).
      const adminDetail = await a.tasks.get({ id: t.id });
      expect(adminDetail).toBeTruthy();
    } finally {
      if (taskId) await a.tasks.delete({ id: taskId });
      for (const u of [lawyer, other]) await a.users.delete({ userId: u.id });
    }
  }, 30000); // creates+deletes users (bcrypt) over the remote pooler — needs headroom
});
