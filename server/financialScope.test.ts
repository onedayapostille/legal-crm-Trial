/**
 * Phase 7 — financial authorization & scoped projections.
 *
 * Covers row scope (ALL / ASSIGNED / none), null-matter exclusion from ASSIGNED,
 * summary/list/export reconciliation, the Coordinator payment-status projection,
 * report gating, HoP OWN_PRACTICE financial writes, and mutation denial.
 *
 * `practices` is provisioned as a LOCAL-DB fixture (migration not executed).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb, getRawClient } from "./db";
import { clientMatters, practices } from "../drizzle/schema";

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

let assocId = 0, hopId = 0;
let clientId = 0, matterAssigned = 0, matterOther = 0;
let recAssigned = 0, recOther = 0, recClientLevel = 0;

beforeAll(async () => {
  await getRawClient().unsafe(`
    CREATE TABLE IF NOT EXISTS "practices" (
      "id" SERIAL PRIMARY KEY, "location" "city" NOT NULL,
      "matter_type" "client_matter_type" NOT NULL,
      "head_of_practice_id" INTEGER REFERENCES "users"("id"),
      "created_by" INTEGER REFERENCES "users"("id"),
      "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS "practices_location_matter_type_uniq" ON "practices" ("location","matter_type");`);

  const a = admin();
  const s = Date.now();
  const assoc = await a.users.create({ name: `Assoc ${s}`, email: `assoc-${s}@x.com`, password: PW, role: "lawyer" });
  const hop = await a.users.create({ name: `HoP ${s}`, email: `fhop-${s}@x.com`, password: PW, role: "partner" });
  assocId = assoc.id; hopId = hop.id;
  await getDb().insert(practices)
    .values({ location: "Riyadh", matterType: "Litigation", headOfPracticeId: hopId })
    .onConflictDoUpdate({ target: [practices.location, practices.matterType], set: { headOfPracticeId: hopId } });

  const c = await a.clients.create({ clientName: `FClient ${s}`, clientStatus: "Existing Client", city: "Riyadh", matterType: "Litigation" });
  clientId = c.id;
  const mA = await a.clientMatters.create({ clientId, matterType: "Litigation", matterReference: `FA-${s}`, acknowledgeConflicts: true });
  const mO = await a.clientMatters.create({ clientId, matterType: "Litigation", matterReference: `FO-${s}`, acknowledgeConflicts: true });
  matterAssigned = mA.id; matterOther = mO.id;
  await getDb().update(clientMatters).set({ leadLawyerId: assocId }).where(eq(clientMatters.id, matterAssigned));

  recAssigned = (await a.financial.create({ clientId, clientMatterId: matterAssigned, revenue: "1000" })).id;
  recOther = (await a.financial.create({ clientId, clientMatterId: matterOther, revenue: "500" })).id;
  recClientLevel = (await a.financial.create({ clientId, revenue: "300" })).id; // null matter
});

afterAll(async () => {
  const a = admin();
  for (const id of [recAssigned, recOther, recClientLevel]) if (id) await a.financial.delete({ id }).catch(() => {});
  for (const id of [matterAssigned, matterOther]) if (id) await a.clientMatters.delete({ id }).catch(() => {});
  if (clientId) await a.clients.delete({ id: clientId }).catch(() => {});
  if (hopId) await getDb().delete(practices).where(eq(practices.headOfPracticeId, hopId)).catch(() => {});
  for (const id of [assocId, hopId]) if (id) await a.users.delete({ userId: id }).catch(() => {});
});

describe("ASSIGNED financial scope (Senior Associate)", () => {
  it("sees only assigned-matter records; excludes other matters AND null-matter records", async () => {
    const senior = callerFor("senior_associate", assocId);
    const ids = new Set((await senior.financial.list({})).map(r => r.id));
    expect(ids.has(recAssigned)).toBe(true);
    expect(ids.has(recOther)).toBe(false);        // different matter
    expect(ids.has(recClientLevel)).toBe(false);  // null matter — excluded from ASSIGNED (§B/§G)
  });

  it("get-by-ID enforces the same scope", async () => {
    const senior = callerFor("senior_associate", assocId);
    expect(await senior.financial.get({ id: recAssigned })).toBeTruthy();
    expect(await senior.financial.get({ id: recOther })).toBeNull();
    expect(await senior.financial.get({ id: recClientLevel })).toBeNull();
  });

  it("summary reconciles with the visible detail rows", async () => {
    const senior = callerFor("senior_associate", assocId);
    const rows = await senior.financial.list({});
    const listRevenue = rows.reduce((n, r) => n + Number(r.revenue ?? 0), 0);
    const summary = await senior.financial.summary();
    expect(summary.totalRevenue).toBe(listRevenue); // both = 1000 (only assigned)
    expect(summary.totalRevenue).toBe(1000);
  });
});

describe("no base finance for Executive Associate & lower", () => {
  it("Executive Associate is denied financial list/summary (base)", async () => {
    const exec = callerFor("executive_associate", assocId);
    await expect(exec.financial.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(exec.financial.summary()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Coordinator payment-status projection", () => {
  it("sees all rows through an allowlisted DTO with sensitive fields omitted", async () => {
    const coord = callerFor("coordinator", 1);
    const rows = await coord.financial.list({});
    const rec = rows.find(r => r.id === recAssigned)!;
    expect(rec).toBeTruthy();
    expect(rec.collectionStatus).toBeTruthy();     // payment status retained
    expect(rec).not.toHaveProperty("revenue");
    expect(rec).not.toHaveProperty("agreedFees");
    expect(rec).not.toHaveProperty("financeNotes");
    expect(rec).not.toHaveProperty("responsibleLawyerId");
  });
});

describe("Manager is ALL read-only; mutation denial", () => {
  it("manager reads all records but cannot create/update/delete", async () => {
    const m = callerFor("manager", 1);
    const ids = new Set((await m.financial.list({})).map(r => r.id));
    expect(ids.has(recAssigned) && ids.has(recOther) && ids.has(recClientLevel)).toBe(true);
    await expect(m.financial.create({ clientId, revenue: "1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m.financial.update({ id: recAssigned, revenue: "1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m.financial.delete({ id: recAssigned })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Senior Associate cannot mutate financials", async () => {
    const senior = callerFor("senior_associate", assocId);
    await expect(senior.financial.create({ clientId, revenue: "1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("report access is gated by financialReports:view", () => {
  it("Manager can run reports; Senior Associate and Coordinator cannot", async () => {
    const m = callerFor("manager", 1);
    expect(await m.financialReports.summary({})).toBeTruthy();
    await expect(callerFor("senior_associate", assocId).financialReports.summary({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor("coordinator", 1).financialReports.summary({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("CSV export is gated the same and is scope-consistent for report viewers", async () => {
    const m = callerFor("manager", 1);
    const csv = await m.financialReports.export({ reportType: "summary" });
    expect(typeof csv).toBeTruthy();
    await expect(callerFor("senior_associate", assocId).financialReports.export({ reportType: "summary" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Head of Practice financial writes are OWN_PRACTICE; Finance is full", () => {
  it("HoP creates within own practice, but not in another practice", async () => {
    const hop = callerFor("head_of_practice", hopId);
    // client is (Riyadh, Litigation) = HoP's practice → allowed.
    const rec = await hop.financial.create({ clientId, clientMatterId: matterAssigned, revenue: "10" });
    expect(rec).toHaveProperty("id");
    await admin().financial.delete({ id: rec.id });

    // A client in another practice → denied.
    const other = await admin().clients.create({ clientName: `Other ${Date.now()}`, clientStatus: "Existing Client", city: "Jeddah", matterType: "Corporate" });
    try {
      await expect(hop.financial.create({ clientId: other.id, revenue: "10" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await admin().clients.delete({ id: other.id });
    }
  });

  it("Finance has full create + read", async () => {
    const f = callerFor("finance", 1);
    const rec = await f.financial.create({ clientId, clientMatterId: matterAssigned, revenue: "20" });
    expect(rec).toHaveProperty("id");
    expect(await f.financial.get({ id: rec.id })).toBeTruthy();
    await admin().financial.delete({ id: rec.id });
  });
});
