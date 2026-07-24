/**
 * Phase 8 — task authorization: view scope, distinct edit / assign / delete
 * authority, assignee validation, reassignment control and dashboard consistency.
 *
 * Target account roles (senior_associate, associate, head_of_practice, coordinator,
 * …) are exercised directly. A couple of tests set a user's role/status via the DB
 * to model states the create-user API does not expose (a target-role assignee, an
 * inactive user).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import { getDb } from "./db";
import { users, clientMatters, tasks, auditLogs } from "../drizzle/schema";

type AuthedUser = NonNullable<TrpcContext["user"]>;
function callerFor(role: string, id: number) {
  const user: AuthedUser = {
    id, openId: `t-${id}`, email: `u${id}@x.com`, name: `U${id}`,
    loginMethod: "manus", role: role as any, status: "active",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return appRouter.createCaller({
    user, req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}
const admin = () => callerFor("admin", 1);
const PW = "Passw0rd123";

let ownerId = 0, otherId = 0, leadId = 0, inactiveId = 0, viewerId = 0, scopedId = 0;
let managerId = 0, financeId = 0;
let clientId = 0, matterLed = 0;
let tOwned = 0, tOther = 0, tLed = 0;

beforeAll(async () => {
  const a = admin();
  const s = Date.now();
  const mk = async (label: string) =>
    (await a.users.create({ name: `${label} ${s}`, email: `${label}-${s}@x.com`, password: PW, role: "lawyer" })).id;
  ownerId = await mk("owner");
  otherId = await mk("other");
  leadId = await mk("lead");
  inactiveId = await mk("inact");
  scopedId = await mk("scoped");
  managerId = await mk("manager");
  financeId = await mk("finance");
  viewerId = (await a.users.create({ name: `vw ${s}`, email: `vw-${s}@x.com`, password: PW, role: "viewer" })).id;

  // Model states the create-user API does not expose.
  await getDb().update(users).set({ status: "inactive" }).where(eq(users.id, inactiveId));
  await getDb().update(users).set({ role: "senior_associate" as any }).where(eq(users.id, scopedId));
  await getDb().update(users).set({ role: "manager" }).where(eq(users.id, managerId));
  await getDb().update(users).set({ role: "finance" }).where(eq(users.id, financeId));

  const c = await a.clients.create({ clientName: `TClient ${s}`, clientStatus: "Existing Client" });
  clientId = c.id;
  const m = await a.clientMatters.create({ clientId, matterType: "Litigation", matterReference: `TL-${s}`, acknowledgeConflicts: true });
  matterLed = m.id;
  await getDb().update(clientMatters).set({ leadLawyerId: leadId }).where(eq(clientMatters.id, matterLed));

  tOwned = (await a.tasks.create({ title: `owned ${s}`, clientId, assignedTo: ownerId })).id;
  tOther = (await a.tasks.create({ title: `other ${s}`, clientId, assignedTo: otherId })).id;
  tLed   = (await a.tasks.create({ title: `led ${s}`, clientId, clientMatterId: matterLed, assignedTo: otherId })).id;
});

afterAll(async () => {
  const a = admin();
  for (const id of [tOwned, tOther, tLed]) if (id) await a.tasks.delete({ id }).catch(() => {});
  if (matterLed) await a.clientMatters.delete({ id: matterLed }).catch(() => {});
  if (clientId) await a.clients.delete({ id: clientId }).catch(() => {});
  for (const id of [ownerId, otherId, leadId, inactiveId, viewerId, scopedId, managerId, financeId]) if (id) await a.users.delete({ userId: id }).catch(() => {});
});

const ids = (rows: { id: number }[]) => new Set(rows.map(r => r.id));

describe("view scope per approved role", () => {
  it("ALL-scope roles (admin/manager/head_of_practice/coordinator) see every task", async () => {
    for (const c of [admin(), callerFor("manager", 1), callerFor("head_of_practice", 90001), callerFor("coordinator", 90002)]) {
      const seen = ids(await c.tasks.list({}));
      expect(seen.has(tOwned) && seen.has(tOther) && seen.has(tLed)).toBe(true);
    }
  });

  it("OWN-scope roles see only their assigned tasks (assignee, never creator)", async () => {
    const senior = ids(await callerFor("senior_associate", ownerId).tasks.list({}));
    expect(senior.has(tOwned)).toBe(true);
    expect(senior.has(tOther)).toBe(false);
    expect(senior.has(tLed)).toBe(false);
    const assoc = ids(await callerFor("associate", ownerId).tasks.list({}));
    expect(assoc.has(tOwned)).toBe(true);
    expect(assoc.has(tOther)).toBe(false);
  });

  it("Lead Lawyer sees tasks OF their designated matter, not others", async () => {
    const lead = ids(await callerFor("associate", leadId).tasks.list({})); // associate base sees own; overlay adds led matter
    expect(lead.has(tLed)).toBe(true);
    expect(lead.has(tOwned)).toBe(false);
    expect(lead.has(tOther)).toBe(false);
  });

  it("cross-user IDOR: an OWN-scope viewer cannot read another user's task by id", async () => {
    const senior = callerFor("senior_associate", ownerId);
    expect(await senior.tasks.get({ id: tOther })).toBeNull();
    expect(await senior.tasks.get({ id: tLed })).toBeNull();
  });
});

describe("own status update vs reassignment escalation", () => {
  it("an OWN role with no assign authority updates its status but cannot reassign", async () => {
    const assoc = callerFor("associate", ownerId);
    const upd = await assoc.tasks.update({ id: tOwned, status: "in_progress" });
    expect(upd.status).toBe("in_progress");
    await expect(assoc.tasks.update({ id: tOwned, assignedTo: otherId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a role with tasks:assign may reassign its own task, and the change is audited", async () => {
    const senior = callerFor("senior_associate", ownerId);
    const upd = await senior.tasks.update({ id: tOwned, assignedTo: otherId });
    expect(upd.assignedTo).toBe(otherId);
    const log = await getDb().select().from(auditLogs)
      .where(and(eq(auditLogs.entityType, "task"), eq(auditLogs.entityId, tOwned)));
    expect(log.some(l => l.action === "assigned")).toBe(true);
    // Restore for later tests / afterAll.
    await admin().tasks.update({ id: tOwned, assignedTo: ownerId });
  });
});

describe("assignee validation (§G)", () => {
  it("rejects a nonexistent, inactive, or ineligible-role assignee", async () => {
    const a = admin();
    await expect(a.tasks.create({ title: "x", clientId, assignedTo: 99999999 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.tasks.create({ title: "x", clientId, assignedTo: inactiveId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.tasks.create({ title: "x", clientId, assignedTo: viewerId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.tasks.create({ title: "x", clientId, assignedTo: managerId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.tasks.create({ title: "x", clientId, assignedTo: financeId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("ALL and non-ALL assigners cannot grant target access through assignment", async () => {
    // Lead Lawyer of matterLed (associate base has no assign; overlay grants it).
    const leadCaller = callerFor("associate", leadId);
    // scopedId is a senior_associate (matters:view ASSIGNED) NOT on matterLed → blocked.
    await expect(admin().tasks.update({ id: tLed, assignedTo: scopedId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(leadCaller.tasks.update({ id: tLed, assignedTo: scopedId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Put scopedId on the matter → now reachable.
    await getDb().update(clientMatters).set({ attorney1Id: scopedId }).where(eq(clientMatters.id, matterLed));
    try {
      const upd = await leadCaller.tasks.update({ id: tLed, assignedTo: scopedId });
      expect(upd.assignedTo).toBe(scopedId);
    } finally {
      await getDb().update(clientMatters).set({ attorney1Id: null }).where(eq(clientMatters.id, matterLed));
      await admin().tasks.update({ id: tLed, assignedTo: otherId });
    }
  });
});

describe("task create relationship integrity", () => {
  it("rejects a matter that belongs to a different client", async () => {
    const a = admin();
    const otherClient = await a.clients.create({
      clientName: `Task mismatch ${Date.now()}`,
      clientStatus: "Existing Client",
    });
    try {
      await expect(a.tasks.create({
        title: "mismatched matter",
        clientId: otherClient.id,
        clientMatterId: matterLed,
      })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await a.clients.delete({ id: otherClient.id });
    }
  });

  it("rejects forged or cross-client Action Log provenance", async () => {
    const a = admin();
    const otherClient = await a.clients.create({
      clientName: `Task source ${Date.now()}`,
      clientStatus: "Existing Client",
    });
    const action = await a.clientActions.create({
      clientId: otherClient.id,
      actionType: "Call",
      actionDetails: "Different client",
    });
    try {
      await expect(a.tasks.create({
        title: "forged source",
        clientId,
        sourceType: "action_log",
        sourceId: action.id,
        clientActionLogId: action.id,
      })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await a.clients.delete({ id: otherClient.id });
    }
  });
});

describe("create authority follows the matrix", () => {
  it("Head of Practice may create; OWN roles and Coordinator (no tasks:create) cannot", async () => {
    const hop = callerFor("head_of_practice", leadId); // real user id (task.created_by FK)
    const t = await hop.tasks.create({ title: `hop ${Date.now()}`, clientId, assignedTo: ownerId });
    expect(t).toHaveProperty("id");
    await admin().tasks.delete({ id: t.id });
    await expect(callerFor("senior_associate", ownerId).tasks.create({ title: "x", clientId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor("coordinator", 90004).tasks.create({ title: "x", clientId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("deletion is a distinct authority (Admin only among target roles)", () => {
  it("non-admin target roles cannot delete; Admin can", async () => {
    for (const role of ["manager", "head_of_practice", "coordinator", "senior_associate"]) {
      await expect(callerFor(role, ownerId).tasks.delete({ id: tOwned })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const throwaway = (await admin().tasks.create({ title: `tmp ${Date.now()}`, clientId })).id;
    await expect(admin().tasks.delete({ id: throwaway })).resolves.toMatchObject({ success: true });
  });
});

describe("dashboard / list / detail consistency", () => {
  it("pendingTasks count equals the visible non-done task count for the same viewer", async () => {
    const viewer = { id: ownerId, role: "senior_associate" };
    const visible = await db.getAllTasks({}, viewer);
    const pendingVisible = visible.filter(t => t.status !== "done").length;
    const stats = await db.getDashboardStats(viewer);
    expect(stats.pendingTasks).toBe(pendingVisible);
  });
});
