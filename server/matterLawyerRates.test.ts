import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import type { UserRole } from "../shared/const";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function ctxFor(role: UserRole, id = 1): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id,
    openId: `test-${role}-${id}`,
    email: `test-${role}-${id}@example.com`,
    name: `Test ${role}`,
    loginMethod: "manus",
    role,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    ctx: {
      user,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: () => {} } as TrpcContext["res"],
    },
  };
}

const PW = "Passw0rd123";

describe("Matter Hourly Rates — assigned users, read-only names, restricted reassign", () => {
  async function seed() {
    const admin = appRouter.createCaller(ctxFor("admin").ctx);
    const stamp = Date.now();

    const leadUser = await admin.users.create({ name: `Lead Lawyer ${stamp}`, email: `lead${stamp}@x.com`, password: PW, role: "partner" });
    const coUser   = await admin.users.create({ name: `Co Lawyer ${stamp}`,   email: `co${stamp}@x.com`,   password: PW, role: "lawyer" });
    const viewer   = await admin.users.create({ name: `Viewer ${stamp}`,       email: `vw${stamp}@x.com`,   password: PW, role: "viewer" });

    const client = await admin.clients.create({ clientName: `Rates Client ${stamp}`, clientStatus: "Existing Client" });
    const matter = await admin.clientMatters.create({ clientId: client.id, matterType: "Corporate", matterReference: `RATE-${stamp}` });

    async function cleanup() {
      await admin.clientMatters.delete({ id: matter.id });
      await admin.clients.delete({ id: client.id });
      for (const u of [leadUser, coUser, viewer]) await admin.users.delete({ userId: u.id });
    }
    return { admin, stamp, leadUser, coUser, viewer, client, matter, cleanup };
  }

  it("derives the rate's lawyer name from the assigned user (not free text)", async () => {
    const { admin, coUser, matter, cleanup } = await seed();
    try {
      const rate = await admin.matterLawyerRates.create({
        clientMatterId: matter.id,
        userId: coUser.id,
        hourlyRate: "500",
      });
      expect(rate.userId).toBe(coUser.id);
      expect(rate.lawyerName).toBe(coUser.name); // server-derived, role defaulted from user
      expect(rate.role).toBe("lawyer");
    } finally {
      await cleanup();
    }
  });

  it("rejects a rate for a non-assignable role (e.g. viewer)", async () => {
    const { admin, viewer, matter, cleanup } = await seed();
    try {
      await expect(
        admin.matterLawyerRates.create({ clientMatterId: matter.id, userId: viewer.id, hourlyRate: "300" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await cleanup();
    }
  });

  it("rejects a duplicate rate for the same lawyer on the same matter", async () => {
    const { admin, coUser, matter, cleanup } = await seed();
    try {
      await admin.matterLawyerRates.create({ clientMatterId: matter.id, userId: coUser.id, hourlyRate: "500" });
      await expect(
        admin.matterLawyerRates.create({ clientMatterId: matter.id, userId: coUser.id, hourlyRate: "600" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await cleanup();
    }
  });

  it("reassign lead lawyer is allowed for Admin/Partner and blocked for others", async () => {
    const { admin, leadUser, matter, cleanup } = await seed();
    try {
      // Admin can reassign
      const updated = await admin.clientMatters.reassignLeadLawyer({ clientMatterId: matter.id, userId: leadUser.id });
      expect(updated.leadLawyerId).toBe(leadUser.id);
      expect(updated.leadPartnerFullName).toBe(leadUser.name); // legacy display kept in sync

      // A staff user lacks matters:assign_lawyer → FORBIDDEN
      const staff = appRouter.createCaller(ctxFor("staff", 999).ctx);
      await expect(
        staff.clientMatters.reassignLeadLawyer({ clientMatterId: matter.id, userId: leadUser.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await cleanup();
    }
  });

  it("billableLawyers returns the lead plus co-lawyers with their rates", async () => {
    const { admin, leadUser, coUser, matter, cleanup } = await seed();
    try {
      await admin.clientMatters.reassignLeadLawyer({ clientMatterId: matter.id, userId: leadUser.id });
      await admin.matterLawyerRates.create({ clientMatterId: matter.id, userId: coUser.id, hourlyRate: "450" });

      const billable = await admin.clientMatters.billableLawyers({ clientMatterId: matter.id });
      expect(billable.lead?.userId).toBe(leadUser.id);
      expect(billable.lead?.name).toBe(leadUser.name);
      expect(billable.coLawyers.map(c => c.userId)).toContain(coUser.id);
      const co = billable.coLawyers.find(c => c.userId === coUser.id);
      expect(co?.hourlyRate).toBe("450.00");
      // All billable lawyers (lead + co) are exposed for billing/hours logic.
      expect(billable.all.length).toBe(1 + billable.coLawyers.length);
    } finally {
      await cleanup();
    }
  });
});
