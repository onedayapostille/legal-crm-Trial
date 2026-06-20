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
 * Unified intake page filters: the clients list (Leads Pipeline base) must filter
 * by origin (convertedFrom: Enquiry vs Direct) and by assigned lawyer, and show
 * entries regardless of origin when unfiltered.
 */
describe("Unified intake filters", () => {
  it("filters Leads by source (Enquiry vs Direct) and shows both when unfiltered", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const fromEnquiry = await caller.clients.create({
      clientName: `Enq Lead ${stamp}`, clientStatus: "Leads", convertedFrom: "Enquiry",
    });
    const fromDirect = await caller.clients.create({
      clientName: `Direct Lead ${stamp}`, clientStatus: "Leads", convertedFrom: "Direct",
    });
    try {
      const both = await caller.clients.list({ clientStatus: "Leads" });
      expect(both.some(c => c.id === fromEnquiry.id)).toBe(true);
      expect(both.some(c => c.id === fromDirect.id)).toBe(true);

      const onlyEnquiry = await caller.clients.list({ clientStatus: "Leads", convertedFrom: "Enquiry" });
      expect(onlyEnquiry.some(c => c.id === fromEnquiry.id)).toBe(true);
      expect(onlyEnquiry.some(c => c.id === fromDirect.id)).toBe(false);
    } finally {
      await caller.clients.delete({ id: fromEnquiry.id });
      await caller.clients.delete({ id: fromDirect.id });
    }
  });

  it("filters by assigned lawyer and surfaces the assigned lawyer name on rows", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const lawyer = await caller.users.create({
      name: `Intake Lawyer ${stamp}`, email: `il${stamp}@x.com`, password: "Passw0rd123", role: "lawyer",
    });
    const client = await caller.clients.create({ clientName: `Assigned Lead ${stamp}`, clientStatus: "Leads" });
    try {
      await caller.clients.upsertLeadDetail({ clientId: client.id, assignedLawyerId: lawyer.id });

      const filtered = await caller.clients.list({ clientStatus: "Leads", assignedLawyerId: lawyer.id });
      const row = filtered.find(c => c.id === client.id) as any;
      expect(row).toBeTruthy();
      expect(row.assignedLawyerId).toBe(lawyer.id);
      expect(row.assignedLawyerName).toBe(lawyer.name);

      // A different lawyer filter excludes it.
      const otherLawyerId = lawyer.id + 999999;
      const none = await caller.clients.list({ clientStatus: "Leads", assignedLawyerId: otherLawyerId });
      expect(none.some(c => c.id === client.id)).toBe(false);
    } finally {
      await caller.clients.delete({ id: client.id });
      await caller.users.delete({ userId: lawyer.id });
    }
  });

  it("filters by created date range", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `Dated Lead ${stamp}`, clientStatus: "Leads" });
    try {
      const today = new Date().toISOString().split("T")[0];
      // Inclusive window covering today → includes it.
      const inWindow = await caller.clients.list({ clientStatus: "Leads", createdFrom: today, createdTo: today });
      expect(inWindow.some(c => c.id === client.id)).toBe(true);

      // A window entirely before today → excludes it.
      const before = await caller.clients.list({ clientStatus: "Leads", createdFrom: "2000-01-01", createdTo: "2000-01-02" });
      expect(before.some(c => c.id === client.id)).toBe(false);
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });
});
