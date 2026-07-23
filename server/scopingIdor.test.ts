/**
 * Phase 4 — actor-aware DB scoping & IDOR prevention.
 *
 * Exercises scoping through the tRPC API with a TARGET-role actor
 * (senior_associate → clients/matters:view = ASSIGNED) whose access must be
 * limited to records assigned to them, and confirms Admin (ALL) sees everything.
 *
 * These tests write to the LOCAL disposable Docker DB only. senior_associate is
 * an in-memory ctx role (accounts are not migrated); the DB rows it filters on
 * are real assignment FKs. The migrated read routes use capabilityProcedure, so a
 * target role can reach the (scoped) resolver — under the legacy permissionProcedure
 * gate it would be denied outright.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
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
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}
const admin = () => callerFor("admin", 1);

const PW = "Passw0rd123";
let lawyerAId = 0, lawyerBId = 0;
let clientAId = 0, clientBId = 0;
let matterAId = 0, matterBId = 0;
let nameA = "", nameB = "";

beforeAll(async () => {
  const a = admin();
  const stamp = Date.now();
  nameA = `ScopeA ${stamp}`;
  nameB = `ScopeB ${stamp}`;
  const la = await a.users.create({ name: `LawA ${stamp}`, email: `lawa-${stamp}@x.com`, password: PW, role: "lawyer" });
  const lb = await a.users.create({ name: `LawB ${stamp}`, email: `lawb-${stamp}@x.com`, password: PW, role: "lawyer" });
  lawyerAId = la.id; lawyerBId = lb.id;

  const ca = await a.clients.create({ clientName: nameA, clientStatus: "Existing Client" });
  const cb = await a.clients.create({ clientName: nameB, clientStatus: "Existing Client" });
  clientAId = ca.id; clientBId = cb.id;

  const ma = await a.clientMatters.create({ clientId: ca.id, matterType: "Litigation", matterReference: `MRA-${stamp}`, acknowledgeConflicts: true });
  const mb = await a.clientMatters.create({ clientId: cb.id, matterType: "Litigation", matterReference: `MRB-${stamp}`, acknowledgeConflicts: true });
  matterAId = ma.id; matterBId = mb.id;

  // Assign lawyerA to matterA and lawyerB to matterB directly (test fixture —
  // bypasses assignment-eligibility validation, which is not under test here).
  await getDb().update(clientMatters).set({ leadLawyerId: lawyerAId }).where(eq(clientMatters.id, matterAId));
  await getDb().update(clientMatters).set({ leadLawyerId: lawyerBId }).where(eq(clientMatters.id, matterBId));
});

afterAll(async () => {
  const a = admin();
  for (const id of [matterAId, matterBId]) if (id) await a.clientMatters.delete({ id }).catch(() => {});
  for (const id of [clientAId, clientBId]) if (id) await a.clients.delete({ id }).catch(() => {});
  for (const id of [lawyerAId, lawyerBId]) if (id) await a.users.delete({ userId: id }).catch(() => {});
});

describe("clients list & get-by-ID IDOR (ASSIGNED scope)", () => {
  it("assigned lawyer's client list includes only their client", async () => {
    const scoped = callerFor("senior_associate", lawyerAId);
    const list = await scoped.clients.list({});
    const ids = new Set(list.map(c => c.id));
    expect(ids.has(clientAId)).toBe(true);
    expect(ids.has(clientBId)).toBe(false); // cross-user client hidden
  });

  it("get-by-ID enforces the same scope (no IDOR via direct id)", async () => {
    const scoped = callerFor("senior_associate", lawyerAId);
    expect(await scoped.clients.get({ id: clientAId })).toBeTruthy();
    expect(await scoped.clients.get({ id: clientBId })).toBeNull(); // not enumerable
  });

  it("Admin (ALL) sees both clients", async () => {
    const a = admin();
    const ids = new Set((await a.clients.list({})).map(c => c.id));
    expect(ids.has(clientAId)).toBe(true);
    expect(ids.has(clientBId)).toBe(true);
    expect(await a.clients.get({ id: clientBId })).toBeTruthy();
  });
});

describe("nested matters IDOR (ASSIGNED scope)", () => {
  it("assigned lawyer sees only their matter in listAll / get / per-client list", async () => {
    const scoped = callerFor("senior_associate", lawyerAId);
    const all = new Set((await scoped.clientMatters.listAll({})).map(m => m.id));
    expect(all.has(matterAId)).toBe(true);
    expect(all.has(matterBId)).toBe(false);

    expect(await scoped.clientMatters.get({ id: matterAId })).toBeTruthy();
    expect(await scoped.clientMatters.get({ id: matterBId })).toBeNull();

    // Even naming the owning client, the unassigned matter is not returned.
    const bMatters = await scoped.clientMatters.list({ clientId: clientBId });
    expect(bMatters.find(m => m.id === matterBId)).toBeUndefined();
  });
});

describe("search / conflict-check leakage (ASSIGNED scope)", () => {
  it("conflict search does not surface an out-of-scope client, but does surface an in-scope one", async () => {
    const scoped = callerFor("senior_associate", lawyerAId);
    const hitsB = await scoped.clients.conflictCheck({ query: nameB });
    expect(hitsB.some(h => h.clientId === clientBId)).toBe(false); // no leak
    const hitsA = await scoped.clients.conflictCheck({ query: nameA });
    expect(hitsA.some(h => h.clientId === clientAId)).toBe(true); // own client found
  });

  it("Admin conflict search surfaces both", async () => {
    const a = admin();
    expect((await a.clients.conflictCheck({ query: nameB })).some(h => h.clientId === clientBId)).toBe(true);
  });
});

describe("mutation scope guard (IDOR primitive)", () => {
  it("re-fetch under scope hides an inaccessible record, so a mutation guard would NOT_FOUND", async () => {
    const scopedActor = { id: lawyerAId, role: "senior_associate", status: "active" };
    // The router mutation path calls these under the caller's scope; a null result
    // becomes a NOT_FOUND before any write.
    expect(await db.getClientById(clientBId, scopedActor)).toBeNull();
    expect(await db.getClientMatterById(matterBId, scopedActor)).toBeNull();
    // In-scope records remain reachable.
    expect(await db.getClientById(clientAId, scopedActor)).toBeTruthy();
    expect(await db.getClientMatterById(matterAId, scopedActor)).toBeTruthy();
  });
});

describe("fail-closed for scopes that cannot yet be derived", () => {
  it("a role without matters:view gets zero matters (DENY), never a leak", async () => {
    // viewer has no matters:view → scope resolves to none → empty, not everything.
    const viewerActor = { id: 999999, role: "viewer", status: "active" };
    expect(await db.getAllMatters(viewerActor)).toEqual([]);
  });

  it("aggregate/scoped-list consistency: scoped client list count reflects only assigned", async () => {
    const scoped = callerFor("senior_associate", lawyerAId);
    const list = await scoped.clients.list({});
    // Every returned client must be one the actor is assigned to (here: clientA).
    expect(list.every(c => c.id !== clientBId)).toBe(true);
    expect(list.some(c => c.id === clientAId)).toBe(true);
  });
});
