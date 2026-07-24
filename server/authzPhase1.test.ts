/**
 * Phase 1 authorization hotfix — direct tRPC coverage.
 *
 * Verifies (against appRouter.createCaller, i.e. the real middleware chain):
 *   1. Manager is firm-wide READ-ONLY: list/get/report reads succeed, every
 *      mutation is rejected with FORBIDDEN.
 *   2. payments:view alone can never create/update a payment; payments:manage
 *      (finance/admin) can.
 *   3. clients:manage alone can neither read nor write matter lawyer rates —
 *      rates ride on financial:view / financial:manage.
 *   4. The generic clientMatters.update cannot change leadLawyerId without
 *      matters:assign_lawyer (unchanged re-submissions still pass).
 *   5. Conservative gates on notes / companies / chat / audit / activity hold.
 *
 * FORBIDDEN assertions never reach the DB (the permission middleware throws
 * before the resolver). Positive tests read — and, for the fixture-based
 * suites, write — the LOCAL dev database only, and clean up after themselves
 * (same pattern as leadLawyerAssignment.test.ts).
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { ROLE_PERMISSIONS } from "../shared/const";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function callerFor(role: string, id = 1) {
  const user: AuthenticatedUser = {
    id,
    openId: `test-${id}`,
    email: `u${id}@example.com`,
    name: `User ${id}`,
    loginMethod: "manus",
    role: role as any,
    authorizationModel: (["admin", "manager", "partner", "lawyer", "finance", "staff", "viewer"].includes(role) ? "legacy" : "target") as any,
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

const admin = () => callerFor("admin", 1);
const manager = () => callerFor("manager", 1);
const PW = "Passw0rd123";

const FORBIDDEN = { code: "FORBIDDEN" };

describe("role permission matrix (shared/const.ts)", () => {
  it("manager holds no mutation capability at all", () => {
    const perms = ROLE_PERMISSIONS.manager;
    expect(perms.some(p => p.endsWith(":manage"))).toBe(false);
    expect(perms).not.toContain("*");
    expect(perms).not.toContain("matters:assign_lawyer");
  });

  it("manager keeps the approved read surface", () => {
    for (const p of [
      "dashboard:view", "clients:view", "leads:view", "matters:view",
      "tasks:view", "actions:view", "notes:view", "payments:view",
      "financial:view", "analytics:view", "audit:view",
    ]) {
      expect(ROLE_PERMISSIONS.manager).toContain(p);
    }
  });
});

describe("manager reads still work", () => {
  it("can list clients, leads, matters, tasks and client matters", async () => {
    const m = manager();
    await expect(m.clients.list({})).resolves.toBeInstanceOf(Array);
    await expect(m.leads.list({})).resolves.toBeInstanceOf(Array);
    await expect(m.matters.list()).resolves.toBeInstanceOf(Array);
    await expect(m.tasks.list({})).resolves.toBeInstanceOf(Array);
    await expect(m.clientMatters.listAll({})).resolves.toBeInstanceOf(Array);
  });

  it("can read financial summaries and reports (financial:view)", async () => {
    const m = manager();
    const summary = await m.financial.summary();
    expect(summary).toHaveProperty("totalRevenue");
    const report = await m.financialReports.summary({});
    expect(report).toBeTruthy();
    await expect(m.payments.list()).resolves.toBeInstanceOf(Array);
  });

  it("can read rates, audit logs, activity and user activity stats", async () => {
    const m = manager();
    await expect(m.matterLawyerRates.list({ clientMatterId: 999999999 })).resolves.toBeInstanceOf(Array);
    await expect(m.auditLogs.byEntity({ entityType: "client", entityId: 999999999 })).resolves.toBeInstanceOf(Array);
    await expect(m.dashboard.recentActivity({ limit: 1 })).resolves.toBeInstanceOf(Array);
    await expect(m.users.activityStats({ userId: 1 })).resolves.toHaveProperty("leadsCreated");
    await expect(m.notes.byEntity({ entityType: "client", entityId: 999999999 })).resolves.toBeInstanceOf(Array);
    await expect(m.chat.list()).resolves.toBeInstanceOf(Array);
    await expect(m.clientActions.list({})).resolves.toBeInstanceOf(Array);
  });
});

describe("manager is denied every mutation (FORBIDDEN, before any DB access)", () => {
  it("leads", async () => {
    const m = manager();
    await expect(m.leads.create({ dateOfEnquiry: "2026-01-01", clientName: "X" })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.leads.update({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.leads.delete({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
  });

  it("matters", async () => {
    const m = manager();
    await expect(m.matters.create({ title: "X", clientName: "X" })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.matters.update({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.matters.delete({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
  });

  it("tasks — update, reassign (via update), delete and create", async () => {
    const m = manager();
    await expect(m.tasks.create({ title: "X", clientId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.tasks.update({ id: 1, status: "done" })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.tasks.update({ id: 1, assignedTo: 2 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.tasks.delete({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
  });

  it("clients and client sub-resources", async () => {
    const m = manager();
    await expect(m.clients.create({ clientName: "X" })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.clients.update({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.clients.delete({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.clients.upsertLeadDetail({ clientId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.clients.upsertRejectedDetail({ clientId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.import.clients({ rows: [] })).rejects.toMatchObject(FORBIDDEN);
  });

  it("client matters incl. lead-lawyer reassignment", async () => {
    const m = manager();
    await expect(m.clientMatters.create({ clientId: 1, matterType: "Litigation" })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.clientMatters.update({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.clientMatters.update({ id: 1, leadLawyerId: 2 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.clientMatters.delete({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.clientMatters.reassignLeadLawyer({ clientMatterId: 1, userId: 2 })).rejects.toMatchObject(FORBIDDEN);
  });

  it("payments, rates and financial records", async () => {
    const m = manager();
    await expect(m.payments.create({ leadId: 1, matterCode: "X" })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.payments.update({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.matterLawyerRates.create({ clientMatterId: 1, userId: 1, hourlyRate: "100" })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.matterLawyerRates.update({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.matterLawyerRates.delete({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.financial.create({ clientId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.financial.update({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.financial.delete({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
  });

  it("actions, notes, companies, chat, settings, users", async () => {
    const m = manager();
    await expect(m.clientActions.create({ clientId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.clientActions.update({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.clientActions.delete({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.notes.create({ content: "x", entityType: "client", entityId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.notes.delete({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.companies.create({ name: "X" })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.companies.update({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.chat.updateStatus({ id: 1, status: "read" })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.settings.update({ key: "overdue_days", value: "90" })).rejects.toMatchObject(FORBIDDEN);
    await expect(m.users.create({ name: "X", email: "authz-x@example.com", password: PW })).rejects.toMatchObject(FORBIDDEN);
  });
});

describe("payments:view alone cannot create/update payments", () => {
  it("partner (payments:view, no payments:manage) is denied", async () => {
    const p = callerFor("partner", 1);
    await expect(p.payments.create({ leadId: 1, matterCode: "X" })).rejects.toMatchObject(FORBIDDEN);
    await expect(p.payments.update({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
  });

  it("finance (payments:manage) can create and update a payment", async () => {
    const a = admin();
    const f = callerFor("finance", 1);
    const stamp = Date.now();
    const lead = await a.leads.create({
      dateOfEnquiry: "2026-01-15",
      clientName: `AuthzPayment ${stamp}`,
      channelType: "Walk-in",
    });
    const payment = await f.payments.create({
      leadId: lead.id,
      matterCode: `AUTHZ-${stamp}`,
      totalAmount: "1000",
      paymentStatus: "Not Started",
    });
    expect(payment).toHaveProperty("id");
    const updated = await f.payments.update({ id: payment.id, paymentStatus: "Partially Paid" });
    expect(updated.paymentStatus).toBe("Partially Paid");
    // The payments row keeps an FK to the lead (no cascade), so the lead stays —
    // same as payments.test.ts. Remove only the mirrored client rows.
    for (const c of await a.clients.list({ search: `AuthzPayment ${stamp}` })) {
      await a.clients.delete({ id: c.id });
    }
  });
});

describe("client management alone cannot touch matter rates", () => {
  it("lawyer/staff (clients:manage, no financial authority) cannot read or write rates", async () => {
    const lw = callerFor("lawyer", 1);
    const st = callerFor("staff", 1);
    await expect(lw.matterLawyerRates.list({ clientMatterId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(st.matterLawyerRates.list({ clientMatterId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(lw.clientMatters.billableLawyers({ clientMatterId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(lw.matterLawyerRates.create({ clientMatterId: 1, userId: 1, hourlyRate: "100" })).rejects.toMatchObject(FORBIDDEN);
    await expect(st.matterLawyerRates.update({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(st.matterLawyerRates.delete({ id: 1 })).rejects.toMatchObject(FORBIDDEN);
  });

  it("finance keeps rate access (financial:view via financial:manage)", async () => {
    const f = callerFor("finance", 1);
    await expect(f.matterLawyerRates.list({ clientMatterId: 999999999 })).resolves.toBeInstanceOf(Array);
  });
});

describe("clientMatters.update cannot smuggle a lead-lawyer change", () => {
  it("staff can edit a matter but not change (or unlink) leadLawyerId; partner can", async () => {
    const a = admin();
    const stamp = Date.now();
    const l1 = await a.users.create({ name: `AuthzL1 ${stamp}`, email: `authz-l1-${stamp}@x.com`, password: PW, role: "lawyer" });
    const l2 = await a.users.create({ name: `AuthzL2 ${stamp}`, email: `authz-l2-${stamp}@x.com`, password: PW, role: "lawyer" });
    const staffUser = await a.users.create({ name: `AuthzStaff ${stamp}`, email: `authz-st-${stamp}@x.com`, password: PW, role: "staff" });
    const partnerUser = await a.users.create({ name: `AuthzPartner ${stamp}`, email: `authz-pa-${stamp}@x.com`, password: PW, role: "partner" });
    const client = await a.clients.create({ clientName: `AuthzMatter ${stamp}`, clientStatus: "Existing Client" });
    const matter = await a.clientMatters.create({
      clientId: client.id,
      matterType: "Litigation",
      matterReference: `AUTHZ-${stamp}`,
      leadLawyerId: l1.id,
    });
    try {
      const staff = callerFor("staff", staffUser.id);
      const partner = callerFor("partner", partnerUser.id);

      // Changing the lead lawyer via the generic update → FORBIDDEN.
      await expect(
        staff.clientMatters.update({ id: matter.id, leadLawyerId: l2.id }),
      ).rejects.toMatchObject(FORBIDDEN);
      // Unlinking is also a change → FORBIDDEN.
      await expect(
        staff.clientMatters.update({ id: matter.id, leadLawyerId: null }),
      ).rejects.toMatchObject(FORBIDDEN);

      // Re-submitting the UNCHANGED value (forms send every field) still works.
      const unchanged = await staff.clientMatters.update({
        id: matter.id,
        leadLawyerId: l1.id,
        matterStatus: "Active",
      });
      expect(unchanged.leadLawyerId).toBe(l1.id);
      expect(unchanged.matterStatus).toBe("Active");

      // A holder of matters:assign_lawyer may change it through the same path.
      const reassigned = await partner.clientMatters.update({ id: matter.id, leadLawyerId: l2.id });
      expect(reassigned.leadLawyerId).toBe(l2.id);
    } finally {
      await a.clientMatters.delete({ id: matter.id });
      await a.clients.delete({ id: client.id });
      for (const u of [l1, l2, staffUser, partnerUser]) await a.users.delete({ userId: u.id });
    }
  });
});

describe("dashboard financial suppression", () => {
  it("zeroes financial aggregates for callers without financial:view", async () => {
    const st = callerFor("staff", 1);
    const stats = await st.dashboard.stats();
    expect(stats.totalRevenue).toBe(0);
    const clientStats = await st.clients.dashboardStats();
    expect(clientStats.totalRevenue).toBe(0);
    expect(clientStats.totalOutstanding).toBe(0);
    expect(clientStats.overdueCount).toBe(0);
    expect(clientStats.totalToBeBilled).toBe(0);
    // Non-financial fields stay intact.
    expect(typeof clientStats.total).toBe("number");
  });

  it("keeps real values for financial:view holders (manager)", async () => {
    const m = manager();
    const stats = await m.clients.dashboardStats();
    expect(typeof stats.totalRevenue).toBe("number");
  });
});

describe("conservative gates on audit/activity surfaces", () => {
  it("non-audit roles are denied activity and audit reads", async () => {
    const st = callerFor("staff", 1);
    const vw = callerFor("viewer", 1);
    await expect(st.dashboard.recentActivity({ limit: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(st.auditLogs.byEntity({ entityType: "client", entityId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(st.users.activityStats({ userId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(vw.notes.byEntity({ entityType: "client", entityId: 1 })).rejects.toMatchObject(FORBIDDEN);
    await expect(vw.chat.list()).rejects.toMatchObject(FORBIDDEN);
  });
});
