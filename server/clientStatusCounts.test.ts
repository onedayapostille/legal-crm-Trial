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
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };

  return { ctx };
}

/**
 * Metric definitions under test (per product meeting note):
 *   - Existing Client  → Active / converted client.
 *   - Leads Pipeline   → clients currently in "Leads" status (need follow-up).
 *   - Total Leads      → "Non-active" = Leads + Rejected (everything NOT Active).
 *
 * A converted Active client ("Existing Client") must NOT be counted in the
 * Leads pipeline, and must NOT be counted in the non-active total.
 */
describe("clients.statusCounts — leads/active/rejected metrics", () => {
  it("returns the full set of count fields", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const counts = await caller.clients.statusCounts();

    expect(counts).toHaveProperty("existing");
    expect(counts).toHaveProperty("leads");
    expect(counts).toHaveProperty("rejected");
    expect(counts).toHaveProperty("total");
    expect(counts).toHaveProperty("nonActive");
  });

  it("nonActive equals leads + rejected and excludes Active (existing) clients", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const counts = await caller.clients.statusCounts();

    // Total Leads (non-active) is exactly the non-active statuses.
    expect(counts.nonActive).toBe(counts.leads + counts.rejected);
    // Active (Existing Client) clients are never part of the non-active total.
    expect(counts.nonActive).toBe(counts.total - counts.existing);
  });

  it("counts a new Lead in both the pipeline and the non-active total, but not as Active", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const before = await caller.clients.statusCounts();
    const created = await caller.clients.create({
      clientName: "Lead Scenario " + Date.now(),
      clientStatus: "Leads",
    });

    try {
      const after = await caller.clients.statusCounts();
      expect(after.leads).toBe(before.leads + 1);
      expect(after.nonActive).toBe(before.nonActive + 1);
      expect(after.existing).toBe(before.existing); // not Active
    } finally {
      await caller.clients.delete({ id: created.id });
    }
  });

  it("converting a Lead to Active removes it from the pipeline and the non-active total", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const created = await caller.clients.create({
      clientName: "Convert Scenario " + Date.now(),
      clientStatus: "Leads",
    });

    try {
      const asLead = await caller.clients.statusCounts();

      await caller.clients.update({ id: created.id, clientStatus: "Existing Client" });
      const asActive = await caller.clients.statusCounts();

      // Pipeline shrinks, Active grows.
      expect(asActive.leads).toBe(asLead.leads - 1);
      expect(asActive.existing).toBe(asLead.existing + 1);
      // Converted Active client is no longer counted as non-active.
      expect(asActive.nonActive).toBe(asLead.nonActive - 1);
    } finally {
      await caller.clients.delete({ id: created.id });
    }
  });

  it("a Rejected client counts toward non-active total but not the pipeline", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const before = await caller.clients.statusCounts();
    const created = await caller.clients.create({
      clientName: "Rejected Scenario " + Date.now(),
      clientStatus: "Rejected",
    });

    try {
      const after = await caller.clients.statusCounts();
      expect(after.rejected).toBe(before.rejected + 1);
      expect(after.nonActive).toBe(before.nonActive + 1); // included in Total Leads
      expect(after.leads).toBe(before.leads); // NOT in the follow-up pipeline
    } finally {
      await caller.clients.delete({ id: created.id });
    }
  });
});
