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

/**
 * Revenue is the single ACTIVE amount field (CRM-012). billed_amount and
 * remaining_advanced are legacy, read-only columns — the application no longer
 * writes them (it used to mirror billed = revenue, which corrupted historical
 * accounting). New records leave them NULL; reports use revenue.
 */
describe("Financial amounts — Revenue as the single source", () => {
  it("does NOT write legacy billed_amount/remaining_advanced; derives outstanding from revenue", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `Fin ${stamp}`, clientStatus: "Existing Client" });
    let recId: number | undefined;
    try {
      const rec = await caller.financial.create({
        clientId: client.id,
        agreedFees: "1000",
        revenue: "600",
        collectedAmount: "250",
      });
      recId = rec.id;
      expect(Number(rec.revenue)).toBe(600);
      // Legacy columns are no longer written on new records (stay NULL).
      expect(rec.billedAmount).toBeNull();
      expect(rec.remainingAdvanced).toBeNull();
      // outstanding = max(0, revenue - collected) — still active.
      expect(Number(rec.outstandingAmount)).toBe(350);
    } finally {
      if (recId) await caller.financial.delete({ id: recId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("updating revenue does not resurrect/alter legacy billed_amount", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `FinUpd ${stamp}`, clientStatus: "Existing Client" });
    let recId: number | undefined;
    try {
      const rec = await caller.financial.create({ clientId: client.id, agreedFees: "1000", revenue: "400" });
      recId = rec.id;
      const updated = await caller.financial.update({ id: rec.id, revenue: "900" });
      expect(Number(updated.revenue)).toBe(900);
      // billed_amount remains untouched (NULL for a record created post-CRM-012).
      expect(updated.billedAmount).toBeNull();
    } finally {
      if (recId) await caller.financial.delete({ id: recId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("To Be Billed report uses revenue (= agreedFees - revenue)", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `FinTbb ${stamp}`, clientStatus: "Existing Client" });
    let recId: number | undefined;
    try {
      const before = await caller.financial.summary();
      const rec = await caller.financial.create({ clientId: client.id, agreedFees: "1000", revenue: "600" });
      recId = rec.id;
      const after = await caller.financial.summary();
      // toBeBilled contribution = 1000 - 600 = 400
      expect(Math.round(after.totalToBeBilled - before.totalToBeBilled)).toBe(400);
      // revenue contribution to totalRevenue = 600
      expect(Math.round(after.totalRevenue - before.totalRevenue)).toBe(600);
    } finally {
      if (recId) await caller.financial.delete({ id: recId });
      await caller.clients.delete({ id: client.id });
    }
  });
});

/**
 * CRM-010: a financial record may be client-level (no matter) or matter-level,
 * but a linked matter MUST belong to the same client — enforced server-side.
 */
describe("Financial client/matter link validation", () => {
  it("allows a client-level record (no matter)", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `FinCL ${stamp}`, clientStatus: "Existing Client" });
    let recId: number | undefined;
    try {
      const rec = await caller.financial.create({ clientId: client.id, agreedFees: "500", revenue: "500" });
      recId = rec.id;
      expect(rec.clientMatterId).toBeNull();
    } finally {
      if (recId) await caller.financial.delete({ id: recId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("allows a matter-level record when the matter belongs to the client", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `FinML ${stamp}`, clientStatus: "Existing Client" });
    let recId: number | undefined;
    try {
      const matter = await caller.clientMatters.create({ clientId: client.id, matterType: "Corporate", matterReference: `FML-${stamp}` });
      const rec = await caller.financial.create({
        clientId: client.id,
        clientMatterId: matter.id,
        agreedFees: "500",
        revenue: "200",
      });
      recId = rec.id;
      expect(rec.clientMatterId).toBe(matter.id);
    } finally {
      if (recId) await caller.financial.delete({ id: recId });
      // matter + client cascade-delete with the client
      await caller.clients.delete({ id: client.id });
    }
  });

  it("rejects a matter that belongs to a DIFFERENT client", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const clientA = await caller.clients.create({ clientName: `FinA ${stamp}`, clientStatus: "Existing Client" });
    const clientB = await caller.clients.create({ clientName: `FinB ${stamp}`, clientStatus: "Existing Client" });
    try {
      const matterB = await caller.clientMatters.create({ clientId: clientB.id, matterType: "Litigation", matterReference: `MB-${stamp}` });
      // Linking clientA's financial record to clientB's matter must fail.
      await expect(
        caller.financial.create({
          clientId: clientA.id,
          clientMatterId: matterB.id,
          agreedFees: "100",
          revenue: "100",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await caller.clients.delete({ id: clientA.id });
      await caller.clients.delete({ id: clientB.id });
    }
  });
});
