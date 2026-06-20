import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { assertValidOriginalSerialFormat } from "./db";
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

const SERIAL_RE = /^MAT-\d{4,}$/;

// ─── Format validation (pure, no DB) ──────────────────────────────────────────
describe("assertValidOriginalSerialFormat", () => {
  it("accepts the canonical MAT-#### format", () => {
    for (const s of ["MAT-0001", "MAT-1234", "MAT-1700000000000"]) {
      expect(() => assertValidOriginalSerialFormat(s)).not.toThrow();
    }
  });

  it("rejects anything that is not MAT- followed by 4+ digits", () => {
    for (const s of ["MAT-1", "MAT-001", "mat-0001", "SER-0001", "0001", "MAT-12a4", "MATTER-0001", ""]) {
      expect(() => assertValidOriginalSerialFormat(s)).toThrow();
    }
  });
});

// ─── Generation, uniqueness, validation (integration; needs DATABASE_URL) ─────
describe("Matter Original Serial — independent generation, uniqueness, validation", () => {
  it("auto-generates a MAT-#### serial that is NOT the client number", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const clientNumber = `CLN-${stamp}`;

    const client = await caller.clients.create({
      clientName: `Serial Client ${stamp}`,
      clientNumber,
      clientStatus: "Existing Client",
    });
    let matterId: number | undefined;
    try {
      const matter = await caller.clientMatters.create({
        clientId: client.id,
        matterType: "Corporate",
        matterReference: `Ref-${stamp}`,
        // originalSerial intentionally omitted → must be auto-generated
      });
      matterId = matter.id;
      expect(matter.originalSerial).toMatch(SERIAL_RE);
      expect(matter.originalSerial).not.toBe(clientNumber); // not the client number
    } finally {
      if (matterId) await caller.clientMatters.delete({ id: matterId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("generates distinct serials for two matters", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `Two Matter ${stamp}`, clientStatus: "Existing Client" });
    const ids: number[] = [];
    try {
      const m1 = await caller.clientMatters.create({ clientId: client.id, matterType: "Corporate", matterReference: `A-${stamp}` });
      const m2 = await caller.clientMatters.create({ clientId: client.id, matterType: "Litigation", matterReference: `B-${stamp}` });
      ids.push(m1.id, m2.id);
      expect(m1.originalSerial).toMatch(SERIAL_RE);
      expect(m2.originalSerial).toMatch(SERIAL_RE);
      expect(m1.originalSerial).not.toBe(m2.originalSerial);
    } finally {
      for (const id of ids) await caller.clientMatters.delete({ id });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("rejects a manual serial in the wrong format", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `BadFmt ${stamp}`, clientStatus: "Existing Client" });
    try {
      await expect(
        caller.clientMatters.create({
          clientId: client.id,
          matterType: "Corporate",
          originalSerial: `SER-${stamp}`, // not MAT-####
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("accepts a unique manual serial and rejects a duplicate", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const manualSerial = `MAT-${stamp}`; // valid format, unique
    const client = await caller.clients.create({ clientName: `Manual ${stamp}`, clientStatus: "Existing Client" });
    let firstId: number | undefined;
    try {
      const first = await caller.clientMatters.create({
        clientId: client.id,
        matterType: "Corporate",
        matterReference: `M1-${stamp}`,
        originalSerial: manualSerial,
      });
      firstId = first.id;
      expect(first.originalSerial).toBe(manualSerial);

      // Duplicate serial → rejected
      await expect(
        caller.clientMatters.create({
          clientId: client.id,
          matterType: "Corporate",
          matterReference: `M2-${stamp}`,
          originalSerial: manualSerial,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      if (firstId) await caller.clientMatters.delete({ id: firstId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("rejects updating a matter to a serial already used by another", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const serialA = `MAT-${stamp}`;
    const serialB = `MAT-${stamp + 1}`;
    const client = await caller.clients.create({ clientName: `Update ${stamp}`, clientStatus: "Existing Client" });
    const ids: number[] = [];
    try {
      const a = await caller.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `UA-${stamp}`, originalSerial: serialA,
      });
      const b = await caller.clientMatters.create({
        clientId: client.id, matterType: "Corporate", matterReference: `UB-${stamp}`, originalSerial: serialB,
      });
      ids.push(a.id, b.id);

      // Try to set B's serial to A's → rejected
      await expect(
        caller.clientMatters.update({ id: b.id, originalSerial: serialA }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      // Setting B to its own serial again is fine (excludes itself / grandfathered)
      const updated = await caller.clientMatters.update({ id: b.id, originalSerial: serialB });
      expect(updated.originalSerial).toBe(serialB);
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
      const corp = await caller.clientMatters.create({ clientId: client.id, matterType: "Corporate" });
      const lit = await caller.clientMatters.create({ clientId: client.id, matterType: "Litigation" });
      ids.push(corp.id, lit.id);
      expect(corp.matterType).toBe("Corporate");
      expect(lit.matterType).toBe("Litigation");

      // Editing matter type at the matter level sticks.
      const edited = await caller.clientMatters.update({ id: corp.id, matterType: "Advisory" });
      expect(edited.matterType).toBe("Advisory");
    } finally {
      for (const id of ids) await caller.clientMatters.delete({ id });
      await caller.clients.delete({ id: client.id });
    }
  });
});
