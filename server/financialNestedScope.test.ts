/**
 * Phase 7 — financial authorization: nested matter responses, scoped aggregates,
 * rate capabilities and payment capabilities.
 *
 * Complements financialScope.test.ts (which covers financial.list/get/summary/
 * report/export). Here we exercise the paths that previously leaked or ran on the
 * deprecated permission bridge:
 *   - clientMatters.matterFinancials  → ASSIGNED viewers must not read a matter
 *                                        they are NOT assigned to (was an IDOR).
 *   - financial.toBeBilledBreakdown    → grouped aggregate must honor actor scope.
 *   - matterLawyerRates / billableLawyers → dedicated rates:* capabilities +
 *                                        ASSIGNED matter scope + HoP OWN_PRACTICE.
 *   - payments                          → dedicated payments:view/create/edit.
 *
 * `practices` is provisioned as a LOCAL-DB fixture (migration not executed).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb, getRawClient } from "./db";
import { clientMatters, practices, payments as paymentsTable } from "../drizzle/schema";

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

let assocId = 0, strangerId = 0, hopId = 0, rateUserId = 0;
let clientId = 0, matterAssigned = 0, matterOther = 0;
let recAssigned = 0, recOther = 0;
let seededRateId = 0;

beforeAll(async () => {
  // Local-DB practices fixture (additive migration not executed in tests).
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
  const assoc   = await a.users.create({ name: `NAssoc ${s}`,   email: `nassoc-${s}@x.com`,   password: PW, role: "lawyer" });
  const stranger= await a.users.create({ name: `NStr ${s}`,     email: `nstr-${s}@x.com`,     password: PW, role: "lawyer" });
  const hop     = await a.users.create({ name: `NHoP ${s}`,     email: `nhop-${s}@x.com`,     password: PW, role: "partner" });
  const rateU   = await a.users.create({ name: `NRateU ${s}`,   email: `nrateu-${s}@x.com`,   password: PW, role: "lawyer" });
  assocId = assoc.id; strangerId = stranger.id; hopId = hop.id; rateUserId = rateU.id;

  // This file's practice: (Jeddah, Corporate) → hop is its head. Kept distinct
  // from financialScope.test.ts's (Riyadh, Litigation) so the two never collide.
  await getDb().insert(practices)
    .values({ location: "Jeddah", matterType: "Corporate", headOfPracticeId: hopId })
    .onConflictDoUpdate({ target: [practices.location, practices.matterType], set: { headOfPracticeId: hopId } });

  const c = await a.clients.create({ clientName: `NClient ${s}`, clientStatus: "Existing Client", city: "Jeddah", matterType: "Corporate" });
  clientId = c.id;
  const mA = await a.clientMatters.create({ clientId, matterType: "Corporate", matterReference: `NA-${s}`, acknowledgeConflicts: true });
  const mO = await a.clientMatters.create({ clientId, matterType: "Corporate", matterReference: `NO-${s}`, acknowledgeConflicts: true });
  matterAssigned = mA.id; matterOther = mO.id;
  await getDb().update(clientMatters).set({ leadLawyerId: assocId }).where(eq(clientMatters.id, matterAssigned));

  // To-Be-Billed = max(0, netFees − revenue); N/A discount ⇒ netFees == agreedFees.
  recAssigned = (await a.financial.create({ clientId, clientMatterId: matterAssigned, agreedFees: "2000", revenue: "500" })).id; // tbb 1500
  recOther    = (await a.financial.create({ clientId, clientMatterId: matterOther,    agreedFees: "1000", revenue: "0"   })).id; // tbb 1000

  seededRateId = (await a.matterLawyerRates.create({ clientMatterId: matterAssigned, userId: rateUserId, hourlyRate: "300" })).id;
});

afterAll(async () => {
  const a = admin();
  if (seededRateId) await a.matterLawyerRates.delete({ id: seededRateId }).catch(() => {});
  for (const id of [recAssigned, recOther]) if (id) await a.financial.delete({ id }).catch(() => {});
  for (const id of [matterAssigned, matterOther]) if (id) await a.clientMatters.delete({ id }).catch(() => {});
  if (clientId) await a.clients.delete({ id: clientId }).catch(() => {});
  if (hopId) await getDb().delete(practices).where(eq(practices.headOfPracticeId, hopId)).catch(() => {});
  for (const id of [assocId, strangerId, hopId, rateUserId]) if (id) await a.users.delete({ userId: id }).catch(() => {});
});

describe("clientMatters.matterFinancials — ASSIGNED viewers cannot read a matter they are not assigned to", () => {
  it("assigned Senior Associate reads only their matter; an unassigned matter yields no rows", async () => {
    const senior = callerFor("senior_associate", assocId);
    const led = await senior.clientMatters.matterFinancials({ clientMatterId: matterAssigned });
    expect(led.some(r => r.id === recAssigned)).toBe(true);
    // The IDOR fix: an assigned viewer querying a DIFFERENT matter gets nothing,
    // never that matter's records.
    const other = await senior.clientMatters.matterFinancials({ clientMatterId: matterOther });
    expect(other.some(r => r.id === recOther)).toBe(false);
  });

  it("a Senior Associate assigned to NOTHING cannot read an arbitrary matter", async () => {
    const stranger = callerFor("senior_associate", strangerId);
    const rows = await stranger.clientMatters.matterFinancials({ clientMatterId: matterAssigned });
    expect(rows.some(r => r.id === recAssigned)).toBe(false);
  });

  it("ALL-scope Finance reads any matter's records", async () => {
    const f = callerFor("finance", 1);
    const rows = await f.clientMatters.matterFinancials({ clientMatterId: matterOther });
    expect(rows.some(r => r.id === recOther)).toBe(true);
  });
});

describe("financial.toBeBilledBreakdown — grouped aggregate honors actor scope", () => {
  it("Senior Associate sees only their assigned matter's To-Be-Billed", async () => {
    const senior = callerFor("senior_associate", assocId);
    const b = await senior.financial.toBeBilledBreakdown();
    const assigned = b.byMatter.find(m => m.clientMatterId === matterAssigned);
    const other = b.byMatter.find(m => m.clientMatterId === matterOther);
    expect(assigned?.toBeBilled).toBe(1500);
    expect(other).toBeUndefined();                 // unassigned matter excluded
    const client = b.byClient.find(c => c.clientId === clientId);
    expect(client?.toBeBilled).toBe(1500);         // only the assigned contribution
  });

  it("Finance (ALL) sees both matters and the full client total", async () => {
    const f = callerFor("finance", 1);
    const b = await f.financial.toBeBilledBreakdown();
    expect(b.byMatter.find(m => m.clientMatterId === matterAssigned)?.toBeBilled).toBe(1500);
    expect(b.byMatter.find(m => m.clientMatterId === matterOther)?.toBeBilled).toBe(1000);
    expect(b.byClient.find(c => c.clientId === clientId)?.toBeBilled).toBe(2500);
  });
});

describe("matter rates — dedicated rates:* capabilities + ASSIGNED scope", () => {
  it("ALL-scope viewers (finance) read any matter's rates", async () => {
    const f = callerFor("finance", 1);
    const rows = await f.matterLawyerRates.list({ clientMatterId: matterAssigned });
    expect(rows.some(r => r.id === seededRateId)).toBe(true);
  });

  it("ASSIGNED viewer reads their matter's rates only; an unassigned matter yields none", async () => {
    const senior = callerFor("senior_associate", assocId);
    expect((await senior.matterLawyerRates.list({ clientMatterId: matterAssigned })).some(r => r.id === seededRateId)).toBe(true);
    expect(await senior.matterLawyerRates.list({ clientMatterId: matterOther })).toEqual([]);
    // A Senior Associate assigned to nothing sees no rates on any matter.
    expect(await callerFor("senior_associate", strangerId).matterLawyerRates.list({ clientMatterId: matterAssigned })).toEqual([]);
  });

  it("roles without rates:view are denied (legacy lawyer/staff, Coordinator)", async () => {
    await expect(callerFor("lawyer", assocId).matterLawyerRates.list({ clientMatterId: matterAssigned })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor("staff", 1).matterLawyerRates.list({ clientMatterId: matterAssigned })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor("coordinator", 1).matterLawyerRates.list({ clientMatterId: matterAssigned })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rate mutation requires rates:create — a Senior Associate cannot create", async () => {
    await expect(
      callerFor("senior_associate", assocId).matterLawyerRates.create({ clientMatterId: matterAssigned, userId: rateUserId, hourlyRate: "100" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Head of Practice may set rates within OWN practice but not outside it", async () => {
    const hop = callerFor("head_of_practice", hopId);
    // matterAssigned belongs to (Jeddah, Corporate) = HoP's practice → allowed.
    const rate = await hop.matterLawyerRates.create({ clientMatterId: matterAssigned, userId: hopId, hourlyRate: "150" });
    expect(rate).toHaveProperty("id");
    await admin().matterLawyerRates.delete({ id: rate.id });

    // A matter in another practice (Riyadh, Corporate — no head) → denied.
    const otherClient = await admin().clients.create({ clientName: `NOther ${Date.now()}`, clientStatus: "Existing Client", city: "Riyadh", matterType: "Corporate" });
    const otherMatter = await admin().clientMatters.create({ clientId: otherClient.id, matterType: "Corporate", matterReference: `NX-${Date.now()}`, acknowledgeConflicts: true });
    try {
      await expect(hop.matterLawyerRates.create({ clientMatterId: otherMatter.id, userId: hopId, hourlyRate: "150" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await admin().clientMatters.delete({ id: otherMatter.id });
      await admin().clients.delete({ id: otherClient.id });
    }
  });

  it("billableLawyers is rate-scoped: assigned viewer sees the lead; an unassigned viewer sees an empty set", async () => {
    const assigned = await callerFor("senior_associate", assocId).clientMatters.billableLawyers({ clientMatterId: matterAssigned });
    expect(assigned.lead?.userId).toBe(assocId);
    const denied = await callerFor("senior_associate", strangerId).clientMatters.billableLawyers({ clientMatterId: matterAssigned });
    expect(denied).toEqual({ lead: null, coLawyers: [], all: [] });
  });
});

describe("payments — dedicated payments:view / payments:create / payments:edit", () => {
  it("view holders can list; non-holders and Coordinator cannot", async () => {
    expect(await callerFor("finance", 1).payments.list()).toBeInstanceOf(Array);
    expect(await callerFor("manager", 1).payments.list()).toBeInstanceOf(Array);
    await expect(callerFor("lawyer", assocId).payments.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor("coordinator", 1).payments.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("view authority alone cannot write (manager); non-holders cannot write (lawyer)", async () => {
    await expect(callerFor("manager", 1).payments.create({ leadId: 1, matterCode: "X" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor("manager", 1).payments.update({ id: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor("lawyer", assocId).payments.create({ leadId: 1, matterCode: "X" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Finance holds payments:create and payments:edit", async () => {
    const a = admin();
    const s = Date.now();
    const lead = await a.leads.create({ dateOfEnquiry: "2026-07-23", clientName: `PayLead ${s}`, channelType: "Walk-in" });
    const f = callerFor("finance", 1);
    let paymentId = 0;
    try {
      const p = await f.payments.create({ leadId: lead.id, matterCode: `PM-${s}`, paymentStatus: "Pending" });
      paymentId = p.id;
      expect(p).toHaveProperty("id");
      const upd = await f.payments.update({ id: p.id, paymentStatus: "Paid" });
      expect(upd).toBeTruthy();
    } finally {
      if (paymentId) await getDb().delete(paymentsTable).where(eq(paymentsTable.id, paymentId)).catch(() => {});
      await a.leads.delete({ id: lead.id }).catch(() => {});
    }
  });
});
