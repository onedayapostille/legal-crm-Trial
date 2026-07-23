import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import type { UserRole } from "../shared/const";
import { getDb } from "./db";
import { clientMatters } from "../drizzle/schema";
import { eq } from "drizzle-orm";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function ctxFor(role: UserRole, id = 1): TrpcContext {
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
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

const admin = () => appRouter.createCaller(ctxFor("admin"));
const PW = "Passw0rd123";

let seq = 0;
const stamp = () => `${Date.now()}${seq++}`;

async function seedClient(caller: ReturnType<typeof admin>, s: string) {
  return caller.clients.create({ clientName: `MT ${s}`, clientStatus: "Existing Client" });
}

describe("Matter Type — restricted dropdown values, legacy preservation", () => {
  it("create accepts Litigation", async () => {
    const caller = admin();
    const s = stamp();
    const client = await seedClient(caller, s);
    try {
      const m = await caller.clientMatters.create({
        clientId: client.id, matterType: "Litigation", matterReference: `LIT-${s}`, acknowledgeConflicts: true,
      });
      expect(m.matterType).toBe("Litigation");
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("create accepts Corporate", async () => {
    const caller = admin();
    const s = stamp();
    const client = await seedClient(caller, s);
    try {
      const m = await caller.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `CORP-${s}`, acknowledgeConflicts: true,
      });
      expect(m.matterType).toBe("Corporate");
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("create rejects an unsupported Matter Type", async () => {
    const caller = admin();
    const s = stamp();
    const client = await seedClient(caller, s);
    try {
      await expect(
        caller.clientMatters.create({
          clientId: client.id, matterType: "Advisory" as any, matterReference: `ADV-${s}`, acknowledgeConflicts: true,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("historical legacy value stays readable, survives unrelated edits, and can be upgraded — but a NEW unsupported value is rejected", async () => {
    const caller = admin();
    const s = stamp();
    const client = await seedClient(caller, s);
    try {
      const m = await caller.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `LEG-${s}`, acknowledgeConflicts: true,
      });
      // Simulate a pre-dropdown historical row (no public API writes such values).
      await getDb().update(clientMatters)
        .set({ matterType: "Commercial Advisory" })
        .where(eq(clientMatters.id, m.id));

      // 1. Still readable through the normal list API.
      const list = await caller.clientMatters.list({ clientId: client.id });
      expect(list.find(x => x.id === m.id)?.matterType).toBe("Commercial Advisory");

      // 2. Edit form re-submits the unchanged legacy value alongside other edits → allowed.
      const updated = await caller.clientMatters.update({
        id: m.id, matterType: "Commercial Advisory", matterDescription: "touched",
      });
      expect(updated.matterType).toBe("Commercial Advisory");
      expect(updated.matterDescription).toBe("touched");

      // 3. A NEW unsupported value is rejected.
      await expect(
        caller.clientMatters.update({ id: m.id, matterType: "Arbitration" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // 4. Upgrading the legacy value to a supported one works.
      const upgraded = await caller.clientMatters.update({ id: m.id, matterType: "Litigation" });
      expect(upgraded.matterType).toBe("Litigation");
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });
});

describe("Add New Attorney — permissions, eligibility, assignment safety", () => {
  it("admin can create an attorney via users.create; the active user appears immediately in eligibleLawyers", async () => {
    const caller = admin();
    const s = stamp();
    const user = await caller.users.create({
      name: `New Attorney ${s}`, email: `na${s}@x.com`, password: PW, role: "associate", status: "active",
    });
    try {
      expect(user.status).toBe("active");
      expect(user).not.toHaveProperty("passwordHash"); // no sensitive data returned
      for (const field of ["attorney1", "supportLead", "leadPartner"] as const) {
        const eligible = await caller.users.eligibleLawyers({ field });
        expect(eligible.map(u => u.id)).toContain(user.id);
        // Dropdown responses never expose password material.
        for (const u of eligible) expect(u).not.toHaveProperty("passwordHash");
      }
    } finally {
      await caller.users.delete({ userId: user.id });
    }
  });

  it("non-admin roles cannot create users (backend enforced)", async () => {
    for (const role of ["partner", "lawyer", "manager", "finance", "staff"] as const) {
      const caller = appRouter.createCaller(ctxFor(role, 999_000 + seq++));
      await expect(
        caller.users.create({ name: "X", email: `x${stamp()}@x.com`, password: PW, role: "associate" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("duplicate email is rejected with CONFLICT", async () => {
    const caller = admin();
    const s = stamp();
    const email = `dup${s}@x.com`;
    const user = await caller.users.create({ name: `Dup ${s}`, email, password: PW, role: "associate" });
    try {
      await expect(
        caller.users.create({ name: `Dup2 ${s}`, email, password: PW, role: "associate" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await caller.users.delete({ userId: user.id });
    }
  });

  it("an inactive new user is not listed and cannot be assigned as an attorney", async () => {
    const caller = admin();
    const s = stamp();
    const inactive = await caller.users.create({
      name: `Inactive ${s}`, email: `in${s}@x.com`, password: PW, role: "associate", status: "inactive",
    });
    const client = await seedClient(caller, s);
    try {
      const eligible = await caller.users.eligibleLawyers({ field: "attorney1" });
      expect(eligible.map(u => u.id)).not.toContain(inactive.id);

      await expect(
        caller.clientMatters.create({
          clientId: client.id, matterType: "Litigation", matterReference: `IN-${s}`,
          attorney1Id: inactive.id, acknowledgeConflicts: true,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await caller.clients.delete({ id: client.id });
      await caller.users.delete({ userId: inactive.id });
    }
  });

  it("the same user cannot fill two Attorney 1–4 slots (create and update)", async () => {
    const caller = admin();
    const s = stamp();
    const lawyer = await caller.users.create({ name: `DupSlot ${s}`, email: `ds${s}@x.com`, password: PW, role: "associate" });
    const lawyer2 = await caller.users.create({ name: `DupSlot2 ${s}`, email: `ds2${s}@x.com`, password: PW, role: "associate" });
    const client = await seedClient(caller, s);
    try {
      // Create: same user in two slots → rejected.
      await expect(
        caller.clientMatters.create({
          clientId: client.id, matterType: "Corporate", matterReference: `DUP-${s}`,
          attorney1Id: lawyer.id, attorney2Id: lawyer.id, acknowledgeConflicts: true,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // Update: crafted request duplicating an existing slot → rejected.
      const m = await caller.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `DUP2-${s}`,
        attorney1Id: lawyer.id, attorney2Id: lawyer2.id, acknowledgeConflicts: true,
      });
      await expect(
        caller.clientMatters.update({ id: m.id, attorney2Id: lawyer.id }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await caller.clients.delete({ id: client.id });
      await caller.users.delete({ userId: lawyer.id });
      await caller.users.delete({ userId: lawyer2.id });
    }
  });

  it("Add Matter and Edit Matter both save correctly with dropdown types and a newly created attorney", async () => {
    const caller = admin();
    const s = stamp();
    const attorney = await caller.users.create({ name: `Flow Attorney ${s}`, email: `fa${s}@x.com`, password: PW, role: "associate" });
    const client = await seedClient(caller, s);
    try {
      // Add Matter: Litigation + newly created attorney as Attorney 1.
      const m = await caller.clientMatters.create({
        clientId: client.id, matterType: "Litigation", matterReference: `FLOW-${s}`,
        attorney1Id: attorney.id, acknowledgeConflicts: true,
      });
      expect(m.matterType).toBe("Litigation");
      expect(m.attorney1Id).toBe(attorney.id);
      expect(m.attorney1).toBe(attorney.name); // display name mirrored server-side

      // Edit Matter: switch type to Corporate, move attorney to slot 2.
      const updated = await caller.clientMatters.update({
        id: m.id, matterType: "Corporate", attorney1Id: null, attorney2Id: attorney.id,
      });
      expect(updated.matterType).toBe("Corporate");
      expect(updated.attorney1Id).toBeNull();
      expect(updated.attorney2Id).toBe(attorney.id);
    } finally {
      await caller.clients.delete({ id: client.id });
      await caller.users.delete({ userId: attorney.id });
    }
  });
});
