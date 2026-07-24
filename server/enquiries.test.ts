import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { mapLeadStatusToClientStatus } from "./db";
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

// ─── Lead → canonical client status mapping (pure, no DB) ─────────────────────
// The canonical intake model is clients + client_lead_details. Every enquiry
// (legacy `leads` row) is mirrored into a canonical client; this is the mapping
// the mirror uses for clients.client_status.
describe("mapLeadStatusToClientStatus", () => {
  it("Converted → Existing Client", () => {
    expect(mapLeadStatusToClientStatus("Converted")).toBe("Existing Client");
  });

  it("Lost → Rejected", () => {
    expect(mapLeadStatusToClientStatus("Lost")).toBe("Rejected");
  });

  it("in-pipeline statuses → Leads", () => {
    for (const s of ["New", "Contacted", "Meeting Scheduled", "Proposal Sent", "On Hold"]) {
      expect(mapLeadStatusToClientStatus(s)).toBe("Leads");
    }
  });

  it("null / unknown → Leads (safe default, stays in pipeline)", () => {
    expect(mapLeadStatusToClientStatus(null)).toBe("Leads");
    expect(mapLeadStatusToClientStatus(undefined)).toBe("Leads");
    expect(mapLeadStatusToClientStatus("Whatever")).toBe("Leads");
  });
});

// ─── Enquiry intake → canonical mirror (integration; needs DATABASE_URL) ──────
// A new enquiry must (1) get a LEAD-#### code and (2) immediately appear in the
// canonical Leads Pipeline (clients.list) exactly once, tagged convertedFrom
// "Enquiry", with its channel fields preserved.
describe("leads.create mirrors a canonical client", () => {
  async function findMirror(caller: ReturnType<typeof adminCaller>, clientName: string) {
    const clients = await caller.clients.list({ clientStatus: "Leads" });
    return clients.filter(c => c.clientName === clientName);
  }

  it("creates a LEAD-#### enquiry and a single canonical Leads client", async () => {
    const caller = adminCaller();
    const clientName = `Enquiry Mirror ${Date.now()}`;
    const lead = await caller.leads.create({
      dateOfEnquiry: "2026-01-15",
      clientName,
      channelType: "Digital Channels",
      channelMedium: "Email",
      currentStatus: "New",
    });

    try {
      expect(lead.leadCode).toMatch(/^LEAD-\d{4}$/);

      const mirrors = await findMirror(caller, clientName);
      expect(mirrors).toHaveLength(1); // mirrored exactly once
      expect(mirrors[0]?.clientStatus).toBe("Leads");
      expect(mirrors[0]?.convertedFrom).toBe("Enquiry");
      // Channel fields are carried onto the canonical lead detail.
      expect(mirrors[0]?.channelType).toBe("Digital Channels");
      expect(mirrors[0]?.channelMedium).toBe("Email");
    } finally {
      const mirrors = await findMirror(caller, clientName);
      for (const m of mirrors) await caller.clients.delete({ id: m.id });
      await caller.leads.delete({ id: lead.id });
    }
  });

  it("converting the enquiry promotes the mirror to Existing Client", async () => {
    const caller = adminCaller();
    const clientName = `Enquiry Convert ${Date.now()}`;
    const lead = await caller.leads.create({
      dateOfEnquiry: "2026-01-15",
      clientName,
      channelType: "Walk-in",
      currentStatus: "New",
    });

    try {
      await caller.leads.update({ id: lead.id, currentStatus: "Converted" });

      // No longer in the Leads pipeline...
      const stillLeads = (await caller.clients.list({ clientStatus: "Leads" }))
        .filter(c => c.clientName === clientName);
      expect(stillLeads).toHaveLength(0);

      // ...now an Existing Client (counts toward Conversion Rate).
      const existing = (await caller.clients.list({ clientStatus: "Existing Client" }))
        .filter(c => c.clientName === clientName);
      expect(existing).toHaveLength(1);
      expect(existing[0]?.convertedFrom).toBe("Enquiry");
    } finally {
      for (const status of ["Leads", "Existing Client", "Rejected"] as const) {
        const rows = (await caller.clients.list({ clientStatus: status }))
          .filter(c => c.clientName === clientName);
        for (const r of rows) await caller.clients.delete({ id: r.id });
      }
      await caller.leads.delete({ id: lead.id });
    }
  });
});
