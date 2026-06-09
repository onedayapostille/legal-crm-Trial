import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
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
  return appRouter.createCaller(ctx);
}

const LOCK_MSG = "This client is marked as Rejected. No new records can be created or modified.";

describe("Rejected client lock — backend enforcement (403)", () => {
  it("blocks creating a matter under a rejected client", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `Rej ${stamp}`, clientStatus: "Rejected" });
    try {
      await expect(
        caller.clientMatters.create({ clientId: client.id, matterReference: `M-${stamp}` }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", message: LOCK_MSG });
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("blocks creating a financial record under a rejected client", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `RejFin ${stamp}`, clientStatus: "Rejected" });
    try {
      await expect(
        caller.financial.create({ clientId: client.id, agreedFees: "1000" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("blocks logging an action under a rejected client", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `RejAct ${stamp}`, clientStatus: "Rejected" });
    try {
      await expect(
        caller.clientActions.create({ clientId: client.id, actionDetails: "follow up" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("blocks editing fields of a rejected client, but ALLOWS reactivation", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `RejEdit ${stamp}`, clientStatus: "Rejected" });
    try {
      // A plain field edit (no status move) is blocked.
      await expect(
        caller.clients.update({ id: client.id, clientName: `Renamed ${stamp}` }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // Moving out of Rejected (reactivation) is allowed.
      const reactivated = await caller.clients.update({ id: client.id, clientStatus: "Leads" });
      expect(reactivated.clientStatus).toBe("Leads");
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("blocks editing an existing matter once its client becomes Rejected, but keeps it visible", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    // Create as active, add a matter, THEN reject.
    const client = await caller.clients.create({ clientName: `Flip ${stamp}`, clientStatus: "Existing Client" });
    try {
      const matter = await caller.clientMatters.create({ clientId: client.id, matterReference: `FM-${stamp}` });
      await caller.clients.update({ id: client.id, clientStatus: "Rejected" });

      // Existing matter stays visible (read).
      const list = await caller.clientMatters.list({ clientId: client.id });
      expect(list.some(m => m.id === matter.id)).toBe(true);

      // But editing it is now blocked.
      await expect(
        caller.clientMatters.update({ id: matter.id, matterType: "Litigation" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await caller.clients.delete({ id: client.id });
    }
  });

  it("allows normal create on a non-rejected client (control)", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `OK ${stamp}`, clientStatus: "Existing Client" });
    let matterId: number | undefined;
    try {
      const matter = await caller.clientMatters.create({ clientId: client.id, matterReference: `OKM-${stamp}` });
      matterId = matter.id;
      expect(matter.id).toBeGreaterThan(0);
    } finally {
      if (matterId) await caller.clientMatters.delete({ id: matterId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("writes a status_changed audit entry when a client is moved to Rejected", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `Aud ${stamp}`, clientStatus: "Leads" });
    try {
      await caller.clients.update({ id: client.id, clientStatus: "Rejected" });
      const trail = await caller.auditLogs.byEntity({ entityType: "client", entityId: client.id });
      const moved = trail.find(
        (e: any) => e.action === "status_changed" && e.newValue === "Rejected",
      );
      expect(moved).toBeTruthy();
    } finally {
      // client is rejected now; delete is still allowed for cleanup
      await caller.clients.update({ id: client.id, clientStatus: "Leads" });
      await caller.clients.delete({ id: client.id });
    }
  });
});
