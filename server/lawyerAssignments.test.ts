import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import type { UserRole } from "../shared/const";
import { LEAD_LAWYER_ELIGIBLE_ROLES } from "../shared/permissions";

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

// Date.now() alone can collide when two seeds run in the same millisecond
// (vitest runs files in parallel) — add a per-process counter for uniqueness.
let seedSeq = 0;

describe("Lawyer assignments — eligible users, validation, historical preservation", () => {
  async function seed() {
    const admin = appRouter.createCaller(ctxFor("admin").ctx);
    const stamp = `${Date.now()}${seedSeq++}`;

    // Canonical account roles (AGP spec v1.1): head_of_practice replaces the
    // legacy partner grade, senior_associate a lawyer grade; manager is the
    // non-legal role that must never appear in lawyer dropdowns.
    const partner = await admin.users.create({ name: `AA Partner ${stamp}`, email: `pt${stamp}@x.com`, password: PW, role: "head_of_practice" });
    const lawyer  = await admin.users.create({ name: `BB Lawyer ${stamp}`,  email: `lw${stamp}@x.com`, password: PW, role: "senior_associate" });
    const viewer  = await admin.users.create({ name: `CC Viewer ${stamp}`,  email: `vw${stamp}@x.com`, password: PW, role: "manager" });
    const inactiveLawyer = await admin.users.create({
      name: `DD Inactive ${stamp}`, email: `in${stamp}@x.com`, password: PW, role: "senior_associate", status: "inactive",
    });

    const client = await admin.clients.create({ clientName: `Assign Client ${stamp}`, clientStatus: "Existing Client" });

    const created: { matterIds: number[]; financialIds: number[] } = { matterIds: [], financialIds: [] };
    async function cleanup() {
      for (const id of created.financialIds) await admin.financial.delete({ id }).catch(() => {});
      for (const id of created.matterIds) await admin.clientMatters.delete({ id }).catch(() => {});
      await admin.clients.delete({ id: client.id });
      for (const u of [partner, lawyer, viewer, inactiveLawyer]) await admin.users.delete({ userId: u.id });
    }
    return { admin, stamp, partner, lawyer, viewer, inactiveLawyer, client, created, cleanup };
  }

  // ── Eligible-lawyer source ──────────────────────────────────────────────────

  it("eligibleLawyers returns active eligible users (id, fullName, email, role, status) sorted by name", async () => {
    const { admin, partner, lawyer, cleanup } = await seed();
    try {
      const list = await admin.users.eligibleLawyers({ field: "attorney1" });
      const ids = list.map(u => u.id);
      expect(ids).toContain(partner.id);
      expect(ids).toContain(lawyer.id);
      const row = list.find(u => u.id === partner.id)!;
      expect(row).toMatchObject({ fullName: partner.name, email: partner.email, role: "head_of_practice", status: "active" });
      expect(row).not.toHaveProperty("passwordHash");
      const names = list.map(u => u.fullName ?? "");
      expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    } finally {
      await cleanup();
    }
  });

  it("eligibleLawyers excludes inactive users and non-legal roles", async () => {
    const { admin, viewer, inactiveLawyer, cleanup } = await seed();
    try {
      for (const field of ["leadPartner", "supportLead", "attorney1", "responsibleLawyer"] as const) {
        const ids = (await admin.users.eligibleLawyers({ field })).map(u => u.id);
        expect(ids).not.toContain(inactiveLawyer.id); // inactive excluded
        expect(ids).not.toContain(viewer.id);         // non-legal role excluded
      }
    } finally {
      await cleanup();
    }
  });

  it("leadership fields (Lead Partner) only offer Lead-Lawyer-eligible grades", async () => {
    const { admin, cleanup } = await seed();
    try {
      const list = await admin.users.eligibleLawyers({ field: "leadPartner" });
      expect(
        list.every(u => (LEAD_LAWYER_ELIGIBLE_ROLES as readonly string[]).includes(u.role)),
      ).toBe(true);
      // Trainee is NOT eligible (documented spec conflict, least privilege).
      expect(list.every(u => u.role !== "trainee")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // ── Matter create validation ────────────────────────────────────────────────

  it("creates a matter with lawyer assignments and mirrors names into legacy columns (incl. Attorney 4)", async () => {
    const { admin, stamp, partner, lawyer, client, created, cleanup } = await seed();
    try {
      const matter = await admin.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `AS-${stamp}-1`,
        leadLawyerId: partner.id,
        supportLeadId: lawyer.id,
        attorneyHeadId: partner.id,
        attorney1Id: lawyer.id,
        attorney4Id: partner.id,
      });
      created.matterIds.push(matter.id);
      expect(matter.leadLawyerId).toBe(partner.id);
      expect(matter.leadPartnerFullName).toBe(partner.name);
      expect(matter.supportLeadId).toBe(lawyer.id);
      expect(matter.supportLead).toBe(lawyer.name);
      expect(matter.attorneyHeadId).toBe(partner.id);
      expect(matter.attorney1Id).toBe(lawyer.id);
      expect(matter.attorney1).toBe(lawyer.name);
      // Attorney 4 is saved and returned with its mirrored display name.
      expect(matter.attorney4Id).toBe(partner.id);
      expect(matter.attorney4).toBe(partner.name);

      // Round-trips through the get endpoint too.
      const fetched = await admin.clientMatters.get({ id: matter.id });
      expect(fetched?.attorney4Id).toBe(partner.id);
      expect(fetched?.attorney4).toBe(partner.name);
    } finally {
      await cleanup();
    }
  });

  it("rejects an invalid (nonexistent) user id", async () => {
    const { admin, stamp, client, cleanup } = await seed();
    try {
      await expect(
        admin.clientMatters.create({
          clientId: client.id, matterType: "Corporate", matterReference: `AS-${stamp}-2`,
          attorney1Id: 99_999_999,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await cleanup();
    }
  });

  it("rejects assigning an inactive user to a new matter", async () => {
    const { admin, stamp, inactiveLawyer, client, cleanup } = await seed();
    try {
      await expect(
        admin.clientMatters.create({
          clientId: client.id, matterType: "Corporate", matterReference: `AS-${stamp}-3`,
          supportLeadId: inactiveLawyer.id,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await cleanup();
    }
  });

  it("rejects a user whose role is not eligible (viewer)", async () => {
    const { admin, stamp, viewer, client, cleanup } = await seed();
    try {
      await expect(
        admin.clientMatters.create({
          clientId: client.id, matterType: "Corporate", matterReference: `AS-${stamp}-4`,
          attorney2Id: viewer.id,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await cleanup();
    }
  });

  // ── Historical preservation on edit ─────────────────────────────────────────

  it("preserves an unchanged assignment to a now-inactive user, but blocks reassigning them elsewhere", async () => {
    const { admin, stamp, lawyer, partner, client, created, cleanup } = await seed();
    try {
      const matter = await admin.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `AS-${stamp}-5`,
        attorney1Id: lawyer.id,
      });
      created.matterIds.push(matter.id);

      // Deactivate the assigned lawyer.
      await admin.users.update({ userId: lawyer.id, name: lawyer.name!, email: lawyer.email, role: "senior_associate", status: "inactive" });

      // Editing an unrelated field while resubmitting the SAME attorney1Id keeps
      // the historical assignment (readable) and does not fail validation.
      const updated = await admin.clientMatters.update({
        id: matter.id, matterStatus: "Active", attorney1Id: lawyer.id,
      });
      expect(updated.attorney1Id).toBe(lawyer.id);
      expect(updated.attorney1).toBe(lawyer.name);

      // But NEWLY assigning the inactive user (a different field) is rejected.
      await expect(
        admin.clientMatters.update({ id: matter.id, attorney2Id: lawyer.id }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // Replacing the inactive user with an active one works.
      const replaced = await admin.clientMatters.update({ id: matter.id, attorney1Id: partner.id });
      expect(replaced.attorney1Id).toBe(partner.id);
      expect(replaced.attorney1).toBe(partner.name);

      // Explicitly clearing unlinks and clears the mirrored display name.
      const cleared = await admin.clientMatters.update({ id: matter.id, attorney1Id: null });
      expect(cleared.attorney1Id).toBeNull();
      expect(cleared.attorney1).toBeNull();
    } finally {
      await cleanup();
    }
  });

  // ── Financial records: Responsible Lawyer ───────────────────────────────────

  it("financial records link, validate and mirror the Responsible Lawyer", async () => {
    const { admin, lawyer, partner, inactiveLawyer, client, created, cleanup } = await seed();
    try {
      const record = await admin.financial.create({
        clientId: client.id, responsibleLawyerId: lawyer.id,
      });
      created.financialIds.push(record.id);
      expect(record.responsibleLawyerId).toBe(lawyer.id);
      expect(record.responsibleLawyer).toBe(lawyer.name);

      // Inactive user rejected for a new assignment.
      await expect(
        admin.financial.update({ id: record.id, responsibleLawyerId: inactiveLawyer.id }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // Deactivate the assigned lawyer → unchanged resubmission is preserved.
      await admin.users.update({ userId: lawyer.id, name: lawyer.name!, email: lawyer.email, role: "senior_associate", status: "inactive" });
      const kept = await admin.financial.update({ id: record.id, responsibleLawyerId: lawyer.id, invoiceNumber: "INV-1" });
      expect(kept.responsibleLawyerId).toBe(lawyer.id);
      expect(kept.responsibleLawyer).toBe(lawyer.name);

      // Replace with an active user.
      const replaced = await admin.financial.update({ id: record.id, responsibleLawyerId: partner.id });
      expect(replaced.responsibleLawyerId).toBe(partner.id);
      expect(replaced.responsibleLawyer).toBe(partner.name);

      // Clear → unlink + mirrored name cleared.
      const cleared = await admin.financial.update({ id: record.id, responsibleLawyerId: null });
      expect(cleared.responsibleLawyerId).toBeNull();
      expect(cleared.responsibleLawyer).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
