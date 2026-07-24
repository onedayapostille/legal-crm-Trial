import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function callerFor(role: string, id: number) {
  const user: AuthenticatedUser = {
    id, openId: `test-${role}-${id}`, email: `u${id}@example.com`, name: `User ${id}`,
    loginMethod: "manus", role: role as any,
    authorizationModel: (["admin", "manager", "partner", "lawyer", "finance", "staff", "viewer"].includes(role) ? "legacy" : "target") as any,
    status: "active",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}
const admin = () => callerFor("admin", 1);
const PW = "Passw0rd123";

// The main Tasks page and the client Tasks tab read the SAME procedure:
//   main page  → tasks.list({})            (all permitted)
//   client tab → tasks.list({ clientId })  (same rows, filtered)
// These tests assert there is one source of truth and that the two views stay
// in sync through it.
describe("Tasks — single source of truth + client/main-page synchronization", () => {
  it("a task created with a client appears in BOTH the main list and the client tab", async () => {
    const a = admin();
    const stamp = Date.now();
    const client = await a.clients.create({ clientName: `Sync ${stamp}`, clientStatus: "Existing Client" });
    let taskId: number | undefined;
    try {
      const t = await a.tasks.create({ title: `Both views ${stamp}`, clientId: client.id });
      taskId = t.id;

      const mainList = await a.tasks.list({});                 // main Tasks page
      const clientTab = await a.tasks.list({ clientId: client.id }); // client profile tab
      expect(mainList.some(x => x.id === t.id)).toBe(true);
      expect(clientTab.some(x => x.id === t.id)).toBe(true);
    } finally {
      if (taskId) await a.tasks.delete({ id: taskId });
      await a.clients.delete({ id: client.id });
    }
  });

  it("a matter-linked task shows client + matter context in both views", async () => {
    const a = admin();
    const stamp = Date.now();
    const client = await a.clients.create({ clientName: `MCtx ${stamp}`, clientStatus: "Existing Client" });
    const matter = await a.clientMatters.create({ clientId: client.id, matterType: "Corporate", matterReference: `MS-${stamp}` });
    let taskId: number | undefined;
    try {
      const t = await a.tasks.create({ title: `Matter task ${stamp}`, clientId: client.id, clientMatterId: matter.id });
      taskId = t.id;

      const inMain: any = (await a.tasks.list({})).find(x => x.id === t.id);
      const inTab: any = (await a.tasks.list({ clientId: client.id })).find(x => x.id === t.id);
      for (const row of [inMain, inTab]) {
        expect(row).toBeTruthy();
        expect(row.clientName).toBe(`MCtx ${stamp}`);     // client context on the card
        expect(row.matterReference).toBe(`MS-${stamp}`);  // matter context on the card
        expect(row.clientMatterId).toBe(matter.id);
      }
    } finally {
      if (taskId) await a.tasks.delete({ id: taskId });
      await a.clientMatters.delete({ id: matter.id });
      await a.clients.delete({ id: client.id });
    }
  });

  it("a client-level task (no matter) is labelled by absence of clientMatterId in both views", async () => {
    const a = admin();
    const stamp = Date.now();
    const client = await a.clients.create({ clientName: `CLvl ${stamp}`, clientStatus: "Existing Client" });
    let taskId: number | undefined;
    try {
      const t = await a.tasks.create({ title: `Client-level ${stamp}`, clientId: client.id });
      taskId = t.id;
      const inMain: any = (await a.tasks.list({})).find(x => x.id === t.id);
      const inTab: any = (await a.tasks.list({ clientId: client.id })).find(x => x.id === t.id);
      expect(inMain.clientMatterId == null).toBe(true);
      expect(inTab.clientMatterId == null).toBe(true);
      expect(inMain.clientName).toBe(`CLvl ${stamp}`);
    } finally {
      if (taskId) await a.tasks.delete({ id: taskId });
      await a.clients.delete({ id: client.id });
    }
  });

  it("updating status reflects in BOTH views (one record, both directions)", async () => {
    const a = admin();
    const stamp = Date.now();
    const client = await a.clients.create({ clientName: `Upd ${stamp}`, clientStatus: "Existing Client" });
    let taskId: number | undefined;
    try {
      const t = await a.tasks.create({ title: `Status sync ${stamp}`, clientId: client.id, status: "todo" });
      taskId = t.id;

      // Simulate "changed from the client tab".
      await a.tasks.update({ id: t.id, status: "done" });
      const main1: any = (await a.tasks.list({})).find(x => x.id === t.id);
      const tab1: any = (await a.tasks.list({ clientId: client.id })).find(x => x.id === t.id);
      expect(main1.status).toBe("done");
      expect(tab1.status).toBe("done");

      // Simulate "changed from the main page".
      await a.tasks.update({ id: t.id, status: "in_progress" });
      const main2: any = (await a.tasks.list({})).find(x => x.id === t.id);
      const tab2: any = (await a.tasks.list({ clientId: client.id })).find(x => x.id === t.id);
      expect(main2.status).toBe("in_progress");
      expect(tab2.status).toBe("in_progress");
    } finally {
      if (taskId) await a.tasks.delete({ id: taskId });
      await a.clients.delete({ id: client.id });
    }
  });

  it("deleting a task from one view removes it from the other", async () => {
    const a = admin();
    const stamp = Date.now();
    const client = await a.clients.create({ clientName: `Del ${stamp}`, clientStatus: "Existing Client" });
    const t = await a.tasks.create({ title: `To delete ${stamp}`, clientId: client.id });
    try {
      await a.tasks.delete({ id: t.id }); // "deleted from the main page"
      const main = await a.tasks.list({});
      const tab = await a.tasks.list({ clientId: client.id });
      expect(main.some(x => x.id === t.id)).toBe(false);
      expect(tab.some(x => x.id === t.id)).toBe(false);
      expect(await a.tasks.get({ id: t.id })).toBeNull();
    } finally {
      await a.clients.delete({ id: client.id });
    }
  });

  it("Task Details (tasks.get) returns the SAME record referenced by both lists", async () => {
    const a = admin();
    const stamp = Date.now();
    const client = await a.clients.create({ clientName: `Det ${stamp}`, clientStatus: "Existing Client" });
    let taskId: number | undefined;
    try {
      const t = await a.tasks.create({ title: `Detail open ${stamp}`, clientId: client.id });
      taskId = t.id;
      const fromMain: any = (await a.tasks.list({})).find(x => x.id === t.id);
      const fromTab: any = (await a.tasks.list({ clientId: client.id })).find(x => x.id === t.id);
      const detail: any = await a.tasks.get({ id: t.id });
      expect(fromMain.id).toBe(detail.id);
      expect(fromTab.id).toBe(detail.id);
      expect(detail.clientId).toBe(client.id);
    } finally {
      if (taskId) await a.tasks.delete({ id: taskId });
      await a.clients.delete({ id: client.id });
    }
  });

  it("a task auto-created from an Action Log carries its source_type in the list", async () => {
    const a = admin();
    const stamp = Date.now();
    const client = await a.clients.create({ clientName: `Src ${stamp}`, clientStatus: "Existing Client" });
    try {
      // An action log with a nextStep upserts a linked task (one-to-one — no dupes).
      const log = await a.clientActions.create({
        clientId: client.id,
        actionType: "Call",
        nextStep: `Follow up ${stamp}`,
      });
      const tab: any[] = await a.tasks.list({ clientId: client.id });
      const synced = tab.find(x => x.clientActionLogId === log.id);
      expect(synced).toBeTruthy();
      expect(synced.sourceType).toBe("Call");   // provenance shown clearly
      expect(synced.sourceId).toBe(log.id);
      if (synced) await a.tasks.delete({ id: synced.id });
    } finally {
      await a.clients.delete({ id: client.id }); // cascades the action log
    }
  });

  it("unauthorized users cannot see another user's client task in either view", async () => {
    const a = admin();
    const stamp = Date.now();
    const lawyer = await a.users.create({ name: `NoSee ${stamp}`, email: `nosee${stamp}@x.com`, password: PW, role: "lawyer" });
    const other = await a.users.create({ name: `Owner ${stamp}`, email: `owner${stamp}@x.com`, password: PW, role: "lawyer" });
    const client = await a.clients.create({ clientName: `Restricted ${stamp}`, clientStatus: "Existing Client" });
    let taskId: number | undefined;
    try {
      const t = await a.tasks.create({ title: `Restricted ${stamp}`, clientId: client.id, assignedTo: other.id });
      taskId = t.id;

      const asLawyer = callerFor("lawyer", lawyer.id);
      // Not in the main list, not in the client tab, and details return null.
      expect((await asLawyer.tasks.list({})).some(x => x.id === t.id)).toBe(false);
      expect((await asLawyer.tasks.list({ clientId: client.id })).some(x => x.id === t.id)).toBe(false);
      expect(await asLawyer.tasks.get({ id: t.id })).toBeNull();
    } finally {
      if (taskId) await a.tasks.delete({ id: taskId });
      await a.clients.delete({ id: client.id });
      for (const u of [lawyer, other]) await a.users.delete({ userId: u.id });
    }
  }, 30000);
});
