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
    authorizationModel: "legacy",
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

const baseEnquiry = (stamp: number) => ({
  clientName: `Chan ${stamp}`,
  dateOfEnquiry: "2026-06-09",
  enquiryAt: new Date().toISOString(),
});

describe("Communication channel — two-level type/medium", () => {
  it("stores channel_type and channel_medium separately", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const lead = await caller.leads.create({
      ...baseEnquiry(stamp),
      channelType: "Digital Channels",
      channelMedium: "LinkedIn",
    });
    try {
      const row = await caller.leads.get({ id: lead.id });
      expect((row as any).channelType).toBe("Digital Channels");
      expect((row as any).channelMedium).toBe("LinkedIn");
    } finally {
      await caller.leads.delete({ id: lead.id });
    }
  });

  it("requires channel_type", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    await expect(
      caller.leads.create({ ...baseEnquiry(stamp) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("requires medium for Digital Channels and Referral, but not Walk-in/Event", async () => {
    const caller = adminCaller();
    const stamp = Date.now();

    await expect(
      caller.leads.create({ ...baseEnquiry(stamp), channelType: "Digital Channels" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.leads.create({ ...baseEnquiry(stamp), channelType: "Referral" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Walk-in: no medium needed.
    const walkIn = await caller.leads.create({ ...baseEnquiry(stamp), channelType: "Walk-in" });
    // Event: medium optional.
    const event = await caller.leads.create({ ...baseEnquiry(stamp), channelType: "Event / Conference" });
    try {
      expect(walkIn.id).toBeGreaterThan(0);
      expect(event.id).toBeGreaterThan(0);
    } finally {
      await caller.leads.delete({ id: walkIn.id });
      await caller.leads.delete({ id: event.id });
    }
  });

  it("filters the enquiries list by channel type and medium", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const li = await caller.leads.create({ ...baseEnquiry(stamp), channelType: "Digital Channels", channelMedium: "LinkedIn" });
    const wa = await caller.leads.create({ ...baseEnquiry(stamp), channelType: "Digital Channels", channelMedium: "WhatsApp" });
    try {
      const linkedIn = await caller.leads.list({ channelMedium: "LinkedIn" });
      expect(linkedIn.some(l => l.id === li.id)).toBe(true);
      expect(linkedIn.some(l => l.id === wa.id)).toBe(false);

      const digital = await caller.leads.list({ channelType: "Digital Channels" });
      expect(digital.some(l => l.id === li.id)).toBe(true);
      expect(digital.some(l => l.id === wa.id)).toBe(true);
    } finally {
      await caller.leads.delete({ id: li.id });
      await caller.leads.delete({ id: wa.id });
    }
  });

  it("filters the clients Leads Pipeline by channel (via lead details)", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `ChanClient ${stamp}`, clientStatus: "Leads" });
    try {
      await caller.clients.upsertLeadDetail({
        clientId: client.id,
        channelType: "Referral",
        channelMedium: `Partner ${stamp}`,
      });

      const filtered = await caller.clients.list({ clientStatus: "Leads", channelType: "Referral" });
      const row = filtered.find(c => c.id === client.id) as any;
      expect(row).toBeTruthy();
      expect(row.channelType).toBe("Referral");
      expect(row.channelMedium).toBe(`Partner ${stamp}`);

      // Medium partial-match filter.
      const byMedium = await caller.clients.list({ clientStatus: "Leads", channelMedium: "Partner" });
      expect(byMedium.some(c => c.id === client.id)).toBe(true);
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("rejects a Referral lead detail without a referral name", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `BadChan ${stamp}`, clientStatus: "Leads" });
    try {
      await expect(
        caller.clients.upsertLeadDetail({ clientId: client.id, channelType: "Referral" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });
});
