import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "admin",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };

  return { ctx };
}

/**
 * "Active Matters" rules under test:
 *   - The dashboard KPI counts client matters whose status equals "Active"
 *     (case/whitespace-insensitive), NOT all matters.
 *   - Closed and On Hold matters are excluded from the count and the filtered list.
 *   - The /matters list filter is applied on the backend via clientMatters.listAll
 *     ({ status }), so the count and the list always agree.
 */
describe("clientMatters — Active Matters KPI & status filter", () => {
  async function seedClientWithMatters() {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();

    const client = await caller.clients.create({
      clientName: "Matter Test Client " + stamp,
      clientStatus: "Existing Client",
    });

    // One matter per status we care about. "active" lowercase + " Active " padded
    // both exercise the normalization; "Closed" and "On Hold" must be excluded.
    const matters = await Promise.all([
      caller.clientMatters.create({ clientId: client.id, matterReference: `A1-${stamp}`, matterStatus: "Active" }),
      caller.clientMatters.create({ clientId: client.id, matterReference: `A2-${stamp}`, matterStatus: "active" }),
      caller.clientMatters.create({ clientId: client.id, matterReference: `A3-${stamp}`, matterStatus: "  Active  " }),
      caller.clientMatters.create({ clientId: client.id, matterReference: `C1-${stamp}`, matterStatus: "Closed" }),
      caller.clientMatters.create({ clientId: client.id, matterReference: `H1-${stamp}`, matterStatus: "On Hold" }),
    ]);

    async function cleanup() {
      for (const m of matters) await caller.clientMatters.delete({ id: m.id });
      await caller.clients.delete({ id: client.id });
    }

    return { caller, client, matters, cleanup };
  }

  it("KPI counts only Active matters (excludes Closed and On Hold)", async () => {
    const { ctx } = createAuthContext();
    const base = appRouter.createCaller(ctx);
    const before = (await base.dashboard.stats()).activeMatters;

    const { caller, cleanup } = await seedClientWithMatters();
    try {
      const after = (await caller.dashboard.stats()).activeMatters;
      // 3 active rows added (including lowercase + padded), 0 from Closed/On Hold.
      expect(after).toBe(before + 3);
    } finally {
      await cleanup();
    }
  });

  it("listAll({ status: 'Active' }) returns only Active matters", async () => {
    const { caller, cleanup, client } = await seedClientWithMatters();
    try {
      const list = await caller.clientMatters.listAll({ status: "Active" });
      const mine = list.filter(m => m.clientId === client.id);
      expect(mine).toHaveLength(3);
      expect(mine.every(m => m.matterStatus?.trim().toLowerCase() === "active")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("status filter is case-insensitive (?status=active matches 'Active')", async () => {
    const { caller, cleanup, client } = await seedClientWithMatters();
    try {
      const list = await caller.clientMatters.listAll({ status: "active" });
      const mine = list.filter(m => m.clientId === client.id);
      expect(mine).toHaveLength(3);
    } finally {
      await cleanup();
    }
  });

  it("listAll({ status: 'Closed' }) returns only Closed matters, excluding Active/On Hold", async () => {
    const { caller, cleanup, client } = await seedClientWithMatters();
    try {
      const list = await caller.clientMatters.listAll({ status: "Closed" });
      const mine = list.filter(m => m.clientId === client.id);
      expect(mine).toHaveLength(1);
      expect(mine[0].matterStatus).toBe("Closed");
    } finally {
      await cleanup();
    }
  });

  it("listAll({ status: 'On Hold' }) returns only On Hold matters", async () => {
    const { caller, cleanup, client } = await seedClientWithMatters();
    try {
      const list = await caller.clientMatters.listAll({ status: "On Hold" });
      const mine = list.filter(m => m.clientId === client.id);
      expect(mine).toHaveLength(1);
      expect(mine[0].matterStatus).toBe("On Hold");
    } finally {
      await cleanup();
    }
  });

  it("listAll() with no filter returns all statuses (unfiltered)", async () => {
    const { caller, cleanup, client } = await seedClientWithMatters();
    try {
      const list = await caller.clientMatters.listAll();
      const mine = list.filter(m => m.clientId === client.id);
      expect(mine).toHaveLength(5);
    } finally {
      await cleanup();
    }
  });
});
