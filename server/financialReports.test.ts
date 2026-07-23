import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}

function callerFor(role: AuthenticatedUser["role"], id = 999_999) {
  const user: AuthenticatedUser = {
    id,
    openId: `test-${role}`,
    email: `test-${role}@example.com`,
    name: `Test ${role}`,
    loginMethod: "manus",
    role,
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

const PW = "Passw0rd123";

/** Exact display-independent column sum: integer cents (mirrors the UI). */
const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);
const sumCents = (vals: Array<string | number | null | undefined>) =>
  vals.reduce<number>((a, v) => a + cents(v), 0);

/** Same day-difference rule as the backend (CURRENT_DATE − billing_date).
 *  Calendar-day arithmetic via UTC components — immune to DST offsets. */
function daysSince(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((todayUtc - Date.UTC(y, m - 1, d)) / 86_400_000);
}

/**
 * Fixture (single client, isolated from other DB rows by filtering clientId):
 *   Matter M1: leadLawyerId = partner, attorney1–4 = second lawyer (multi-attorney
 *              matter — must NOT multiply financial aggregation), billingType Retainers.
 *   R1 (M1):  agreed 1000, revenue 600,  collected 250.10, Billed,   billed 2026-01-15, lawyer L, fee Billable Hours
 *   R2 (none):agreed 500,  revenue 500,  collected 500,    Fully Collected, billed 2025-12-01, lawyer L
 *   R3 (M1):  agreed 2000 (CEO 10% → net 1800), revenue 1000, collected 400.15, Partially Collected, billed 2026-03-10, lawyer L
 *   R4 (none):agreed 100,  revenue 0,    collected 0,      Not Billed, no billing date, NO lawyer
 *
 * Expected totals: agreed 3600.00 · discount 200.00 · net 3400.00 · revenue 2100.00
 *                  collected 1150.25 · outstanding 949.75 · toBeBilled 1300.00
 */
describe("Financial Reporting — central dataset, filters, reconciliation, double-counting", () => {
  const admin = adminCaller();
  const stamp = `${Date.now()}`;
  const clientName = `Rept Client ${stamp}`;

  let partnerId!: number;
  let lawyerId!: number;
  let attorneyId!: number;
  let attorneyBId!: number;
  let clientId!: number;
  let matterId!: number;
  const financialIds: number[] = [];
  let overdueDays = 30;

  const base = () => ({ clientId });

  beforeAll(async () => {
    const partner = await admin.users.create({ name: `Rept Partner ${stamp}`, email: `rp${stamp}@x.com`, password: PW, role: "head_of_practice" });
    const lawyer = await admin.users.create({ name: `Rept Lawyer ${stamp}`, email: `rl${stamp}@x.com`, password: PW, role: "senior_associate" });
    const attorney = await admin.users.create({ name: `Rept Attorney ${stamp}`, email: `ra${stamp}@x.com`, password: PW, role: "senior_associate" });
    const attorneyB = await admin.users.create({ name: `Rept AttorneyB ${stamp}`, email: `rb${stamp}@x.com`, password: PW, role: "senior_associate" });
    partnerId = partner.id; lawyerId = lawyer.id; attorneyId = attorney.id; attorneyBId = attorneyB.id;

    const client = await admin.clients.create({ clientName, clientStatus: "Existing Client" });
    clientId = client.id;

    const matter = await admin.clientMatters.create({
      clientId,
      matterType: "Corporate",
      matterReference: `RPT-M1-${stamp}`,
      billingType: "Retainers",
      // Four DISTINCT attorneys (duplicate slots are rejected server-side) —
      // the point is that a fully-staffed matter must not multiply financial rows.
      leadLawyerId: partnerId,
      attorney1Id: attorneyId,
      attorney2Id: attorneyBId,
      attorney3Id: lawyerId,
      attorney4Id: partnerId,
      acknowledgeConflicts: true,
    });
    matterId = matter.id;

    const r1 = await admin.financial.create({
      clientId, clientMatterId: matterId, feeType: "Billable Hours",
      agreedFees: "1000", revenue: "600", collectedAmount: "250.10",
      collectionStatus: "Billed", billingDate: "2026-01-15",
      responsibleLawyerId: lawyerId, invoiceNumber: `INV-${stamp}-1`,
    });
    const r2 = await admin.financial.create({
      clientId,
      agreedFees: "500", revenue: "500", collectedAmount: "500",
      collectionStatus: "Fully Collected", billingDate: "2025-12-01",
      responsibleLawyerId: lawyerId, invoiceNumber: `INV-${stamp}-2`,
    });
    const r3 = await admin.financial.create({
      clientId, clientMatterId: matterId, feeType: "Retainers",
      agreedFees: "2000", discountApproval: "CEO", revenue: "1000", collectedAmount: "400.15",
      collectionStatus: "Partially Collected", billingDate: "2026-03-10",
      responsibleLawyerId: lawyerId, invoiceNumber: `INV-${stamp}-3`,
    });
    const r4 = await admin.financial.create({
      clientId,
      agreedFees: "100", revenue: "0", collectedAmount: "0",
      collectionStatus: "Not Billed",
    });
    financialIds.push(r1.id, r2.id, r3.id, r4.id);

    overdueDays = await admin.settings.getOverdueDays();
  });

  afterAll(async () => {
    for (const id of financialIds) await admin.financial.delete({ id }).catch(() => {});
    await admin.clientMatters.delete({ id: matterId }).catch(() => {});
    await admin.clients.delete({ id: clientId }).catch(() => {});
    for (const id of [partnerId, lawyerId, attorneyId, attorneyBId]) {
      await admin.users.delete({ userId: id }).catch(() => {});
    }
  });

  /** Whether a fixture record is overdue under the live threshold. */
  const isOverdue = (billingDate: string | null, status: string, outstanding: number) =>
    billingDate !== null &&
    ["Billed", "Partially Billed", "Partially Collected", "Overdue"].includes(status) &&
    daysSince(billingDate) >= overdueDays &&
    outstanding > 0;

  const expectedOverdue = () => {
    const rows = [
      { billing: "2026-01-15", status: "Billed", outstanding: 349.9 },
      { billing: "2026-03-10", status: "Partially Collected", outstanding: 599.85 },
      // R2 has an old billing date but is Fully Collected → never overdue.
      { billing: "2025-12-01", status: "Fully Collected", outstanding: 0 },
      { billing: null, status: "Not Billed", outstanding: 0 },
    ];
    return rows.filter(r => isOverdue(r.billing, r.status, r.outstanding));
  };

  // ─── KPI summary (calculation tests) ─────────────────────────────────────────

  it("summary computes every KPI from the filtered dataset (exact decimals)", async () => {
    const s = await admin.financialReports.summary(base());
    expect(s.totalAgreedFees).toBe("3600.00");
    expect(s.totalDiscount).toBe("200.00");
    expect(s.totalNetFees).toBe("3400.00");
    expect(s.totalRevenue).toBe("2100.00");
    expect(s.totalCollected).toBe("1150.25");
    expect(s.totalOutstanding).toBe("949.75");
    expect(s.totalToBeBilled).toBe("1300.00");
    expect(s.recordCount).toBe(4);
    expect(s.currency).toBe("SAR");
    const od = expectedOverdue();
    expect(s.overdueInvoiceCount).toBe(od.length);
    expect(cents(s.overdueAmount)).toBe(sumCents(od.map(r => r.outstanding)));
  });

  // ─── Double-counting prevention (Phase 9) ────────────────────────────────────

  it("a record on a matter with FOUR attorneys is counted exactly once (byLawyer + byMatter)", async () => {
    const byLawyer = await admin.financialReports.byLawyer(base());
    const lawyerRow = byLawyer.find(r => r.lawyerId === lawyerId)!;
    expect(Number(lawyerRow.recordCount)).toBe(3);        // R1, R2, R3 — once each
    expect(lawyerRow.revenue).toBe("2100.00");

    const byMatter = await admin.financialReports.byMatter(base());
    const m1 = byMatter.find(r => r.clientMatterId === matterId)!;
    expect(Number(m1.recordCount)).toBe(2);               // R1 + R3, NOT ×4 attorneys
    expect(m1.revenue).toBe("1600.00");
  });

  it("the same record appears once in byLawyer AND once in byLeadPartner, never twice within one report", async () => {
    const byLawyer = await admin.financialReports.byLawyer(base());
    const byPartner = await admin.financialReports.byLeadPartner(base());
    // Each report reconciles to the same filtered revenue independently.
    expect(sumCents(byLawyer.map(r => r.revenue))).toBe(210000);
    expect(sumCents(byPartner.map(r => r.revenue))).toBe(210000);
    // Record counts across groups equal the number of records, exactly once each.
    expect(byLawyer.reduce((a, r) => a + Number(r.recordCount), 0)).toBe(4);
    expect(byPartner.reduce((a, r) => a + Number(r.recordCount), 0)).toBe(4);
  });

  it("byLeadPartner attributes matter records to the partner and no-matter records to Unassigned", async () => {
    const byPartner = await admin.financialReports.byLeadPartner(base());
    const partnerRow = byPartner.find(r => r.leadPartnerId === partnerId)!;
    expect(Number(partnerRow.recordCount)).toBe(2);
    expect(partnerRow.revenue).toBe("1600.00");
    const unassigned = byPartner.find(r => r.leadPartnerId === null)!;
    expect(Number(unassigned.recordCount)).toBe(2);       // R2 + R4 (no matter → no partner)
    expect(unassigned.revenue).toBe("500.00");
  });

  it("filtering by Lawyer or Partner does not multiply rows through attorney joins", async () => {
    const byLawyerF = await admin.financialReports.details({ ...base(), lawyerId, page: 1, pageSize: 200 });
    expect(byLawyerF.totalRows).toBe(3);
    const byPartnerF = await admin.financialReports.details({ ...base(), leadPartnerId: partnerId, page: 1, pageSize: 200 });
    expect(byPartnerF.totalRows).toBe(2);
    const s = await admin.financialReports.summary({ ...base(), leadPartnerId: partnerId });
    expect(s.totalRevenue).toBe("1600.00");
  });

  it("client-level records (no matter) are counted once, in their own group", async () => {
    const byMatter = await admin.financialReports.byMatter(base());
    const clientLevel = byMatter.filter(r => r.isClientLevel);
    expect(clientLevel).toHaveLength(1);
    expect(Number(clientLevel[0].recordCount)).toBe(2);   // R2 + R4
    expect(clientLevel[0].revenue).toBe("500.00");
    // matter groups + client-level group reconcile to the summary
    expect(sumCents(byMatter.map(r => r.revenue))).toBe(210000);
  });

  it("multiple records on one matter stay separate records and sum correctly", async () => {
    const details = await admin.financialReports.details({ ...base(), clientMatterId: matterId, page: 1, pageSize: 200 });
    expect(details.totalRows).toBe(2);
    expect(sumCents(details.rows.map(r => r.revenue))).toBe(160000);
  });

  // ─── Reconciliation (KPI = groups = details = export) ────────────────────────

  it("KPI totals = detail rows totals = grouped rows totals (client & matter & lawyer)", async () => {
    const s = await admin.financialReports.summary(base());
    const details = await admin.financialReports.details({ ...base(), page: 1, pageSize: 200 });
    const byClient = await admin.financialReports.byClient(base());
    const byMatter = await admin.financialReports.byMatter(base());
    const byLawyer = await admin.financialReports.byLawyer(base());

    for (const [kpi, key] of [
      ["totalAgreedFees", "agreedFees"],
      ["totalRevenue", "revenue"],
      ["totalCollected", "collected"],
      ["totalOutstanding", "outstanding"],
      ["totalToBeBilled", "toBeBilled"],
    ] as const) {
      const target = cents((s as any)[kpi]);
      expect(sumCents(details.rows.map((r: any) => r[key]))).toBe(target);
      expect(sumCents(byClient.map((r: any) => r[key]))).toBe(target);
      expect(sumCents(byMatter.map((r: any) => r[key]))).toBe(target);
      expect(sumCents(byLawyer.map((r: any) => r[key]))).toBe(target);
    }
    expect(details.totalRows).toBe(s.recordCount);
  });

  it("pagination does not affect summary totals and the summary is not page-derived", async () => {
    const page1 = await admin.financialReports.details({ ...base(), page: 1, pageSize: 1 });
    const page2 = await admin.financialReports.details({ ...base(), page: 2, pageSize: 1 });
    expect(page1.rows).toHaveLength(1);
    expect(page2.rows).toHaveLength(1);
    expect(page1.rows[0].financialRecordId).not.toBe(page2.rows[0].financialRecordId);
    expect(page1.totalRows).toBe(4);
    const s = await admin.financialReports.summary(base());
    expect(s.recordCount).toBe(4);                        // not 1 (the page size)
    expect(s.totalRevenue).toBe("2100.00");
  });

  it("export uses the same calculation service: export totals = screen totals", async () => {
    const s = await admin.financialReports.summary(base());
    const { csv, filename } = await admin.financialReports.export({ ...base(), reportType: "byLawyer" });
    expect(filename).toMatch(/^financial-report-byLawyer-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv).toContain(`Total Revenue,${s.totalRevenue}`);
    expect(csv).toContain(`Total Collected,${s.totalCollected}`);
    expect(csv).toContain(`Total To Be Billed,${s.totalToBeBilled}`);
    expect(csv).toContain("Lawyer,Clients,Matters,Records");
    expect(csv).toContain("Filter: clientId");
    expect(csv).toContain("Currency,SAR");
  });

  // ─── Filter tests (Phase 10) ─────────────────────────────────────────────────

  it("date filters are inclusive and use billingDate, falling back to createdAt", async () => {
    // Date From only — R3 (2026-03-10) + R4 (no billing date → createdAt today)
    const from = await admin.financialReports.summary({ ...base(), dateFrom: "2026-02-01" });
    expect(from.recordCount).toBe(2);
    expect(from.totalRevenue).toBe("1000.00");
    // Date To only — R1 (2026-01-15) + R2 (2025-12-01)
    const to = await admin.financialReports.summary({ ...base(), dateTo: "2026-02-01" });
    expect(to.recordCount).toBe(2);
    expect(to.totalRevenue).toBe("1100.00");
    // Range, inclusive edges: exactly R1 on its billing date
    const range = await admin.financialReports.summary({ ...base(), dateFrom: "2026-01-15", dateTo: "2026-01-15" });
    expect(range.recordCount).toBe(1);
    expect(range.totalRevenue).toBe("600.00");
  });

  it("entity + enum filters apply consistently in the backend", async () => {
    expect((await admin.financialReports.summary({ ...base(), clientMatterId: matterId })).recordCount).toBe(2);
    expect((await admin.financialReports.summary({ ...base(), lawyerId })).recordCount).toBe(3);
    expect((await admin.financialReports.summary({ ...base(), leadPartnerId: partnerId })).recordCount).toBe(2);
    expect((await admin.financialReports.summary({ ...base(), feeType: "Billable Hours" })).recordCount).toBe(1);
    expect((await admin.financialReports.summary({ ...base(), invoiceStatus: "Billed" })).recordCount).toBe(1);
    expect((await admin.financialReports.summary({ ...base(), billingType: "Retainers" })).recordCount).toBe(2);
    // Multiple filters together
    const multi = await admin.financialReports.summary({
      ...base(), lawyerId, invoiceStatus: "Billed", dateFrom: "2026-01-01",
    });
    expect(multi.recordCount).toBe(1);
    expect(multi.totalRevenue).toBe("600.00");
    // Reset filters (= no filters beyond client) restores the full set
    expect((await admin.financialReports.summary(base())).recordCount).toBe(4);
  });

  it("search matches client name and matter reference", async () => {
    const byName = await admin.financialReports.summary({ search: clientName });
    expect(byName.recordCount).toBe(4);
    const byRef = await admin.financialReports.summary({ search: `RPT-M1-${stamp}` });
    expect(byRef.recordCount).toBe(2);
    const noHit = await admin.financialReports.summary({ search: `zzz-no-such-${stamp}` });
    expect(noHit.recordCount).toBe(0);
  });

  it("no-matter and unassigned-lawyer include/exclude filters", async () => {
    expect((await admin.financialReports.summary({ ...base(), onlyNoMatter: true })).recordCount).toBe(2);
    expect((await admin.financialReports.summary({ ...base(), includeNoMatter: false })).recordCount).toBe(2);
    expect((await admin.financialReports.summary({ ...base(), includeUnassignedLawyer: false })).recordCount).toBe(3);
  });

  it("Head of Practice dimension resolves through practice_heads; unmapped records group as 'Unassigned practice' and an unknown filter matches nothing", async () => {
    // These fixtures carry no city/matter-type practice mapping, so every
    // record groups under the null (Unassigned practice) bucket.
    const hop = await admin.financialReports.byHeadOfPractice(base());
    expect(hop.configured).toBe(true);
    const unassigned = hop.rows.find((r: any) => r.headOfPracticeId === null);
    expect(unassigned).toBeTruthy();
    expect(unassigned!.headOfPracticeName).toBe("Unassigned practice");
    expect(Number(unassigned!.recordCount)).toBe(4);
    // Filtering by a head with no mapped practice matches nothing.
    const filtered = await admin.financialReports.summary({ ...base(), headOfPracticeId: 12345 });
    expect(filtered.recordCount).toBe(0);
  });

  // ─── Report-specific behaviour ───────────────────────────────────────────────

  it("byLawyer: counts, Unassigned group, and zero-revenue-safe collection rate", async () => {
    const rows = await admin.financialReports.byLawyer(base());
    const lawyerRow = rows.find(r => r.lawyerId === lawyerId)!;
    expect(Number(lawyerRow.clientCount)).toBe(1);
    expect(Number(lawyerRow.matterCount)).toBe(1);        // COUNT(DISTINCT matter), nulls excluded
    // Collection Rate = 1150.25 / 2100 * 100 = 54.8 (rounded to 1 dp in SQL)
    expect(lawyerRow.collectionRate).toBe("54.8");
    const unassigned = rows.find(r => r.lawyerId === null)!;
    expect(unassigned.lawyerName).toBe("Unassigned");
    expect(Number(unassigned.recordCount)).toBe(1);
    expect(unassigned.collectionRate).toBeNull();         // zero revenue → NULL, no division
  });

  it("outstandingByLawyer includes only records with outstanding > 0 and splits overdue vs not-yet-due", async () => {
    const rows = await admin.financialReports.outstandingByLawyer(base());
    expect(rows).toHaveLength(1);                         // only the lawyer group (R1+R3)
    const row = rows[0];
    expect(row.lawyerId).toBe(lawyerId);
    expect(Number(row.openRecordCount)).toBe(2);
    expect(row.outstanding).toBe("949.75");
    const od = expectedOverdue();
    expect(cents(row.overdueOutstanding)).toBe(sumCents(od.map(r => r.outstanding)));
    expect(cents(row.notYetDueOutstanding)).toBe(cents("949.75") - sumCents(od.map(r => r.outstanding)));
  });

  it("toBeBilledByLawyer includes only records with To Be Billed > 0 (approved formula, unchanged)", async () => {
    const rows = await admin.financialReports.toBeBilledByLawyer(base());
    const lawyerRow = rows.find(r => r.lawyerId === lawyerId)!;
    expect(Number(lawyerRow.recordCount)).toBe(2);        // R1 (400) + R3 (800); R2 has 0
    expect(lawyerRow.toBeBilled).toBe("1200.00");
    expect(lawyerRow.alreadyBilled).toBe("1600.00");      // revenue of R1+R3
    const unassigned = rows.find(r => r.lawyerId === null)!;
    expect(unassigned.toBeBilled).toBe("100.00");         // R4
    expect(sumCents(rows.map(r => r.toBeBilled))).toBe(130000); // = KPI totalToBeBilled
  });

  it("collectedByLawyer buckets records by amounts (fully / partially / uncollected)", async () => {
    const rows = await admin.financialReports.collectedByLawyer(base());
    const lawyerRow = rows.find(r => r.lawyerId === lawyerId)!;
    expect(Number(lawyerRow.fullyCollectedCount)).toBe(1);     // R2
    expect(Number(lawyerRow.partiallyCollectedCount)).toBe(2); // R1, R3
    expect(Number(lawyerRow.uncollectedCount)).toBe(0);
    const unassigned = rows.find(r => r.lawyerId === null)!;
    expect(unassigned.collectionRate).toBeNull();              // zero revenue
  });

  it("discountReport lists only discounted records with correct summary cards", async () => {
    const report = await admin.financialReports.discountReport(base());
    expect(report.rows).toHaveLength(1);                  // only R3 (CEO 10%)
    const row = report.rows[0];
    expect(row.discountType).toBe("CEO");
    expect(row.discountPercentage).toBe("10.00");
    expect(row.discountAmount).toBe("200.00");
    expect(row.netFees).toBe("1800.00");
    expect(report.summary.totalDiscounts).toBe("200.00");
    expect(report.summary.avgDiscountPercentage).toBe("10.00");
    expect(report.summary.discountedRecordCount).toBe(1);
    expect(report.summary.largestDiscount).toBe("200.00");
  });

  it("invoiceStatus report uses the existing enum and reconciles to the summary", async () => {
    const rows = await admin.financialReports.invoiceStatus(base());
    const statuses = rows.map(r => r.invoiceStatus);
    expect(statuses).toEqual(["Not Billed", "Billed", "Partially Collected", "Fully Collected"]);
    expect(sumCents(rows.map(r => r.invoiceAmount))).toBe(210000);
    expect(sumCents(rows.map(r => r.outstanding))).toBe(94975);
    expect(rows.reduce((a, r) => a + Number(r.recordCount), 0)).toBe(4);
  });

  it("overdue report: fully-collected old record is NOT overdue; missing due date is NOT overdue; aging buckets reconcile", async () => {
    const report = await admin.financialReports.overdue(base());
    const od = expectedOverdue();
    expect(report.rows).toHaveLength(od.length);
    // R2 (Fully Collected, old billing date) and R4 (no billing date) must be absent.
    const invoiceNumbers = report.rows.map(r => r.invoiceNumber);
    expect(invoiceNumbers).not.toContain(`INV-${stamp}-2`);
    for (const row of report.rows) {
      expect(Number(row.daysOverdue)).toBeGreaterThanOrEqual(0);
      expect(Number(row.outstanding)).toBeGreaterThan(0);
      expect(row.status).not.toBe("Fully Collected");
      // dueDate = billingDate + threshold; daysOverdue = today − dueDate
      expect(Number(row.daysOverdue)).toBe(daysSince(row.invoiceDate!) - report.overdueDays);
    }
    // Aging bucket totals = total overdue outstanding = KPI overdue amount
    const bucketSum = sumCents([
      report.aging["1-30"], report.aging["31-60"], report.aging["61-90"],
      report.aging["91-180"], report.aging["180+"],
    ]);
    expect(bucketSum).toBe(cents(report.aging.total));
    const s = await admin.financialReports.summary(base());
    expect(cents(s.overdueAmount)).toBe(cents(report.aging.total));
    expect(s.overdueInvoiceCount).toBe(report.aging.count);
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────────

  it("negative amounts are rejected by existing validation (unchanged)", async () => {
    await expect(
      admin.financial.create({ clientId, agreedFees: "100", revenue: "-5" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("decimal amounts survive exactly (no float drift) end to end", async () => {
    const details = await admin.financialReports.details({ ...base(), page: 1, pageSize: 200 });
    const r1 = details.rows.find(r => r.invoiceNumber === `INV-${stamp}-1`)!;
    expect(r1.collected).toBe("250.10");
    expect(r1.outstanding).toBe("349.90");
    const s = await admin.financialReports.summary(base());
    expect(s.totalCollected).toBe("1150.25");             // 250.10 + 500 + 400.15
  });

  it("details expose the effective reporting date and its rule", async () => {
    const details = await admin.financialReports.details({ ...base(), page: 1, pageSize: 200 });
    expect(details.reportingDateRule).toBe("COALESCE(billing_date, created_at::date)");
    const r1 = details.rows.find(r => r.invoiceNumber === `INV-${stamp}-1`)!;
    expect(r1.effectiveDate).toBe("2026-01-15");          // billingDate wins
    const r4 = details.rows.find(r => r.billingDate === null)!;
    // Falls back to created_at::date. Compare via local date components — the
    // driver parses the tz-less timestamp into a local-time Date.
    const d = new Date(r4.createdAt as any);
    const localIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(r4.effectiveDate).toBe(localIso);
  });

  // ─── Permissions (Phase 12 — not widened) ────────────────────────────────────

  it("financial reports are denied to roles without financial:view (lawyer, staff, viewer)", async () => {
    for (const role of ["lawyer", "staff", "viewer"] as const) {
      const caller = callerFor(role);
      await expect(caller.financialReports.summary({})).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.financialReports.byLawyer({})).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.financialReports.export({ reportType: "details" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("manager and partner (financial:view) and finance (financial:manage) can read reports", async () => {
    for (const role of ["manager", "partner", "finance"] as const) {
      const caller = callerFor(role);
      const s = await caller.financialReports.summary(base());
      expect(s.recordCount).toBe(4);
    }
  });
});
