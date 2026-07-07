import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { clientMatters } from "../drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * Phase 2 — Matter Type field coverage.
 *
 * Matter Type lives on `client_matters.matter_type` (free-text, so any value
 * such as Corporate / Litigation / Advisory is accepted). It is already surfaced
 * in create/edit forms, the client-profile Matters tab, the global Matters list,
 * and task context. These tests lock in the two requirement items not covered by
 * the existing suite: it appears in the client-profile data source, and a legacy
 * matter with no type is returned without error (so the UI's `?? "—"` fallback
 * never has to guard against a throw).
 *
 * Create-with-type, required-on-create, and edit-type are already asserted in
 * server/originalSerial.test.ts.
 */

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
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}

describe("Phase 2 — Matter Type visibility & null-safety", () => {
  it("client-profile Matters source (clientMatters.list) returns matterType per matter", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `MTList ${stamp}`, clientStatus: "Existing Client" });
    const ids: number[] = [];
    try {
      const corp = await caller.clientMatters.create({ clientId: client.id, matterType: "Corporate", matterReference: `C-${stamp}` });
      const lit = await caller.clientMatters.create({ clientId: client.id, matterType: "Litigation", matterReference: `L-${stamp}` });
      ids.push(corp.id, lit.id);

      const list = await caller.clientMatters.list({ clientId: client.id });
      const byId = Object.fromEntries(list.map(m => [m.id, m]));
      expect(byId[corp.id].matterType).toBe("Corporate");
      expect(byId[lit.id].matterType).toBe("Litigation");
    } finally {
      for (const id of ids) await caller.clientMatters.delete({ id });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("a legacy matter with NULL matterType is returned without error (no UI crash)", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `MTNull ${stamp}`, clientStatus: "Existing Client" });
    let matterId: number | undefined;
    try {
      // The public API now requires matterType on create, so a pre-CRM-006 legacy
      // row is simulated by nulling the column directly on a valid matter.
      const m = await caller.clientMatters.create({ clientId: client.id, matterType: "Corporate", matterReference: `N-${stamp}` });
      matterId = m.id;
      await getDb().update(clientMatters).set({ matterType: null }).where(eq(clientMatters.id, m.id));

      // Client-profile source and the global Matters source both tolerate null.
      const list = await caller.clientMatters.list({ clientId: client.id });
      const row = list.find(x => x.id === m.id);
      expect(row).toBeDefined();
      expect(row!.matterType).toBeNull(); // legacy value preserved, not defaulted

      const all = await caller.clientMatters.listAll();
      expect(all.some(x => x.id === m.id)).toBe(true);
    } finally {
      if (matterId) await caller.clientMatters.delete({ id: matterId });
      await caller.clients.delete({ id: client.id });
    }
  });

  it("editing matterType updates the same matter (no duplicate, reference preserved)", async () => {
    const caller = adminCaller();
    const stamp = Date.now();
    const client = await caller.clients.create({ clientName: `MTEdit ${stamp}`, clientStatus: "Existing Client" });
    let matterId: number | undefined;
    try {
      const m = await caller.clientMatters.create({ clientId: client.id, matterType: "Corporate", matterReference: `E-${stamp}` });
      matterId = m.id;

      const edited = await caller.clientMatters.update({ id: m.id, matterType: "Litigation" });
      expect(edited.id).toBe(m.id); // same record
      expect(edited.matterType).toBe("Litigation");
      expect(edited.matterReference).toBe(m.matterReference); // reference not broken

      const list = await caller.clientMatters.list({ clientId: client.id });
      expect(list.filter(x => x.id === m.id).length).toBe(1); // no duplicate
    } finally {
      if (matterId) await caller.clientMatters.delete({ id: matterId });
      await caller.clients.delete({ id: client.id });
    }
  });
});
