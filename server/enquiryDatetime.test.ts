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

describe("Enquiry datetime — UTC storage, local override, report correctness", () => {
  it("stores the provided UTC instant exactly (clean round-trip)", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const enquiryAt = "2026-06-09T11:30:00.000Z"; // explicit UTC
    const created = await caller.leads.create({
      clientName: `Enq ${stamp}`,
      dateOfEnquiry: "2026-06-09",
      time: "14:30",
      enquiryAt,
      enquiryTimezone: "Asia/Riyadh",
    });
    try {
      const row = await caller.leads.get({ id: created.id });
      // enquiry_at is timestamptz → the stored instant equals the provided UTC.
      expect(new Date((row as any).enquiryAt).toISOString()).toBe(enquiryAt);
      expect((row as any).enquiryTimezone).toBe("Asia/Riyadh");
    } finally {
      await caller.leads.delete({ id: created.id });
    }
  });

  it("allows a manual past-date override", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const past = "2019-01-15T08:00:00.000Z";
    const created = await caller.leads.create({
      clientName: `Past ${stamp}`,
      dateOfEnquiry: "2019-01-15",
      time: "11:00",
      enquiryAt: past,
      enquiryTimezone: "Asia/Riyadh",
    });
    try {
      const row = await caller.leads.get({ id: created.id });
      expect(new Date((row as any).enquiryAt).toISOString()).toBe(past);
    } finally {
      await caller.leads.delete({ id: created.id });
    }
  });

  it("KPI 'this month' counts by the stored UTC timestamp (excludes old, includes now)", async () => {
    const caller = adminCaller();
    const stamp = Date.now();

    const before = await caller.leads.kpiMetrics();

    // An old enquiry (years ago) must NOT count toward this month.
    const old = await caller.leads.create({
      clientName: `OldKpi ${stamp}`,
      dateOfEnquiry: "2019-01-15",
      enquiryAt: "2019-01-15T08:00:00.000Z",
    });
    // A current enquiry MUST count toward this month.
    const now = await caller.leads.create({
      clientName: `NowKpi ${stamp}`,
      dateOfEnquiry: new Date().toISOString().split("T")[0],
      enquiryAt: new Date().toISOString(),
    });
    try {
      const after = await caller.leads.kpiMetrics();
      // newLeads (this month) increased by exactly 1 (the current one, not the old one).
      expect(after.newLeads - before.newLeads).toBe(1);
    } finally {
      await caller.leads.delete({ id: old.id });
      await caller.leads.delete({ id: now.id });
    }
  });
});
