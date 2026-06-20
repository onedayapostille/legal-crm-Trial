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

describe("Conflict Check — search, matter check, and creation gate", () => {
  it("searchConflicts returns normalized matches across clients, matters, and opposing party", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const adverseName = `Adverse Holdings ${stamp}`;
    const matterRef = `ProjectX-${stamp}`;

    const owner = await caller.clients.create({ clientName: `Owner ${stamp}`, clientStatus: "Existing Client" });
    // An existing client whose name will appear as another matter's opposing party.
    const adverse = await caller.clients.create({ clientName: adverseName, clientStatus: "Leads" });
    const matter = await caller.clientMatters.create({
      clientId: owner.id,
      matterType: "Corporate",
      matterReference: matterRef,
      opposingParty: adverseName,
      acknowledgeConflicts: true, // adverseName matches the existing client → ack needed
    });

    try {
      // 1) Search by the adverse name → Client match (the adverse client) + Opposing Party match (the matter)
      const byName = await caller.clients.conflictCheck({ query: adverseName });
      expect(byName.some(m => m.matchType === "Client" && m.recordId === adverse.id)).toBe(true);
      expect(byName.some(m => m.matchType === "Opposing Party" && m.recordId === matter.id)).toBe(true);

      // every match carries the required normalized fields
      for (const m of byName) {
        expect(m).toMatchObject({
          matchType: expect.any(String),
          recordId: expect.any(Number),
          name: expect.any(String),
          status: expect.any(String),
        });
      }

      // 2) Search by matter reference → Matter match
      const byRef = await caller.clients.conflictCheck({ query: matterRef });
      expect(byRef.some(m => m.matchType === "Matter" && m.recordId === matter.id)).toBe(true);
    } finally {
      await caller.clientMatters.delete({ id: matter.id });
      await caller.clients.delete({ id: owner.id });
      await caller.clients.delete({ id: adverse.id });
    }
  });

  it("checkConflicts (matter form) merges matterName + opposingParty and de-dupes", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const adverseName = `Rival LLC ${stamp}`;

    const adverse = await caller.clients.create({ clientName: adverseName, clientStatus: "Existing Client" });
    try {
      const matches = await caller.clientMatters.checkConflicts({ opposingParty: adverseName });
      expect(matches.some(m => m.matchType === "Client" && m.recordId === adverse.id)).toBe(true);

      // de-dup: same term in both fields must not double a match
      const dup = await caller.clientMatters.checkConflicts({ matterName: adverseName, opposingParty: adverseName });
      const keys = dup.map(m => `${m.matchType}:${m.recordId}`);
      expect(new Set(keys).size).toBe(keys.length);
    } finally {
      await caller.clients.delete({ id: adverse.id });
    }
  });

  it("blocks matter creation when opposing party matches an existing client, unless acknowledged", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();
    const adverseName = `Opponent Inc ${stamp}`;

    const owner = await caller.clients.create({ clientName: `Owner ${stamp}`, clientStatus: "Existing Client" });
    const adverse = await caller.clients.create({ clientName: adverseName, clientStatus: "Leads" });
    let createdMatterId: number | undefined;

    try {
      // Without acknowledgement → rejected with CONFLICT
      await expect(
        caller.clientMatters.create({
          clientId: owner.id,
          matterReference: `M-block-${stamp}`,
          opposingParty: adverseName,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      // With acknowledgement → created
      const matter = await caller.clientMatters.create({
        clientId: owner.id,
        matterType: "Corporate",
        matterReference: `M-ack-${stamp}`,
        opposingParty: adverseName,
        acknowledgeConflicts: true,
      });
      createdMatterId = matter.id;
      expect(matter.id).toBeGreaterThan(0);
      expect(matter.opposingParty).toBe(adverseName);
    } finally {
      if (createdMatterId) await caller.clientMatters.delete({ id: createdMatterId });
      await caller.clients.delete({ id: owner.id });
      await caller.clients.delete({ id: adverse.id });
    }
  });

  it("creates a matter with no conflict without requiring acknowledgement", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();

    const owner = await caller.clients.create({ clientName: `Owner ${stamp}`, clientStatus: "Existing Client" });
    let matterId: number | undefined;
    try {
      const matter = await caller.clientMatters.create({
        clientId: owner.id,
        matterType: "Corporate",
        matterReference: `Unique-${stamp}`,
        opposingParty: `Nobody-Match-${stamp}`,
      });
      matterId = matter.id;
      expect(matter.id).toBeGreaterThan(0);
    } finally {
      if (matterId) await caller.clientMatters.delete({ id: matterId });
      await caller.clients.delete({ id: owner.id });
    }
  });
});
