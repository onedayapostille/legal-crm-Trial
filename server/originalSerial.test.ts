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

const SERIAL_RE = /^MAT-\d{4,}$/;

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
      const m1 = await caller.clientMatters.create({ clientId: client.id, matterReference: `A-${stamp}` });
      const m2 = await caller.clientMatters.create({ clientId: client.id, matterReference: `B-${stamp}` });
      ids.push(m1.id, m2.id);
      expect(m1.originalSerial).toMatch(SERIAL_RE);
      expect(m2.originalSerial).toMatch(SERIAL_RE);
      expect(m1.originalSerial).not.toBe(m2.originalSerial);
    } finally {
      for (const id of ids) await caller.clientMatters.delete({ id });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("accepts a unique manual serial and rejects a duplicate", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const manualSerial = `SER-MANUAL-${stamp}`;
    const client = await caller.clients.create({ clientName: `Manual ${stamp}`, clientStatus: "Existing Client" });
    let firstId: number | undefined;
    try {
      const first = await caller.clientMatters.create({
        clientId: client.id,
        matterReference: `M1-${stamp}`,
        originalSerial: manualSerial,
      });
      firstId = first.id;
      expect(first.originalSerial).toBe(manualSerial);

      // Duplicate serial → rejected
      await expect(
        caller.clientMatters.create({
          clientId: client.id,
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
    const client = await caller.clients.create({ clientName: `Update ${stamp}`, clientStatus: "Existing Client" });
    const ids: number[] = [];
    try {
      const a = await caller.clientMatters.create({
        clientId: client.id, matterReference: `UA-${stamp}`, originalSerial: `S-A-${stamp}`,
      });
      const b = await caller.clientMatters.create({
        clientId: client.id, matterReference: `UB-${stamp}`, originalSerial: `S-B-${stamp}`,
      });
      ids.push(a.id, b.id);

      // Try to set B's serial to A's → rejected
      await expect(
        caller.clientMatters.update({ id: b.id, originalSerial: `S-A-${stamp}` }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      // Setting B to its own serial again is fine (excludes itself)
      const updated = await caller.clientMatters.update({ id: b.id, originalSerial: `S-B-${stamp}` });
      expect(updated.originalSerial).toBe(`S-B-${stamp}`);
    } finally {
      for (const id of ids) await caller.clientMatters.delete({ id });
      await caller.clients.delete({ id: client.id });
    }
  });
});
