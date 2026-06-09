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
 * Backs the Leads Pipeline + Recent Leads widgets: a newly created Lead client
 * must surface immediately at the top of the Leads list (created_at desc),
 * exactly once, and be reflected in the pipeline counts. The frontend achieves
 * "no manual refresh" by invalidating these same queries on create.
 */
describe("New Lead visibility", () => {
  it("a newly created Lead appears at the TOP of the Leads list, exactly once", async () => {
    const caller = adminCaller();
    const created = await caller.clients.create({
      clientName: `Fresh Lead ${Date.now()}`,
      clientStatus: "Leads",
    });
    try {
      const leads = await caller.clients.list({ clientStatus: "Leads" });
      // Top of the list (backend orders by created_at DESC)
      expect(leads[0]?.id).toBe(created.id);
      // No duplicate rows
      expect(leads.filter(c => c.id === created.id)).toHaveLength(1);
      // It is a Leads-status client
      expect(leads[0]?.clientStatus).toBe("Leads");
    } finally {
      await caller.clients.delete({ id: created.id });
    }
  });

  it("the Leads Pipeline count reflects the new Lead immediately", async () => {
    const caller = adminCaller();
    const before = await caller.clients.dashboardStats();
    const created = await caller.clients.create({
      clientName: `Pipeline Lead ${Date.now()}`,
      clientStatus: "Leads",
    });
    try {
      const after = await caller.clients.dashboardStats();
      expect(after.leads).toBe(before.leads + 1);
    } finally {
      await caller.clients.delete({ id: created.id });
    }
  });

  it("converting a Lead to Active removes it from the Leads list (no stale rows)", async () => {
    const caller = adminCaller();
    const created = await caller.clients.create({
      clientName: `Convert Lead ${Date.now()}`,
      clientStatus: "Leads",
    });
    try {
      await caller.clients.update({ id: created.id, clientStatus: "Existing Client" });
      const leads = await caller.clients.list({ clientStatus: "Leads" });
      expect(leads.some(c => c.id === created.id)).toBe(false);
    } finally {
      await caller.clients.delete({ id: created.id });
    }
  });
});
