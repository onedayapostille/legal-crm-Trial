import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function callerFor(role: string, id = 1) {
  const user: AuthenticatedUser = {
    id,
    openId: `test-${id}`,
    email: `u${id}@example.com`,
    name: `User ${id}`,
    loginMethod: "manus",
    role: role as any,
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
const admin = () => callerFor("admin", 1);

const PW = "Passw0rd123";
const baseEnquiry = (stamp: number) => ({
  clientName: `LeadLawyer ${stamp}`,
  dateOfEnquiry: "2026-06-09",
  enquiryAt: new Date().toISOString(),
  channelType: "Walk-in",
});

describe("Suggested Lead Lawyer assignment", () => {
  it("leadLawyers returns only active Partners/Lawyers (no inactive, no staff)", async () => {
    const caller = admin();
    const stamp = Date.now();
    const lawyer = await caller.users.create({ name: `Law ${stamp}`, email: `law${stamp}@x.com`, password: PW, role: "lawyer" });
    const partner = await caller.users.create({ name: `Par ${stamp}`, email: `par${stamp}@x.com`, password: PW, role: "partner" });
    const staff = await caller.users.create({ name: `Stf ${stamp}`, email: `stf${stamp}@x.com`, password: PW, role: "staff" });
    const inactive = await caller.users.create({ name: `Ina ${stamp}`, email: `ina${stamp}@x.com`, password: PW, role: "lawyer", status: "inactive" });
    try {
      const list = await caller.users.leadLawyers();
      const ids = list.map(l => l.id);
      expect(ids).toContain(lawyer.id);
      expect(ids).toContain(partner.id);
      expect(ids).not.toContain(staff.id);     // wrong role
      expect(ids).not.toContain(inactive.id);  // inactive excluded
      expect(list.every(l => l.role === "lawyer" || l.role === "partner")).toBe(true);
    } finally {
      for (const u of [lawyer, partner, staff, inactive]) await caller.users.delete({ userId:u.id });
    }
  });

  it("saves the user ID, denormalizes the name, and notifies the lawyer", async () => {
    const caller = admin();
    const stamp = Date.now();
    const lawyer = await caller.users.create({ name: `Assignee ${stamp}`, email: `as${stamp}@x.com`, password: PW, role: "lawyer" });
    const lawyerCaller = callerFor("lawyer", lawyer.id);
    let leadId: number | undefined;
    try {
      const lead = await caller.leads.create({ ...baseEnquiry(stamp), assignedTo: lawyer.id });
      leadId = lead.id;
      expect(lead.assignedTo).toBe(lawyer.id);          // stored as id
      expect(lead.suggestedLeadLawyer).toBe(lawyer.name); // derived name, not free text

      // In-app notification delivered to the assigned lawyer.
      const notes = await lawyerCaller.notifications.list({ limit: 10 });
      const note = notes.find(n => n.entityType === "lead" && n.entityId === lead.id);
      expect(note).toBeTruthy();
      expect(note!.body).toContain(lead.clientName!);
      expect(await lawyerCaller.notifications.unreadCount()).toBeGreaterThan(0);
    } finally {
      if (leadId) await caller.leads.delete({ id: leadId });
      await caller.users.delete({ userId:lawyer.id });
    }
  });

  it("rejects an invalid / non-lawyer assignee", async () => {
    const caller = admin();
    const stamp = Date.now();
    const staff = await caller.users.create({ name: `BadAssignee ${stamp}`, email: `ba${stamp}@x.com`, password: PW, role: "staff" });
    try {
      // Non-existent id
      await expect(
        caller.leads.create({ ...baseEnquiry(stamp), assignedTo: 99999999 }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      // Wrong role
      await expect(
        caller.leads.create({ ...baseEnquiry(stamp), assignedTo: staff.id }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await caller.users.delete({ userId:staff.id });
    }
  });

  it("filters the enquiries list by assignee", async () => {
    const caller = admin();
    const stamp = Date.now();
    const l1 = await caller.users.create({ name: `F1 ${stamp}`, email: `f1${stamp}@x.com`, password: PW, role: "lawyer" });
    const l2 = await caller.users.create({ name: `F2 ${stamp}`, email: `f2${stamp}@x.com`, password: PW, role: "partner" });
    const leadA = await caller.leads.create({ ...baseEnquiry(stamp), assignedTo: l1.id });
    const leadB = await caller.leads.create({ ...baseEnquiry(stamp), assignedTo: l2.id });
    try {
      const onlyL1 = await caller.leads.list({ assignedTo: l1.id });
      expect(onlyL1.some(l => l.id === leadA.id)).toBe(true);
      expect(onlyL1.some(l => l.id === leadB.id)).toBe(false);
      // assigned name surfaced on the row
      const row = onlyL1.find(l => l.id === leadA.id) as any;
      expect(row.assignedToName).toBe(l1.name);
    } finally {
      await caller.leads.delete({ id: leadA.id });
      await caller.leads.delete({ id: leadB.id });
      await caller.users.delete({ userId:l1.id });
      await caller.users.delete({ userId:l2.id });
    }
  });
});
