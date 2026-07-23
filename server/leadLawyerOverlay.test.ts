/**
 * Phase 6 — per-matter Lead Lawyer authority overlay.
 *
 * A user designated `client_matters.lead_lawyer_id` gains ADDITIVE, matter-
 * specific authority: view/edit-allowlisted matter details, read-only financial
 * records for that matter, and view/update/assign that matter's tasks — even when
 * their base role grants none of it (Executive Associate). Non-designated users
 * get nothing; removing the designation removes the overlay immediately.
 *
 * The same user id is exercised under two in-memory roles: `executive_associate`
 * (no base financial/matter edit — isolates the overlay) for financial/matter
 * paths, and legacy `lawyer` (reaches the tasks gate) for the task overlay.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { clientMatters } from "../drizzle/schema";

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

let leadId = 0, otherUserId = 0;
let clientId = 0, matterLed = 0, matterUnled = 0;
let recordLed = 0, taskInMatter = 0, taskUnrelated = 0;

async function setLead(matterId: number, userId: number | null) {
  await getDb().update(clientMatters).set({ leadLawyerId: userId }).where(eq(clientMatters.id, matterId));
}

beforeAll(async () => {
  const a = admin();
  const s = Date.now();
  const lead = await a.users.create({ name: `Lead ${s}`, email: `lead-${s}@x.com`, password: PW, role: "lawyer" });
  const other = await a.users.create({ name: `Other ${s}`, email: `other-${s}@x.com`, password: PW, role: "lawyer" });
  leadId = lead.id; otherUserId = other.id;

  const c = await a.clients.create({ clientName: `LLClient ${s}`, clientStatus: "Existing Client" });
  clientId = c.id;
  const mLed = await a.clientMatters.create({ clientId, matterType: "Litigation", matterReference: `LED-${s}`, acknowledgeConflicts: true });
  const mUnled = await a.clientMatters.create({ clientId, matterType: "Litigation", matterReference: `UNLED-${s}`, acknowledgeConflicts: true });
  matterLed = mLed.id; matterUnled = mUnled.id;
  await setLead(matterLed, leadId);       // designate lead over matterLed
  await setLead(matterUnled, otherUserId); // someone else leads the other matter

  const fr = await a.financial.create({ clientId, clientMatterId: matterLed, revenue: "1000" });
  recordLed = fr.id;

  // Tasks assigned to `other` (so the lead is neither assignee nor creator-by-self).
  const tIn = await callerFor("admin", otherUserId).tasks.create({ title: `TIn ${s}`, clientId, clientMatterId: matterLed, assignedTo: otherUserId });
  const tUn = await callerFor("admin", otherUserId).tasks.create({ title: `TUn ${s}`, clientId, clientMatterId: matterUnled, assignedTo: otherUserId });
  taskInMatter = tIn.id; taskUnrelated = tUn.id;
});

afterAll(async () => {
  const a = admin();
  for (const id of [taskInMatter, taskUnrelated]) if (id) await a.tasks.delete({ id }).catch(() => {});
  if (recordLed) await a.financial.delete({ id: recordLed }).catch(() => {});
  for (const id of [matterLed, matterUnled]) if (id) await a.clientMatters.delete({ id }).catch(() => {});
  if (clientId) await a.clients.delete({ id: clientId }).catch(() => {});
  for (const id of [leadId, otherUserId]) if (id) await a.users.delete({ userId: id }).catch(() => {});
});

describe("financial overlay (Executive Associate — matter-specific read)", () => {
  it("designated lead reads ONLY their matter's financials, never another's", async () => {
    const exec = callerFor("executive_associate", leadId);
    const recs = await exec.clientMatters.matterFinancials({ clientMatterId: matterLed });
    expect(recs.some(r => r.id === recordLed)).toBe(true);
    await expect(exec.clientMatters.matterFinancials({ clientMatterId: matterUnled })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("non-designated user is denied financial read", async () => {
    const stranger = callerFor("executive_associate", otherUserId); // leads matterUnled, not matterLed
    await expect(stranger.clientMatters.matterFinancials({ clientMatterId: matterLed })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("overlay NEVER grants financial mutation", async () => {
    const exec = callerFor("executive_associate", leadId);
    await expect(exec.financial.create({ clientId, clientMatterId: matterLed, revenue: "5" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(exec.financial.update({ id: recordLed, revenue: "5" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("matter view/edit overlay (allowlist)", () => {
  it("lead can edit an allowlisted detail field on their matter", async () => {
    const exec = callerFor("executive_associate", leadId);
    const updated = await exec.clientMatters.update({ id: matterLed, matterStatus: "Active" });
    expect(updated.matterStatus).toBe("Active");
  });

  it("lead CANNOT edit non-allowlisted fields (practice / assignment)", async () => {
    const exec = callerFor("executive_associate", leadId);
    await expect(exec.clientMatters.update({ id: matterLed, matterType: "Corporate" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(exec.clientMatters.update({ id: matterLed, leadLawyerId: otherUserId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lead cannot edit a matter they do not lead", async () => {
    const exec = callerFor("executive_associate", leadId);
    await expect(exec.clientMatters.update({ id: matterUnled, matterStatus: "Active" })).rejects.toBeTruthy();
  });
});

describe("related client excludes unrelated matters/financials", () => {
  it("lead sees only their matter under the shared client, not the co-client's other matter", async () => {
    const exec = callerFor("executive_associate", leadId);
    const matters = await exec.clientMatters.list({ clientId });
    const ids = new Set(matters.map(m => m.id));
    expect(ids.has(matterLed)).toBe(true);
    expect(ids.has(matterUnled)).toBe(false); // unrelated matter of the same client hidden
    await expect(exec.clientMatters.matterFinancials({ clientMatterId: matterUnled })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("task overlay (view / update / assign that matter's tasks)", () => {
  it("lead sees & updates their matter's task but not an unrelated task", async () => {
    const lead = callerFor("lawyer", leadId); // lawyer reaches the tasks gate; base sees only own
    const visible = new Set((await lead.tasks.list({})).map(t => t.id));
    expect(visible.has(taskInMatter)).toBe(true);  // overlay: task of a led matter
    expect(visible.has(taskUnrelated)).toBe(false); // not led, not own
    // Update + reassign the matter's task (overlay grants tasks:edit/assign).
    // Assign to admin (id 1), NOT to the lead — otherwise the task becomes the
    // lead's "own" and would stay visible after the designation is removed.
    const upd = await lead.tasks.update({ id: taskInMatter, status: "done", assignedTo: 1 });
    expect(upd).toBeTruthy();
    // Cannot touch an unrelated task.
    await expect(lead.tasks.update({ id: taskUnrelated, status: "done" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("designation security", () => {
  it("self-designation via generic create is denied without assign authority", async () => {
    const lawyer = callerFor("lawyer", leadId); // has clients:manage (reaches create) but not matters:assign_lawyer
    const s = Date.now();
    await expect(
      lawyer.clientMatters.create({ clientId, matterType: "Litigation", matterReference: `SELF-${s}`, leadLawyerId: leadId, acknowledgeConflicts: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("generic update cannot change the designation without assign authority", async () => {
    // A base manager (lawyer) still cannot flip leadLawyerId (Phase-1 guard).
    const lawyer = callerFor("lawyer", 1);
    await expect(lawyer.clientMatters.update({ id: matterLed, leadLawyerId: otherUserId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("removing designation removes the overlay immediately", () => {
  it("once un-designated, the former lead loses financial + task access", async () => {
    await setLead(matterLed, otherUserId); // reassign away from `leadId`
    try {
      const exec = callerFor("executive_associate", leadId);
      await expect(exec.clientMatters.matterFinancials({ clientMatterId: matterLed })).rejects.toMatchObject({ code: "FORBIDDEN" });
      const lead = callerFor("lawyer", leadId);
      const visible = new Set((await lead.tasks.list({})).map(t => t.id));
      expect(visible.has(taskInMatter)).toBe(false); // overlay gone
    } finally {
      await setLead(matterLed, leadId); // restore for afterAll symmetry
    }
  });
});
