import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { clients } from "../drizzle/schema";
import { eq, sql } from "drizzle-orm";
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
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}

describe("Recent Leads — last 30 days only, newest first", () => {
  it("includes a freshly created Lead, newest first", async () => {
    const caller = adminCaller();
    const created = await caller.clients.create({
      clientName: `Recent ${Date.now()}`,
      clientStatus: "Leads",
    });
    try {
      const recent = await caller.clients.recentLeads({ days: 30, limit: 5 });
      expect(recent[0]?.id).toBe(created.id);              // newest first
      expect(recent.filter(c => c.id === created.id)).toHaveLength(1); // no dupes
      expect(recent.length).toBeLessThanOrEqual(5);        // capped/short
    } finally {
      await caller.clients.delete({ id: created.id });
    }
  });

  it("EXCLUDES a Lead created more than 30 days ago (old leads not shown)", async () => {
    const caller = adminCaller();
    const db = getDb();
    const old = await caller.clients.create({
      clientName: `Old Lead ${Date.now()}`,
      clientStatus: "Leads",
    });
    try {
      // Backdate created_at to 45 days ago (DB clock) so it falls outside the window.
      await db
        .update(clients)
        .set({ createdAt: sql`NOW() - make_interval(days => 45)` })
        .where(eq(clients.id, old.id));

      const recent = await caller.clients.recentLeads({ days: 30, limit: 50 });
      expect(recent.some(c => c.id === old.id)).toBe(false);

      // …but the full pipeline (no date restriction) still shows it.
      const all = await caller.clients.list({ clientStatus: "Leads" });
      expect(all.some(c => c.id === old.id)).toBe(true);
    } finally {
      await caller.clients.delete({ id: old.id });
    }
  });

  it("respects the limit (short widget)", async () => {
    const caller = adminCaller();
    const ids: number[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const c = await caller.clients.create({ clientName: `Lim ${Date.now()}-${i}`, clientStatus: "Leads" });
        ids.push(c.id);
      }
      const recent = await caller.clients.recentLeads({ days: 30, limit: 2 });
      expect(recent.length).toBe(2);
    } finally {
      for (const id of ids) await caller.clients.delete({ id });
    }
  });
});
