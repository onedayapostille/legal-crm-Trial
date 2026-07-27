import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { mapLeadUrgencyToPriority } from "./db";
import type { TrpcContext } from "./_core/context";
import {
  canEditLeadPipelineDetails,
  shouldLoadLeadPipelineDetails,
  shouldShowLeadPipelineDetails,
} from "@/lib/leadPipeline";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function callerFor(
  role: string,
  authorizationModel: "legacy" | "target",
  id = 1,
) {
  const user: AuthenticatedUser = {
    id,
    openId: `lead-pipeline-${role}-${id}`,
    email: `${role}-${id}@example.com`,
    name: role,
    loginMethod: "manus",
    role: role as AuthenticatedUser["role"],
    authorizationModel,
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

describe("Lead Pipeline client-profile visibility", () => {
  it("shows pipeline Leads and source-linked converted clients, but not direct clients", () => {
    expect(shouldLoadLeadPipelineDetails({ clientStatus: "Existing Client" })).toBe(true);
    expect(shouldShowLeadPipelineDetails({
      clientStatus: "Leads",
      sourceLeadId: null,
    }, false)).toBe(true);
    expect(shouldShowLeadPipelineDetails({
      clientStatus: "Existing Client",
      sourceLeadId: 42,
    }, true)).toBe(true);
    expect(shouldShowLeadPipelineDetails({
      clientStatus: "Existing Client",
      sourceLeadId: null,
    }, true)).toBe(true);
    expect(shouldShowLeadPipelineDetails({
      clientStatus: "Existing Client",
      sourceLeadId: null,
    }, false)).toBe(false);
    expect(shouldShowLeadPipelineDetails({
      clientStatus: "Rejected",
      sourceLeadId: 42,
    }, true)).toBe(false);
  });

  it("makes converted Lead information read-only", () => {
    expect(canEditLeadPipelineDetails({ clientStatus: "Leads", sourceLeadId: 42 })).toBe(true);
    expect(canEditLeadPipelineDetails({
      clientStatus: "Existing Client",
      sourceLeadId: 42,
    })).toBe(false);
  });
});

describe("legacy Lead field mapping", () => {
  it("maps Lead urgency onto pipeline priority without changing the schema", () => {
    expect(mapLeadUrgencyToPriority("Low")).toBe("low");
    expect(mapLeadUrgencyToPriority("Medium")).toBe("medium");
    expect(mapLeadUrgencyToPriority("High")).toBe("high");
    expect(mapLeadUrgencyToPriority("Critical")).toBe("urgent");
    expect(mapLeadUrgencyToPriority(undefined)).toBeNull();
  });
});

describe("Lead conversion preserves and authorizes pipeline details", () => {
  it("keeps the source Lead, returns all mapped details, and preserves role scopes", async () => {
    const admin = callerFor("admin", "legacy");
    const coordinator = callerFor("coordinator", "target", 70_001);
    const headOfPractice = callerFor("head_of_practice", "target", 70_002);
    const financeWithoutLeadAccess = callerFor("finance", "target", 70_003);
    const outOfScopeAssociate = callerFor("senior_associate", "target", 70_004);
    const stamp = Date.now();
    const clientName = `Converted Pipeline ${stamp}`;
    let leadId: number | undefined;
    let convertedClientId: number | undefined;
    let directClientId: number | undefined;
    let canonicalLeadId: number | undefined;

    try {
      const lead = await admin.leads.create({
        dateOfEnquiry: "2026-07-27",
        clientName,
        channelType: "Digital Channels",
        channelMedium: "Email",
        receivedBy: "Coordinator One",
        urgencyLevel: "Critical",
        referralSourceName: "Referral Partner",
        currentStatus: "New",
        nextAction: "Prepare engagement proposal",
        deadline: "2026-08-10",
      });
      leadId = lead.id;

      const initialMirror = (await admin.clients.list({ clientStatus: "Leads" }))
        .find(client => client.sourceLeadId === lead.id);
      expect(initialMirror).toMatchObject({
        clientName,
        clientStatus: "Leads",
        convertedFrom: "Enquiry",
        sourceLeadId: lead.id,
      });

      await admin.leads.update({ id: lead.id, currentStatus: "Converted" });

      const convertedClient = (await admin.clients.list({ clientStatus: "Existing Client" }))
        .find(client => client.sourceLeadId === lead.id);
      expect(convertedClient).toBeTruthy();
      convertedClientId = convertedClient!.id;

      // The client relationship survives conversion, and the original Lead is
      // retained in place with its conversion marker.
      expect(await admin.clients.get({ id: convertedClientId })).toMatchObject({
        id: convertedClientId,
        sourceLeadId: lead.id,
        clientStatus: "Existing Client",
      });
      expect(await admin.leads.get({ id: lead.id })).toMatchObject({
        id: lead.id,
        currentStatus: "Converted",
        nextAction: "Prepare engagement proposal",
      });

      const expectedDetail = {
        clientId: convertedClientId,
        sourceLeadId: lead.id,
        clientSource: "Referral Partner",
        leadStatus: "Converted",
        priority: "urgent",
        nextActionDate: "2026-08-10",
        nextActionOwner: "Coordinator One",
        channelType: "Digital Channels",
        channelMedium: "Email",
        nextAction: "Prepare engagement proposal",
        readOnly: true,
      };
      expect(await admin.clients.getLeadDetail({ clientId: convertedClientId }))
        .toMatchObject(expectedDetail);

      // Coordinator registry access and Head-of-Practice ALL reads retain the
      // original Lead information.
      expect(await coordinator.clients.getLeadDetail({ clientId: convertedClientId }))
        .toMatchObject(expectedDetail);
      expect(await headOfPractice.clients.getLeadDetail({ clientId: convertedClientId }))
        .toMatchObject(expectedDetail);

      // The section is read-only after conversion. Coordinator reaches the
      // registry write boundary, while HoP still fails the unclassified
      // OWN_PRACTICE check before any write.
      await expect(coordinator.clients.upsertLeadDetail({
        clientId: convertedClientId,
        nextAction: "Must not overwrite the source Lead",
      })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(headOfPractice.clients.upsertLeadDetail({
        clientId: convertedClientId,
        nextAction: "Must remain out of scope",
      })).rejects.toMatchObject({ code: "FORBIDDEN" });

      // clients:view does not implicitly grant access to a linked Lead. Finance
      // has firm-wide client read but no Lead read; the associate is also outside
      // the client's ASSIGNED scope. Both receive no detail row.
      expect(await financeWithoutLeadAccess.clients.getLeadDetail({
        clientId: convertedClientId,
      })).toBeNull();
      expect(await outOfScopeAssociate.clients.getLeadDetail({
        clientId: convertedClientId,
      })).toBeNull();

      directClientId = (await admin.clients.create({
        clientName: `Direct Client ${stamp}`,
        clientStatus: "Existing Client",
        convertedFrom: "Direct",
      })).id;
      expect(await admin.clients.getLeadDetail({ clientId: directClientId })).toBeNull();

      // The other supported conversion path promotes a canonical Leads client
      // in place. Its 1:1 detail row is the retained relationship and remains
      // visible after the status change even though no legacy source Lead exists.
      canonicalLeadId = (await admin.clients.create({
        clientName: `Canonical Lead ${stamp}`,
        clientStatus: "Leads",
      })).id;
      await admin.clients.upsertLeadDetail({
        clientId: canonicalLeadId,
        clientSource: "Conference",
        leadStatus: "Qualified",
        priority: "high",
        nextActionDate: "2026-08-12",
        nextActionOwner: "Me",
        channelType: "Walk-in",
        nextAction: "Arrange conflict review",
      });
      await admin.clients.update({
        id: canonicalLeadId,
        clientStatus: "Existing Client",
      });
      expect(await admin.clients.getLeadDetail({ clientId: canonicalLeadId })).toMatchObject({
        clientId: canonicalLeadId,
        sourceLeadId: null,
        clientSource: "Conference",
        leadStatus: "Qualified",
        priority: "high",
        nextActionDate: "2026-08-12",
        nextActionOwner: "Me",
        nextAction: "Arrange conflict review",
        readOnly: true,
      });
    } finally {
      if (canonicalLeadId) {
        await admin.clients.delete({ id: canonicalLeadId }).catch(() => {});
      }
      if (directClientId) {
        await admin.clients.delete({ id: directClientId }).catch(() => {});
      }
      if (convertedClientId) {
        await admin.clients.delete({ id: convertedClientId }).catch(() => {});
      }
      if (leadId) {
        await admin.leads.delete({ id: leadId }).catch(() => {});
      }
    }
  });
});
