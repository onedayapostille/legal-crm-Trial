import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "admin",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
  return { ctx };
}

// ─── Original Serial = inherited client number (CRM-007; needs DATABASE_URL) ───
// Confirmed rule: original_serial represents the PARENT CLIENT's Original Serial /
// Client Number. It is shared by all of the client's matters and is NOT unique and
// has no MAT-#### format. matter_reference is the matter-level identifier, unique
// per client.
describe("Matter Original Serial — inherited from the parent client number", () => {
  it("defaults original_serial from the client number (e.g. 881)", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const clientNumber = `881-${stamp}`;
    const client = await caller.clients.create({
      clientName: `Sankyo ${stamp}`,
      clientNumber,
      clientStatus: "Existing Client",
    });
    let matterId: number | undefined;
    try {
      const matter = await caller.clientMatters.create({
        clientId: client.id,
        matterType: "Litigation",
        matterReference: `101-${stamp}`,
        // originalSerial omitted → inherits the client number
      });
      matterId = matter.id;
      expect(matter.originalSerial).toBe(clientNumber);
      // No MAT-#### format is imposed.
      expect(matter.originalSerial).not.toMatch(/^MAT-/);
    } finally {
      if (matterId) await caller.clientMatters.delete({ id: matterId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("multiple matters under the same client SHARE the original_serial", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const clientNumber = `881-${stamp}`;
    const client = await caller.clients.create({
      clientName: `Sankyo ${stamp}`,
      clientNumber,
      clientStatus: "Existing Client",
    });
    const ids: number[] = [];
    try {
      const m1 = await caller.clientMatters.create({
        clientId: client.id, matterType: "Litigation", matterReference: `101-${stamp}`,
      });
      const m2 = await caller.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `102-${stamp}`,
      });
      ids.push(m1.id, m2.id);
      // Same original_serial (the client number) — NOT max+1, NOT unique.
      expect(m1.originalSerial).toBe(clientNumber);
      expect(m2.originalSerial).toBe(clientNumber);
      expect(m1.originalSerial).toBe(m2.originalSerial);
      // Distinct matter references.
      expect(m1.matterReference).not.toBe(m2.matterReference);
    } finally {
      for (const id of ids) await caller.clientMatters.delete({ id });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("accepts an explicitly provided original_serial as-is (any value, not unique)", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `Prov ${stamp}`, clientStatus: "Existing Client" });
    const ids: number[] = [];
    try {
      const m1 = await caller.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `A-${stamp}`, originalSerial: "881",
      });
      // A second matter may reuse the same original_serial (not unique).
      const m2 = await caller.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `B-${stamp}`, originalSerial: "881",
      });
      ids.push(m1.id, m2.id);
      expect(m1.originalSerial).toBe("881");
      expect(m2.originalSerial).toBe("881");
    } finally {
      for (const id of ids) await caller.clientMatters.delete({ id });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("falls back to CL-<clientId> when the client has no client number", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `NoNum ${stamp}`, clientStatus: "Existing Client" });
    let matterId: number | undefined;
    try {
      const matter = await caller.clientMatters.create({ clientId: client.id, matterType: "Corporate", matterReference: `F-${stamp}` });
      matterId = matter.id;
      expect(matter.originalSerial).toBe(`CL-${client.id}`);
    } finally {
      if (matterId) await caller.clientMatters.delete({ id: matterId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("refills original_serial from the client number when cleared on edit", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const clientNumber = `881-${stamp}`;
    const client = await caller.clients.create({
      clientName: `Edit ${stamp}`, clientNumber, clientStatus: "Existing Client",
    });
    let matterId: number | undefined;
    try {
      const matter = await caller.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `E-${stamp}`,
      });
      matterId = matter.id;
      const cleared = await caller.clientMatters.update({ id: matter.id, originalSerial: "" });
      expect(cleared.originalSerial).toBe(clientNumber); // refilled, not blank
    } finally {
      if (matterId) await caller.clientMatters.delete({ id: matterId });
      await caller.clients.delete({ id: client.id });
    }
  });
});

// ─── Matter Reference required (CRM-007; needs DATABASE_URL) ───────────────────
describe("Matter Reference is required for create/update", () => {
  it("rejects creating a matter with no Matter Reference", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `ReqRef ${stamp}`, clientStatus: "Existing Client" });
    try {
      await expect(
        caller.clientMatters.create({ clientId: client.id, matterType: "Corporate" }), // no reference
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("rejects clearing the Matter Reference on update", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `ClrRef ${stamp}`, clientStatus: "Existing Client" });
    let matterId: number | undefined;
    try {
      const m = await caller.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `K-${stamp}`,
      });
      matterId = m.id;
      // Editing another field WITHOUT touching the reference is allowed.
      const ok = await caller.clientMatters.update({ id: m.id, matterStatus: "Active" });
      expect(ok.matterReference).toBe(`K-${stamp}`);
      // Explicitly blanking the reference is rejected.
      await expect(
        caller.clientMatters.update({ id: m.id, matterReference: "" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      if (matterId) await caller.clientMatters.delete({ id: matterId });
      await caller.clients.delete({ id: client.id });
    }
  });
});

// ─── Matter Reference uniqueness per client (CRM-007; needs DATABASE_URL) ──────
describe("Matter Reference is unique per client", () => {
  it("rejects a second matter with the same reference for the same client", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `Dup ${stamp}`, clientStatus: "Existing Client" });
    let firstId: number | undefined;
    try {
      const first = await caller.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `REF-${stamp}`,
      });
      firstId = first.id;
      await expect(
        caller.clientMatters.create({
          clientId: client.id, matterType: "Litigation", matterReference: `REF-${stamp}`,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      if (firstId) await caller.clientMatters.delete({ id: firstId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("allows the same reference for DIFFERENT clients", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const ref = `REF-${stamp}`;
    const clientA = await caller.clients.create({ clientName: `DA ${stamp}`, clientStatus: "Existing Client" });
    const clientB = await caller.clients.create({ clientName: `DB ${stamp}`, clientStatus: "Existing Client" });
    try {
      const a = await caller.clientMatters.create({ clientId: clientA.id, matterType: "Corporate", matterReference: ref });
      const b = await caller.clientMatters.create({ clientId: clientB.id, matterType: "Corporate", matterReference: ref });
      expect(a.matterReference).toBe(ref);
      expect(b.matterReference).toBe(ref);
    } finally {
      await caller.clients.delete({ id: clientA.id });
      await caller.clients.delete({ id: clientB.id });
    }
  });

  it("rejects updating a matter's reference to one already used by the same client", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `UpdRef ${stamp}`, clientStatus: "Existing Client" });
    const ids: number[] = [];
    try {
      const a = await caller.clientMatters.create({ clientId: client.id, matterType: "Corporate", matterReference: `RA-${stamp}` });
      const b = await caller.clientMatters.create({ clientId: client.id, matterType: "Corporate", matterReference: `RB-${stamp}` });
      ids.push(a.id, b.id);
      await expect(
        caller.clientMatters.update({ id: b.id, matterReference: `RA-${stamp}` }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      // Re-saving B with its own reference is fine.
      const ok = await caller.clientMatters.update({ id: b.id, matterReference: `RB-${stamp}` });
      expect(ok.matterReference).toBe(`RB-${stamp}`);
    } finally {
      for (const id of ids) await caller.clientMatters.delete({ id });
      await caller.clients.delete({ id: client.id });
    }
  });
});

// ─── Matter Type authority (CRM-006; needs DATABASE_URL) ──────────────────────
describe("Matter Type is authoritative at the matter level", () => {
  it("requires Matter Type on create", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `MT ${stamp}`, clientStatus: "Existing Client" });
    try {
      await expect(
        caller.clientMatters.create({ clientId: client.id }), // no matterType
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("allows multiple matters under one client with DIFFERENT matter types", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `MultiMT ${stamp}`, clientStatus: "Existing Client" });
    const ids: number[] = [];
    try {
      const corp = await caller.clientMatters.create({ clientId: client.id, matterType: "Corporate", matterReference: `c-${stamp}` });
      const lit = await caller.clientMatters.create({ clientId: client.id, matterType: "Litigation", matterReference: `l-${stamp}` });
      ids.push(corp.id, lit.id);
      expect(corp.matterType).toBe("Corporate");
      expect(lit.matterType).toBe("Litigation");

      // Matter Type is now restricted to the shared MATTER_TYPES values
      // (Litigation / Corporate) — editing to another supported value works,
      // but arbitrary new values are rejected (legacy values on old rows are
      // covered in server/matterTypeAndAttorneyCreate.test.ts).
      const edited = await caller.clientMatters.update({ id: corp.id, matterType: "Litigation" });
      expect(edited.matterType).toBe("Litigation");
      await expect(
        caller.clientMatters.update({ id: corp.id, matterType: "Advisory" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      for (const id of ids) await caller.clientMatters.delete({ id });
      await caller.clients.delete({ id: client.id });
    }
  });
});
