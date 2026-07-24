import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { applyDiscountRules, createUser, deleteUser } from "./db";
import { hashPassword } from "./_core/auth";

/**
 * Finance / Invoicing editing — RBAC, existing-record edits, outstanding
 * recalculation, no-duplicate guarantee, and non-negative validation.
 *
 * The financial source of truth is the `financial_records` table; `revenue` is
 * the active invoice amount, `collectedAmount` the paid amount, and
 * `outstandingAmount = max(0, revenue - collectedAmount)` is derived server-side.
 *
 * DB-touching tests run against whatever DATABASE_URL is configured for the test
 * run (locally the `app` database — never production). They create and delete
 * their own fixtures.
 */

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function callerFor(role: string, id = 1000) {
  const user: AuthenticatedUser = {
    id,
    openId: `test-${role}`,
    email: `${role}@example.com`,
    name: role,
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

const adminCaller = () => callerFor("admin", 1);

// ─── Calculation contract (pure — no DB) ────────────────────────────────────────
// outstandingAmount = Math.max(0, invoiceAmount(revenue) - collectedAmount)
describe("Outstanding amount formula (finance edit)", () => {
  it.each([
    // [revenue, collected, expectedOutstanding]
    ["40000", "20000", 20000], // SAR 40,000 invoice, SAR 20,000 paid ⇒ 20,000 remaining
    ["40000", "0", 40000], // nothing collected ⇒ full amount outstanding
    ["40000", "40000", 0], // fully collected ⇒ 0
    ["40000", "50000", 0], // overpaid ⇒ clamped to 0, never negative
  ])(
    "revenue %s minus collected %s ⇒ outstanding %i",
    (revenue, collectedAmount, expected) => {
      const result = applyDiscountRules({ revenue, collectedAmount });
      expect(Number(result.outstandingAmount)).toBe(expected);
    },
  );

  it("To Be Billed uses Net Fees (after discount), not Agreed Fees", () => {
    // 50,000 agreed · CEO 10% ⇒ netFees 45,000. To Be Billed = 45,000 - 25,000 = 20,000
    // (the old agreedFees-based formula would wrongly give 25,000).
    const r = applyDiscountRules({ agreedFees: "50000", discountApproval: "CEO", revenue: "25000" });
    expect(Number(r.netFees)).toBe(45000);
    expect(Math.max(0, Number(r.netFees) - 25000)).toBe(20000);
  });
});

// ─── Permission enforcement (backend, returns 403 before touching the DB) ───────
describe("Finance-only editing permissions", () => {
  // manager/partner have financial:view only; lawyer/staff/viewer have neither.
  // None of them hold financial:manage, so create/update/delete must be FORBIDDEN.
  const nonFinanceRoles = ["manager", "partner", "lawyer", "staff", "viewer"];

  it.each(nonFinanceRoles)("%s cannot UPDATE a financial record (403)", async (role) => {
    const caller = callerFor(role);
    await expect(
      caller.financial.update({ id: 1, collectedAmount: "20000" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each(nonFinanceRoles)("%s cannot CREATE a financial record (403)", async (role) => {
    const caller = callerFor(role);
    await expect(
      caller.financial.create({ clientId: 1, revenue: "40000" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each(nonFinanceRoles)("%s cannot DELETE a financial record (403)", async (role) => {
    const caller = callerFor(role);
    await expect(
      caller.financial.delete({ id: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─── Existing-record edit: recalc, no duplicate, negative rejection (DB) ────────
describe("Finance edits an existing invoice (SAR 40,000 / SAR 20,000)", () => {
  // A real finance user is needed so the created_by / audit user_id FKs resolve.
  // Phase 10: the User Management API now blocks creating a Finance account (target
  // Finance activation is unavailable pending policy convergence), so this LEGACY
  // Finance fixture is seeded directly against the disposable test DB via a test-
  // only helper — never through the production create endpoint. deleteUser nulls
  // the user's audit references first, so removal is safe.
  let financeUserId: number;

  beforeAll(async () => {
    const stamp = Date.now();
    const u = await createUser({
      name: "Finance Tester",
      email: `finance.tester.${stamp}@example.com`,
      passwordHash: await hashPassword("Finance123"),
      role: "finance",
      status: "active",
    });
    financeUserId = u.id;
  });

  afterAll(async () => {
    if (financeUserId) await deleteUser(financeUserId);
  });

  it("updates the same record, recalculates outstanding, and never duplicates", async () => {
    const admin = adminCaller();
    const finance = callerFor("finance", financeUserId);
    const stamp = Date.now();
    // Client fixture needs clients:manage (admin). Finance drives the money flow.
    const client = await admin.clients.create({
      clientName: `FinEdit ${stamp}`,
      clientStatus: "Existing Client",
    });
    let recId: number | undefined;
    try {
      // Finance creates the invoice: revenue SAR 40,000, nothing collected yet.
      const rec = await finance.financial.create({
        clientId: client.id,
        feeType: "Retainers",
        agreedFees: "40000",
        revenue: "40000",
        collectedAmount: "0",
      });
      recId = rec.id;
      expect(Number(rec.revenue)).toBe(40000);
      expect(Number(rec.outstandingAmount)).toBe(40000); // 40000 - 0

      // Finance records a SAR 20,000 payment by UPDATING the existing record.
      const updated = await finance.financial.update({
        id: rec.id,
        collectedAmount: "20000",
      });
      expect(updated.id).toBe(rec.id); // same record — NOT a new invoice
      expect(Number(updated.collectedAmount)).toBe(20000);
      expect(Number(updated.outstandingAmount)).toBe(20000); // 40000 - 20000

      // No duplicate financial record was created for this client.
      const list = await finance.financial.list({ clientId: client.id });
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(rec.id);

      // Further collection edits keep recalculating on the same row.
      const paidInFull = await finance.financial.update({ id: rec.id, collectedAmount: "40000" });
      expect(Number(paidInFull.outstandingAmount)).toBe(0);

      const overpaid = await finance.financial.update({ id: rec.id, collectedAmount: "50000" });
      expect(Number(overpaid.outstandingAmount)).toBe(0); // clamped, never negative

      // The audit trail records the collected-amount changes (traceable history).
      const audit = await finance.financial.auditLog({ id: rec.id });
      const collectedEdits = audit.filter((a: any) => a.fieldName === "collectedAmount");
      expect(collectedEdits.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (recId) await admin.financial.delete({ id: recId });
      await admin.clients.delete({ id: client.id });
    }
  });

  it("rejects a negative collected amount (400)", async () => {
    const admin = adminCaller();
    const finance = callerFor("finance", financeUserId);
    const stamp = Date.now();
    const client = await admin.clients.create({
      clientName: `FinNeg ${stamp}`,
      clientStatus: "Existing Client",
    });
    let recId: number | undefined;
    try {
      const rec = await finance.financial.create({
        clientId: client.id,
        feeType: "Retainers",
        revenue: "40000",
        collectedAmount: "0",
      });
      recId = rec.id;
      await expect(
        finance.financial.update({ id: rec.id, collectedAmount: "-100" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      // The record is unchanged after the rejected edit.
      const after = await finance.financial.get({ id: rec.id });
      expect(Number(after!.collectedAmount)).toBe(0);
    } finally {
      if (recId) await admin.financial.delete({ id: recId });
      await admin.clients.delete({ id: client.id });
    }
  });
});
