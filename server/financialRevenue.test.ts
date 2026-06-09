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
 * Revenue is the single amount field. billed_amount is mirrored to revenue
 * server-side (compatibility alias), and reports use revenue.
 */
describe("Financial amounts — Revenue as the single source", () => {
  it("mirrors billed_amount to revenue and derives outstanding from revenue", async () => {
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
      // billed_amount mirrors revenue
      expect(Number(rec.billedAmount)).toBe(600);
      expect(Number(rec.revenue)).toBe(600);
      // remainingAdvanced (billed - revenue) collapses to 0
      expect(Number(rec.remainingAdvanced)).toBe(0);
      // outstanding = max(0, revenue - collected)
      expect(Number(rec.outstandingAmount)).toBe(350);
    } finally {
      if (recId) await caller.financial.delete({ id: recId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("keeps billed_amount mirrored to revenue on update", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `FinUpd ${stamp}`, clientStatus: "Existing Client" });
    let recId: number | undefined;
    try {
      const rec = await caller.financial.create({ clientId: client.id, agreedFees: "1000", revenue: "400" });
      recId = rec.id;
      const updated = await caller.financial.update({ id: rec.id, revenue: "900" });
      expect(Number(updated.revenue)).toBe(900);
      expect(Number(updated.billedAmount)).toBe(900); // still mirrored
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
