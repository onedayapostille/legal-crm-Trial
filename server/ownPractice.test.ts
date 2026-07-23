/**
 * Phase 5 — Head of Practice identity & OWN_PRACTICE enforcement.
 *
 * Cross-practice IDOR/authorization tests through the tRPC API, using a
 * head_of_practice actor (reads ALL; create/edit OWN_PRACTICE). A HoP heads the
 * (Riyadh, Litigation) practice; clients in other practices or with null/legacy
 * classification must be read-only for them.
 *
 * The `practices` table is provisioned here as a TEST FIXTURE on the LOCAL
 * disposable DB (idempotent DDL, matching migration 0024). The migration itself
 * is NOT executed as part of a deployment; this only sets up the local schema so
 * the OWN_PRACTICE logic can be exercised. No existing rows are backfilled — the
 * test appoints one head for its own fixtures and removes it afterwards.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb, getRawClient } from "./db";
import { practices } from "../drizzle/schema";

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

let hopId = 0;
let inPracticeId = 0, otherPracticeId = 0, unclassifiedId = 0;

beforeAll(async () => {
  // Provision the practices table on the local disposable DB (fixture only).
  await getRawClient().unsafe(`
    CREATE TABLE IF NOT EXISTS "practices" (
      "id" SERIAL PRIMARY KEY,
      "location" "city" NOT NULL,
      "matter_type" "client_matter_type" NOT NULL,
      "head_of_practice_id" INTEGER REFERENCES "users"("id"),
      "created_by" INTEGER REFERENCES "users"("id"),
      "created_at" TIMESTAMP NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "practices_location_matter_type_uniq"
      ON "practices" ("location", "matter_type");
  `);

  const a = admin();
  const stamp = Date.now();
  const hop = await a.users.create({ name: `HoP ${stamp}`, email: `hop-${stamp}@x.com`, password: PW, role: "partner" });
  hopId = hop.id;

  // Appoint HoP over (Riyadh, Litigation).
  await getDb().insert(practices)
    .values({ location: "Riyadh", matterType: "Litigation", headOfPracticeId: hopId })
    .onConflictDoUpdate({ target: [practices.location, practices.matterType], set: { headOfPracticeId: hopId } });

  const inP = await a.clients.create({ clientName: `InPrac ${stamp}`, clientStatus: "Existing Client", city: "Riyadh", matterType: "Litigation" });
  const other = await a.clients.create({ clientName: `OtherPrac ${stamp}`, clientStatus: "Existing Client", city: "Jeddah", matterType: "Corporate" });
  const unc = await a.clients.create({ clientName: `Unclassified ${stamp}`, clientStatus: "Existing Client" }); // no city/matterType
  inPracticeId = inP.id; otherPracticeId = other.id; unclassifiedId = unc.id;
});

afterAll(async () => {
  const a = admin();
  for (const id of [inPracticeId, otherPracticeId, unclassifiedId]) if (id) await a.clients.delete({ id }).catch(() => {});
  // Remove the fixture appointment so the report reverts to "not configured".
  if (hopId) await getDb().delete(practices).where(eq(practices.headOfPracticeId, hopId)).catch(() => {});
  if (hopId) await a.users.delete({ userId: hopId }).catch(() => {});
});

describe("HoP reads are ALL", () => {
  it("sees clients in every practice, incl. other-practice and unclassified", async () => {
    const hop = callerFor("head_of_practice", hopId);
    const ids = new Set((await hop.clients.list({})).map(c => c.id));
    expect(ids.has(inPracticeId)).toBe(true);
    expect(ids.has(otherPracticeId)).toBe(true);
    expect(ids.has(unclassifiedId)).toBe(true);
    expect(await hop.clients.get({ id: otherPracticeId })).toBeTruthy();
  });
});

describe("HoP create/edit is OWN_PRACTICE", () => {
  it("can create in own practice (Riyadh, Litigation)", async () => {
    const hop = callerFor("head_of_practice", hopId);
    const c = await hop.clients.create({ clientName: `HoPmade ${Date.now()}`, clientStatus: "Existing Client", city: "Riyadh", matterType: "Litigation" });
    expect(c).toHaveProperty("id");
    await admin().clients.delete({ id: c.id });
  });

  it("cannot create in another practice (Jeddah, Corporate)", async () => {
    const hop = callerFor("head_of_practice", hopId);
    await expect(
      hop.clients.create({ clientName: `Nope ${Date.now()}`, clientStatus: "Existing Client", city: "Jeddah", matterType: "Corporate" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("can edit an own-practice client", async () => {
    const hop = callerFor("head_of_practice", hopId);
    const updated = await hop.clients.update({ id: inPracticeId, clientName: `Renamed ${Date.now()}` });
    expect(updated).toBeTruthy();
  });

  it("cannot edit an other-practice client", async () => {
    const hop = callerFor("head_of_practice", hopId);
    await expect(hop.clients.update({ id: otherPracticeId, clientName: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("scope-field manipulation is denied", () => {
  it("cannot move an own-practice record OUT to another practice", async () => {
    const hop = callerFor("head_of_practice", hopId);
    await expect(
      hop.clients.update({ id: inPracticeId, city: "Jeddah", matterType: "Corporate" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" }); // proposed practice not theirs
  });

  it("cannot self-claim an other-practice record by relabeling it into own practice", async () => {
    const hop = callerFor("head_of_practice", hopId);
    await expect(
      hop.clients.update({ id: otherPracticeId, city: "Riyadh", matterType: "Litigation" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" }); // current practice not theirs
  });
});

describe("null/legacy practice data fails closed for writes", () => {
  it("cannot create with null city/matter type", async () => {
    const hop = callerFor("head_of_practice", hopId);
    await expect(
      hop.clients.create({ clientName: `NullPrac ${Date.now()}`, clientStatus: "Existing Client" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cannot edit an unclassified client", async () => {
    const hop = callerFor("head_of_practice", hopId);
    await expect(hop.clients.update({ id: unclassifiedId, clientName: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Admin remains ALL", () => {
  it("admin creates and edits in any practice, and unclassified", async () => {
    const a = admin();
    const c = await a.clients.create({ clientName: `AdminAny ${Date.now()}`, clientStatus: "Existing Client", city: "Jeddah", matterType: "Corporate" });
    expect(c).toHaveProperty("id");
    const u = await a.clients.update({ id: unclassifiedId, clientName: `AdminEdit ${Date.now()}` });
    expect(u).toBeTruthy();
    await a.clients.delete({ id: c.id });
  });
});

describe("HoP reporting uses the authoritative relationship", () => {
  it("classification report marks (Riyadh, Litigation) writable and others unclassified", async () => {
    const report = await admin().practices.classification();
    const riyadhLit = report.rows.find(r => r.location === "Riyadh" && r.matterType === "Litigation");
    expect(riyadhLit?.writableUnderOwnPractice).toBe(true);
    const unclassifiedGroup = report.rows.find(r => r.location == null || r.matterType == null);
    expect(unclassifiedGroup?.writableUnderOwnPractice ?? false).toBe(false);
  });

  it("revenue-by-HoP is configured once a head is appointed (no error, single grouping)", async () => {
    const res = await admin().financialReports.byHeadOfPractice({});
    expect(res.configured).toBe(true);
    // Each row is one head bucket — heads are unique per (location, matter_type),
    // so a record maps to at most one head (no double counting).
    if (res.configured) {
      const names = res.rows.map((r: any) => r.headOfPracticeName);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
