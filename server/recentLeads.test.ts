import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { clients, leads } from "../drizzle/schema";
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

// ─── 30-day window boundary + timezone correctness ────────────────────────────
// created_at is the standardized date field for "recently added leads". The
// window is computed as NOW() − N days on the DB clock (UTC here), so it is an
// instant comparison, never a browser-timezone calendar-date truncation.
describe("Recent Leads — boundary and timezone behavior", () => {
  /** Create a Lead client and force its created_at to a DB-clock offset. */
  async function leadAged(name: string, ageSql: ReturnType<typeof sql>) {
    const caller = adminCaller();
    const c = await caller.clients.create({ clientName: name, clientStatus: "Leads" });
    await getDb().update(clients).set({ createdAt: ageSql }).where(eq(clients.id, c.id));
    return c;
  }

  it("a lead created TODAY appears", async () => {
    const caller = adminCaller();
    const c = await caller.clients.create({ clientName: `Today ${Date.now()}`, clientStatus: "Leads" });
    try {
      const recent = await caller.clients.recentLeads({ days: 30, limit: 50 });
      expect(recent.some(r => r.id === c.id)).toBe(true);
    } finally {
      await caller.clients.delete({ id: c.id });
    }
  });

  it("a lead created 29 days ago appears; 31 days ago does NOT", async () => {
    const caller = adminCaller();
    const d29 = await leadAged(`D29 ${Date.now()}`, sql`NOW() - make_interval(days => 29)`);
    const d31 = await leadAged(`D31 ${Date.now()}`, sql`NOW() - make_interval(days => 31)`);
    try {
      const recent = await caller.clients.recentLeads({ days: 30, limit: 50 });
      const ids = new Set(recent.map(r => r.id));
      expect(ids.has(d29.id)).toBe(true);
      expect(ids.has(d31.id)).toBe(false);
    } finally {
      await caller.clients.delete({ id: d29.id });
      await caller.clients.delete({ id: d31.id });
    }
  });

  it("UTC/late-day timestamps do not wrongly exclude a lead near the window edge", async () => {
    const caller = adminCaller();
    // 29 days 23 hours old → still inside a 30-day window. A calendar-date (browser
    // timezone) truncation could push this to "30 days ago" and drop it; the
    // instant-based filter keeps it.
    const justInside = await leadAged(`Edge in ${Date.now()}`, sql`NOW() - make_interval(days => 29, hours => 23)`);
    // 30 days 1 hour old → just outside the window.
    const justOutside = await leadAged(`Edge out ${Date.now()}`, sql`NOW() - make_interval(days => 30, hours => 1)`);
    try {
      const recent = await caller.clients.recentLeads({ days: 30, limit: 50 });
      const ids = new Set(recent.map(r => r.id));
      expect(ids.has(justInside.id)).toBe(true);
      expect(ids.has(justOutside.id)).toBe(false);
    } finally {
      await caller.clients.delete({ id: justInside.id });
      await caller.clients.delete({ id: justOutside.id });
    }
  });
});

// ─── Enquiry intake (leads.create) → visible in Recent Leads ──────────────────
// A lead added through the Enquiries Log creates a row in `leads` and mirrors a
// canonical `clients` row (status "Leads", created_at = now) via syncLeadToClient.
// That mirror is what the widget reads, so the enquiry must appear immediately.
describe("Recent Leads — enquiry-flow lead is included", () => {
  it("an enquiry added today appears in Recent Leads (same created_at source)", async () => {
    const caller = adminCaller();
    const db = getDb();
    const name = `Enq Recent ${Date.now()}`;
    const lead = await caller.leads.create({
      dateOfEnquiry: new Date().toISOString().slice(0, 10),
      clientName: name,
      channelType: "Digital Channels",
      channelMedium: "Email",
      currentStatus: "New",
    });
    let mirrorId: number | undefined;
    try {
      const [mirror] = await db.select().from(clients).where(eq(clients.sourceLeadId, lead.id)).limit(1);
      mirrorId = mirror?.id;
      expect(mirror?.clientStatus).toBe("Leads");

      const recent = await caller.clients.recentLeads({ days: 30, limit: 50 });
      expect(recent.some(r => r.id === mirror?.id)).toBe(true);
    } finally {
      if (mirrorId) await db.delete(clients).where(eq(clients.id, mirrorId));
      await db.delete(leads).where(eq(leads.id, lead.id));
    }
  });

  it("Recent Leads reflects a newly added lead on the next fetch (post-add refresh)", async () => {
    // The dashboard invalidates clients.recentLeads after an add; this asserts the
    // backing query returns the new lead on a subsequent call (what the refetch hits).
    const caller = adminCaller();
    const before = await caller.clients.recentLeads({ days: 30, limit: 50 });
    const created = await caller.clients.create({ clientName: `Refresh ${Date.now()}`, clientStatus: "Leads" });
    try {
      expect(before.some(r => r.id === created.id)).toBe(false);
      const after = await caller.clients.recentLeads({ days: 30, limit: 50 });
      expect(after.some(r => r.id === created.id)).toBe(true);
    } finally {
      await caller.clients.delete({ id: created.id });
    }
  });
});
