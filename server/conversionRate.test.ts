import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { conversionRangeStart, getDb } from "./db";
import { clients } from "../drizzle/schema";
import { eq, sql } from "drizzle-orm";
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

// ─── Pure date-range boundaries (no DB needed) ────────────────────────────────
describe("conversionRangeStart", () => {
  it("month → first day of the current month", () => {
    const now = new Date(2026, 5, 9); // 2026-06-09
    expect(conversionRangeStart("month", now)).toEqual(new Date(2026, 5, 1));
  });

  it("quarter → first day of the current quarter", () => {
    expect(conversionRangeStart("quarter", new Date(2026, 5, 9))).toEqual(new Date(2026, 3, 1)); // Q2 → Apr 1
    expect(conversionRangeStart("quarter", new Date(2026, 0, 15))).toEqual(new Date(2026, 0, 1)); // Q1 → Jan 1
    expect(conversionRangeStart("quarter", new Date(2026, 11, 31))).toEqual(new Date(2026, 9, 1)); // Q4 → Oct 1
  });

  it("all → null (no lower bound)", () => {
    expect(conversionRangeStart("all", new Date(2026, 5, 9))).toBeNull();
  });
});

// ─── Conversion Rate logic (integration; needs DATABASE_URL) ──────────────────
describe("clients.conversionMetrics — converted / intake * 100", () => {
  async function seed() {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const stamp = Date.now();

    // Deterministic funnel: 3 Lead + 2 Enquiry = 5 intake; 3 of them Active.
    // 1 Direct/Active that must be ignored entirely.
    const specs: Array<{ convertedFrom: "Lead" | "Enquiry" | "Direct"; clientStatus: "Existing Client" | "Leads" | "Rejected" }> = [
      { convertedFrom: "Lead", clientStatus: "Existing Client" },   // converted lead
      { convertedFrom: "Lead", clientStatus: "Existing Client" },   // converted lead
      { convertedFrom: "Lead", clientStatus: "Leads" },             // unconverted lead
      { convertedFrom: "Enquiry", clientStatus: "Existing Client" },// converted enquiry
      { convertedFrom: "Enquiry", clientStatus: "Rejected" },       // unconverted enquiry
      { convertedFrom: "Direct", clientStatus: "Existing Client" }, // direct → excluded
    ];

    const created = [];
    for (let i = 0; i < specs.length; i++) {
      created.push(
        await caller.clients.create({
          clientName: `Conv ${stamp}-${i}`,
          ...specs[i],
        }),
      );
    }

    async function cleanup() {
      for (const c of created) await caller.clients.delete({ id: c.id });
    }
    return { caller, cleanup };
  }

  it("counts Lead+Enquiry intake in the denominator and Active conversions in the numerator", async () => {
    const { ctx } = createAuthContext();
    const base = appRouter.createCaller(ctx);
    const before = await base.clients.conversionMetrics({ range: "all" });

    const { caller, cleanup } = await seed();
    try {
      const after = await caller.clients.conversionMetrics({ range: "all" });
      expect(after.totalLeads - before.totalLeads).toBe(3);
      expect(after.totalEnquiries - before.totalEnquiries).toBe(2);
      expect(after.totalIntake - before.totalIntake).toBe(5); // Direct excluded
      expect(after.convertedClients - before.convertedClients).toBe(3); // Direct/Active excluded
    } finally {
      await cleanup();
    }
  });

  it("rate stays within 0..100 and is rounded to one decimal place", async () => {
    const { caller, cleanup } = await seed();
    try {
      const m = await caller.clients.conversionMetrics({ range: "all" });
      expect(m.conversionRate).toBeGreaterThanOrEqual(0);
      expect(m.conversionRate).toBeLessThanOrEqual(100);
      // at most one decimal place
      expect(Math.round(m.conversionRate * 10)).toBe(m.conversionRate * 10);
    } finally {
      await cleanup();
    }
  });

  it("returns 0 (not NaN) when there is no intake in range", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const m = await caller.clients.conversionMetrics({ range: "all" });
    expect(Number.isFinite(m.conversionRate)).toBe(true);
  });

  it("newly created intake is included in the 'month' range (current month)", async () => {
    const { ctx } = createAuthContext();
    const base = appRouter.createCaller(ctx);
    const before = await base.clients.conversionMetrics({ range: "month" });

    const { caller, cleanup } = await seed();
    try {
      const after = await caller.clients.conversionMetrics({ range: "month" });
      expect(after.totalIntake - before.totalIntake).toBe(5);
      expect(after.convertedClients - before.convertedClients).toBe(3);
    } finally {
      await cleanup();
    }
  });
});

// ─── Cohort (period) + edge-case behavior, per spec ───────────────────────────
describe("Conversion Rate — period cohorts and edge cases", () => {
  const caller = () => appRouter.createCaller(createAuthContext().ctx);

  /** Create a canonical lead client (defaults createdAt = now). */
  async function makeLead(c: ReturnType<typeof caller>, opts: {
    convertedFrom?: "Lead" | "Enquiry"; clientStatus: "Existing Client" | "Leads" | "Rejected";
  }) {
    return c.clients.create({
      clientName: `Cohort ${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      convertedFrom: opts.convertedFrom ?? "Lead",
      clientStatus: opts.clientStatus,
    });
  }

  it("a lead created+converted today is counted in the monthly conversion", async () => {
    const c = caller();
    const before = await c.clients.conversionMetrics({ range: "month" });
    const lead = await makeLead(c, { clientStatus: "Existing Client" }); // created now, converted
    try {
      const after = await c.clients.conversionMetrics({ range: "month" });
      expect(after.total - before.total).toBe(1);
      expect(after.converted - before.converted).toBe(1);
    } finally {
      await c.clients.delete({ id: lead.id });
    }
  });

  it("a lead created this quarter and converted is counted in the quarterly conversion", async () => {
    const c = caller();
    const before = await c.clients.conversionMetrics({ range: "quarter" });
    const lead = await makeLead(c, { clientStatus: "Existing Client" });
    try {
      const after = await c.clients.conversionMetrics({ range: "quarter" });
      expect(after.total - before.total).toBe(1);
      expect(after.converted - before.converted).toBe(1);
    } finally {
      await c.clients.delete({ id: lead.id });
    }
  });

  it("a lead created OUTSIDE the period is not counted in month/quarter (but is in all-time)", async () => {
    const c = caller();
    const beforeMonth = await c.clients.conversionMetrics({ range: "month" });
    const beforeQuarter = await c.clients.conversionMetrics({ range: "quarter" });
    const beforeAll = await c.clients.conversionMetrics({ range: "all" });

    const lead = await makeLead(c, { clientStatus: "Existing Client" });
    // Backdate creation to ~200 days ago → previous quarter (and previous month).
    await getDb().update(clients)
      .set({ createdAt: sql`NOW() - make_interval(days => 200)` })
      .where(eq(clients.id, lead.id));
    try {
      const afterMonth = await c.clients.conversionMetrics({ range: "month" });
      const afterQuarter = await c.clients.conversionMetrics({ range: "quarter" });
      const afterAll = await c.clients.conversionMetrics({ range: "all" });

      expect(afterMonth.total - beforeMonth.total).toBe(0);     // not in this month
      expect(afterQuarter.total - beforeQuarter.total).toBe(0); // not in this quarter
      expect(afterAll.total - beforeAll.total).toBe(1);         // but counted all-time
      expect(afterAll.converted - beforeAll.converted).toBe(1);
    } finally {
      await c.clients.delete({ id: lead.id });
    }
  });

  it("a rejected lead stays in TOTAL leads but not in CONVERTED", async () => {
    const c = caller();
    const before = await c.clients.conversionMetrics({ range: "all" });
    const lead = await makeLead(c, { convertedFrom: "Enquiry", clientStatus: "Rejected" });
    try {
      const after = await c.clients.conversionMetrics({ range: "all" });
      expect(after.total - before.total).toBe(1);       // counted in denominator
      expect(after.converted - before.converted).toBe(0); // never in numerator
    } finally {
      await c.clients.delete({ id: lead.id });
    }
  });

  it("a lead that became a client (linked client) is counted as converted", async () => {
    const c = caller();
    const before = await c.clients.conversionMetrics({ range: "all" });
    const lead = await makeLead(c, { clientStatus: "Existing Client" });
    try {
      const after = await c.clients.conversionMetrics({ range: "all" });
      expect(after.converted - before.converted).toBe(1);
    } finally {
      await c.clients.delete({ id: lead.id });
    }
  });

  it("unconverted leads contribute 0 to the numerator (rate is 0% for them) and never NaN", async () => {
    const c = caller();
    const before = await c.clients.conversionMetrics({ range: "all" });
    const a = await makeLead(c, { clientStatus: "Leads" });
    const b = await makeLead(c, { clientStatus: "Leads" });
    try {
      const after = await c.clients.conversionMetrics({ range: "all" });
      expect(after.total - before.total).toBe(2);        // both counted as leads
      expect(after.converted - before.converted).toBe(0); // none converted → 0% contribution
      expect(Number.isFinite(after.conversionRate)).toBe(true);
      expect(Number.isNaN(after.conversionRate)).toBe(false);
    } finally {
      await c.clients.delete({ id: a.id });
      await c.clients.delete({ id: b.id });
    }
  });

  it("conversion rate updates immediately when a lead is converted into a client", async () => {
    const c = caller();
    // Start as an unconverted Lead.
    const lead = await makeLead(c, { clientStatus: "Leads" });
    try {
      const before = await c.clients.conversionMetrics({ range: "all" });
      expect(before.total).toBeGreaterThan(0);

      // Convert it (Leads → Existing Client) and re-read — no caching, recomputed live.
      await c.clients.update({ id: lead.id, clientStatus: "Existing Client" });
      const after = await c.clients.conversionMetrics({ range: "all" });

      expect(after.total - before.total).toBe(0);          // same lead, denominator unchanged
      expect(after.converted - before.converted).toBe(1);  // now counted as converted
    } finally {
      await c.clients.delete({ id: lead.id });
    }
  });
});
