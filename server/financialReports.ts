// ─── Financial Reporting service ──────────────────────────────────────────────
//
// ONE authoritative reporting dataset: every query in this file starts from
// `financial_records` (one row per record) and joins ONLY one-to-one
// relationships (client, matter, responsible-lawyer user, lead-partner user).
// Attorney 1–4 / matter_lawyer_rates are one-to-many and are deliberately
// NEVER joined here — they would multiply rows and double-count money.
//
// Attribution rules ("Attributed Revenue", NOT revenue share):
//   • By Lawyer        → 100% of a record to financial_records.responsible_lawyer_id
//   • By Lead Partner  → 100% of the SAME record to client_matters.lead_lawyer_id
//   • By Head of Practice → NOT CONFIGURED. No Head-of-Practice relationship
//     exists in the schema (not a user role, not a matter field, not a practice
//     group). We do NOT infer it from attorney_head. The dimension is exposed as
//     `configured: false` so the UI can render it disabled; adding a
//     `head_of_practice_id` FK on client_matters (or a practice-group table)
//     later slots straight into this service.
//
// Formulas reuse the APPROVED financial formulas verbatim (FINANCIAL_FORMULAS.md):
//   Net Fees     = COALESCE(net_fees, agreed_fees)          (legacy-row fallback)
//   Outstanding  = stored outstanding_amount (= max(0, revenue − collected))
//   To Be Billed = GREATEST(0, COALESCE(net_fees, agreed_fees, 0) − COALESCE(revenue, 0))
//   Overdue      = status ∈ {Billed, Partially Billed, Partially Collected, Overdue}
//                  AND billing_date IS NOT NULL
//                  AND CURRENT_DATE − billing_date ≥ overdue_invoice_days
// There is NO due-date column: the effective due date is
// billing_date + overdue_invoice_days (system setting, default 30) and is
// returned as `dueDate` with that limitation documented in the API/UI.
//
// Reporting date: there is no dedicated invoice/revenue date, so the effective
// reporting date is COALESCE(billing_date, created_at::date) — billingDate when
// available, otherwise the record's creation date. Date filters are inclusive
// (from = start of day, to = end of day) and compare whole dates, matching the
// project's existing CURRENT_DATE-based date policy.
//
// Money: all aggregation happens in Postgres `numeric` (exact decimal). Money
// values cross the API as strings; the UI parses them for display only. No
// floating-point arithmetic is used for financial totals.

import { z } from "zod";
import { and, eq, desc, ilike, or, sql, type SQL } from "drizzle-orm";
import { alias, type SelectedFields } from "drizzle-orm/pg-core";
import { financialRecords, clients, clientMatters, users, practices } from "../drizzle/schema";
import { getDb, getOverdueDays } from "./db";

// ─── Central filter schema (shared by every reporting endpoint) ───────────────

const FEE_TYPES = [
  "Billable Hours", "Fixed / Project-Based Fees", "Retainers",
  "Success Fees", "Advisory / Special Mandates", "Blended",
] as const;

const INVOICE_STATUSES = [
  "Not Billed", "Partially Billed", "Billed",
  "Partially Collected", "Fully Collected", "Overdue",
] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const reportFilterSchema = z.object({
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  clientId: z.number().int().positive().optional(),
  clientMatterId: z.number().int().positive().optional(),
  /** Responsible Lawyer (financial_records.responsible_lawyer_id). */
  lawyerId: z.number().int().positive().optional(),
  /** Lead Partner (client_matters.lead_lawyer_id). */
  leadPartnerId: z.number().int().positive().optional(),
  /** Accepted for forward-compatibility; the relationship is not configured, so
   *  setting it matches no records (documented in the UI). */
  headOfPracticeId: z.number().int().positive().optional(),
  feeType: z.enum(FEE_TYPES).optional(),
  invoiceStatus: z.enum(INVOICE_STATUSES).optional(),
  /** Matter billing type (client_matters.billing_type). */
  billingType: z.enum(FEE_TYPES).optional(),
  /** Free-text search: client name, matter reference/serial, invoice number. */
  search: z.string().trim().max(200).optional(),
  /** false → exclude client-level records with no matter. Default: include. */
  includeNoMatter: z.boolean().optional(),
  /** true → ONLY client-level records (clientMatterId IS NULL). */
  onlyNoMatter: z.boolean().optional(),
  /** false → exclude records with no responsible lawyer. Default: include. */
  includeUnassignedLawyer: z.boolean().optional(),
});

export type ReportFilters = z.infer<typeof reportFilterSchema>;

// ─── Result row types (money/counts are exact SQL numerics as strings) ────────

/** Exact decimal from Postgres `numeric`, e.g. "12345.00". Parse for display only. */
export type MoneyString = string;

interface GroupMoney {
  agreedFees: MoneyString;
  discount: MoneyString;
  netFees: MoneyString;
  revenue: MoneyString;
  collected: MoneyString;
  outstanding: MoneyString;
  toBeBilled: MoneyString;
}

export interface LawyerReportRow extends GroupMoney {
  lawyerId: number | null;
  lawyerName: string;
  clientCount: string;
  matterCount: string;
  recordCount: string;
  collectionRate: string | null;
}

export interface LeadPartnerReportRow extends GroupMoney {
  leadPartnerId: number | null;
  leadPartnerName: string;
  clientCount: string;
  matterCount: string;
  recordCount: string;
  collectionRate: string | null;
}

export interface ClientReportRow extends GroupMoney {
  clientId: number;
  clientNumber: string | null;
  clientName: string;
  matterCount: string;
  recordCount: string;
}

export interface MatterReportRow extends GroupMoney {
  clientMatterId: number | null;
  clientId: number;
  clientName: string;
  matterReference: string | null;
  billingType: string | null;
  leadPartnerName: string | null;
  responsibleLawyers: string | null;
  recordCount: string;
  isClientLevel: boolean;
}

export interface OutstandingByLawyerRow {
  lawyerId: number | null;
  lawyerName: string;
  openRecordCount: string;
  revenue: MoneyString;
  collected: MoneyString;
  outstanding: MoneyString;
  oldestDueDate: string | null;
  overdueOutstanding: MoneyString;
  notYetDueOutstanding: MoneyString;
}

export interface ToBeBilledByLawyerRow {
  lawyerId: number | null;
  lawyerName: string;
  recordCount: string;
  agreedFees: MoneyString;
  alreadyBilled: MoneyString;
  toBeBilled: MoneyString;
  oldestUnbilledRecordDate: string | null;
}

export interface CollectedByLawyerRow {
  lawyerId: number | null;
  lawyerName: string;
  recordCount: string;
  revenue: MoneyString;
  collected: MoneyString;
  outstanding: MoneyString;
  collectionRate: string | null;
  fullyCollectedCount: string;
  partiallyCollectedCount: string;
  uncollectedCount: string;
}

export interface InvoiceStatusRow {
  invoiceStatus: string | null;
  recordCount: string;
  netFees: MoneyString;
  invoiceAmount: MoneyString;
  collected: MoneyString;
  outstanding: MoneyString;
  toBeBilled: MoneyString;
}

export interface OverdueReportRow {
  financialRecordId: number;
  invoiceNumber: string | null;
  clientId: number;
  clientName: string;
  clientMatterId: number | null;
  matterReference: string | null;
  responsibleLawyerName: string | null;
  leadPartnerName: string | null;
  invoiceDate: string | null;
  dueDate: string;
  daysOverdue: string;
  invoiceAmount: MoneyString;
  collected: MoneyString;
  outstanding: MoneyString;
  status: string | null;
}

export interface DetailReportRow {
  financialRecordId: number;
  clientId: number;
  clientName: string;
  clientMatterId: number | null;
  matterReference: string | null;
  responsibleLawyerId: number | null;
  responsibleLawyerName: string | null;
  leadPartnerId: number | null;
  leadPartnerName: string | null;
  headOfPracticeId: null;
  headOfPracticeName: null;
  feeType: string | null;
  billingType: string | null;
  invoiceStatus: string | null;
  invoiceNumber: string | null;
  agreedFees: MoneyString;
  discountAmount: MoneyString;
  netFees: MoneyString;
  revenue: MoneyString;
  collected: MoneyString;
  outstanding: MoneyString;
  toBeBilled: MoneyString;
  billingDate: string | null;
  dueDate: string | null;
  isOverdue: boolean;
  effectiveDate: string;
  createdAt: Date;
}

// ─── Joined user aliases (1:1) ────────────────────────────────────────────────

const respLawyer = alias(users, "resp_lawyer");
const leadPartner = alias(users, "lead_partner_user");
const createdByUser = alias(users, "created_by_user");

// ─── Money expressions (approved formulas, SQL numeric) ───────────────────────

const AGREED      = sql`COALESCE(${financialRecords.agreedFees}, 0)::numeric`;
const DISCOUNT    = sql`COALESCE(${financialRecords.discountAmount}, 0)::numeric`;
const NET_FEES    = sql`COALESCE(${financialRecords.netFees}, ${financialRecords.agreedFees}, 0)::numeric`;
const REVENUE     = sql`COALESCE(${financialRecords.revenue}, 0)::numeric`;
const COLLECTED   = sql`COALESCE(${financialRecords.collectedAmount}, 0)::numeric`;
const OUTSTANDING = sql`COALESCE(${financialRecords.outstandingAmount}, 0)::numeric`;
const TO_BE_BILLED = sql`GREATEST(0, COALESCE(${financialRecords.netFees}, ${financialRecords.agreedFees}, 0)::numeric - COALESCE(${financialRecords.revenue}, 0)::numeric)`;
const EFFECTIVE_DATE = sql`COALESCE(${financialRecords.billingDate}, ${financialRecords.createdAt}::date)`;

const money = (expr: SQL) => sql<string>`COALESCE(SUM(${expr}), 0)::numeric(18,2)::text`;

/** Collection Rate = Collected / Revenue * 100, NULL when revenue = 0. */
const collectionRate = sql<string | null>`
  CASE WHEN COALESCE(SUM(${REVENUE}), 0) > 0
       THEN ROUND(COALESCE(SUM(${COLLECTED}), 0) / SUM(${REVENUE}) * 100, 1)::text
       ELSE NULL END`;

/** Overdue predicate — same rule as computeIsOverdue()/getFinancialSummary(). */
function overdueCond(overdueDays: number): SQL {
  const od = sql.raw(String(overdueDays)); // validated positive int (getOverdueDays)
  return sql`(
    ${financialRecords.collectionStatus} IN ('Billed', 'Partially Billed', 'Partially Collected', 'Overdue')
    AND ${financialRecords.billingDate} IS NOT NULL
    AND CURRENT_DATE - ${financialRecords.billingDate}::date >= ${od}
  )`;
}

/** Derived due date = billing_date + overdue_invoice_days (no due-date column). */
function dueDateExpr(overdueDays: number): SQL {
  const od = sql.raw(String(overdueDays));
  return sql`(${financialRecords.billingDate}::date + ${od})`;
}

/** Days overdue = today − dueDate (0 on the day it becomes overdue). */
function daysOverdueExpr(overdueDays: number): SQL {
  const od = sql.raw(String(overdueDays));
  return sql`(CURRENT_DATE - ${financialRecords.billingDate}::date - ${od})`;
}

// ─── Shared WHERE builder ─────────────────────────────────────────────────────

function escapeLike(q: string) {
  return q.replace(/[\\%_]/g, m => `\\${m}`);
}

export function buildConditions(f: ReportFilters): SQL[] {
  const conds: SQL[] = [];
  if (f.clientId)       conds.push(eq(financialRecords.clientId, f.clientId));
  if (f.clientMatterId) conds.push(eq(financialRecords.clientMatterId, f.clientMatterId));
  if (f.lawyerId)       conds.push(eq(financialRecords.responsibleLawyerId, f.lawyerId));
  // Left-joined column: NULL never matches, so no-matter records drop out — correct.
  if (f.leadPartnerId)  conds.push(eq(clientMatters.leadLawyerId, f.leadPartnerId));
  // Head of Practice is not configured in the data model: no record can match.
  if (f.headOfPracticeId) conds.push(sql`FALSE`);
  if (f.feeType)        conds.push(eq(financialRecords.feeType, f.feeType));
  if (f.invoiceStatus)  conds.push(eq(financialRecords.collectionStatus, f.invoiceStatus));
  if (f.billingType)    conds.push(eq(clientMatters.billingType, f.billingType));
  if (f.dateFrom)       conds.push(sql`${EFFECTIVE_DATE} >= ${f.dateFrom}::date`);
  if (f.dateTo)         conds.push(sql`${EFFECTIVE_DATE} <= ${f.dateTo}::date`);
  if (f.includeNoMatter === false) {
    conds.push(sql`${financialRecords.clientMatterId} IS NOT NULL`);
  }
  if (f.onlyNoMatter) {
    conds.push(sql`${financialRecords.clientMatterId} IS NULL`);
  }
  if (f.includeUnassignedLawyer === false) {
    conds.push(sql`${financialRecords.responsibleLawyerId} IS NOT NULL`);
  }
  if (f.search) {
    const pattern = `%${escapeLike(f.search)}%`;
    const searchCond = or(
      ilike(clients.clientName, pattern),
      ilike(clientMatters.matterReference, pattern),
      ilike(clientMatters.originalSerial, pattern),
      ilike(financialRecords.invoiceNumber, pattern),
    );
    if (searchCond) conds.push(searchCond);
  }
  return conds;
}

function whereOf(f: ReportFilters, extra: SQL[] = []): SQL | undefined {
  const conds = [...buildConditions(f), ...extra];
  return conds.length ? and(...conds) : undefined;
}

/** Base FROM + 1:1 joins used by every report query.
 *
 * Chained leftJoins defeat TS inference inside a generic helper, so the builder
 * is intentionally type-erased here; every exported report function declares an
 * explicit result type instead (which is also what the tRPC client sees). */
type DynamicReportQuery = {
  where(cond: SQL | undefined): DynamicReportQuery;
  groupBy(...cols: unknown[]): DynamicReportQuery;
  orderBy(...cols: unknown[]): DynamicReportQuery;
  limit(n: number): DynamicReportQuery;
  offset(n: number): DynamicReportQuery;
} & Promise<any[]>;

function baseSelect(projection: SelectedFields): DynamicReportQuery {
  const db = getDb();
  return db
    .select(projection)
    .from(financialRecords)
    .$dynamic()
    .leftJoin(clients, eq(financialRecords.clientId, clients.id))
    .leftJoin(clientMatters, eq(financialRecords.clientMatterId, clientMatters.id))
    .leftJoin(respLawyer, eq(financialRecords.responsibleLawyerId, respLawyer.id))
    .leftJoin(leadPartner, eq(clientMatters.leadLawyerId, leadPartner.id)) as unknown as DynamicReportQuery;
}

const sortByRevenueDesc = <T extends { revenue: string }>(rows: T[]) =>
  rows.sort((a, b) => Number(b.revenue) - Number(a.revenue)); // display order only

// ─── KPI summary (Phase 5) ────────────────────────────────────────────────────

export async function getReportSummary(f: ReportFilters) {
  const overdueDays = await getOverdueDays();
  const isOverdue = overdueCond(overdueDays);
  const [row] = await baseSelect({
    totalAgreedFees:  money(AGREED),
    totalDiscount:    money(DISCOUNT),
    totalNetFees:     money(NET_FEES),
    totalRevenue:     money(REVENUE),
    totalCollected:   money(COLLECTED),
    totalOutstanding: money(OUTSTANDING),
    totalToBeBilled:  money(TO_BE_BILLED),
    // Overdue Amount = outstanding money sitting on overdue records.
    overdueAmount: sql<string>`COALESCE(SUM(${OUTSTANDING}) FILTER (WHERE ${isOverdue} AND ${OUTSTANDING} > 0), 0)::numeric(18,2)::text`,
    recordCount: sql<string>`COUNT(*)`,
    overdueInvoiceCount: sql<string>`COUNT(*) FILTER (WHERE ${isOverdue} AND ${OUTSTANDING} > 0)`,
  }).where(whereOf(f));

  return {
    totalAgreedFees:  row?.totalAgreedFees  ?? "0.00",
    totalDiscount:    row?.totalDiscount    ?? "0.00",
    totalNetFees:     row?.totalNetFees     ?? "0.00",
    totalRevenue:     row?.totalRevenue     ?? "0.00",
    totalCollected:   row?.totalCollected   ?? "0.00",
    totalOutstanding: row?.totalOutstanding ?? "0.00",
    totalToBeBilled:  row?.totalToBeBilled  ?? "0.00",
    overdueAmount:    row?.overdueAmount    ?? "0.00",
    recordCount:         Number(row?.recordCount ?? 0),
    overdueInvoiceCount: Number(row?.overdueInvoiceCount ?? 0),
    overdueDays,
    currency: "SAR" as const,
  };
}

// ─── Grouped reports (Phase 6) ────────────────────────────────────────────────

const groupMoneyColumns = {
  agreedFees: money(AGREED),
  discount:   money(DISCOUNT),
  netFees:    money(NET_FEES),
  revenue:    money(REVENUE),
  collected:  money(COLLECTED),
  outstanding: money(OUTSTANDING),
  toBeBilled: money(TO_BE_BILLED),
};

/** A. Revenue by (Responsible) Lawyer — 100% attributed, counted once. */
export async function getRevenueByLawyer(f: ReportFilters): Promise<LawyerReportRow[]> {
  const rows = await baseSelect({
    lawyerId:   financialRecords.responsibleLawyerId,
    lawyerName: sql<string>`COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer}, 'Unassigned')`,
    clientCount: sql<string>`COUNT(DISTINCT ${financialRecords.clientId})`,
    matterCount: sql<string>`COUNT(DISTINCT ${financialRecords.clientMatterId})`,
    recordCount: sql<string>`COUNT(*)`,
    ...groupMoneyColumns,
    collectionRate,
  })
    .where(whereOf(f))
    .groupBy(
      financialRecords.responsibleLawyerId,
      sql`COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer}, 'Unassigned')`,
    );
  return sortByRevenueDesc(rows as any[]);
}

/** B. Revenue by Lead Partner (matter's lead_lawyer_id — real user FK). */
export async function getRevenueByLeadPartner(f: ReportFilters): Promise<LeadPartnerReportRow[]> {
  const rows = await baseSelect({
    leadPartnerId:   clientMatters.leadLawyerId,
    leadPartnerName: sql<string>`COALESCE(${leadPartner.name}, ${clientMatters.leadPartnerFullName}, ${clientMatters.leadPartner}, 'Unassigned')`,
    clientCount: sql<string>`COUNT(DISTINCT ${financialRecords.clientId})`,
    matterCount: sql<string>`COUNT(DISTINCT ${financialRecords.clientMatterId})`,
    recordCount: sql<string>`COUNT(*)`,
    ...groupMoneyColumns,
    collectionRate,
  })
    .where(whereOf(f))
    .groupBy(
      clientMatters.leadLawyerId,
      sql`COALESCE(${leadPartner.name}, ${clientMatters.leadPartnerFullName}, ${clientMatters.leadPartner}, 'Unassigned')`,
    );
  return sortByRevenueDesc(rows as any[]);
}

/**
 * C. Revenue by Head of Practice — configured via the authoritative `practices`
 * relationship (Phase 5). A record's practice is (client.city, matter type),
 * where matter type is the linked matter's type or, for client-level records, the
 * client's own type. Each (location, matter_type) has ONE responsible head, so a
 * financial record maps to at most one head and is counted once (no double count;
 * we join the 1:1 practices row, never the 1:many attorney/rate tables).
 *
 * Records whose practice is unmapped or has no appointed head roll up under
 * "Unassigned / Unclassified" — surfaced, never silently attributed. This uses
 * `attorney_head` for NOTHING; the head comes only from `practices`.
 */
const HOP_NOT_CONFIGURED = {
  configured: false as const,
  reason:
    "Head of Practice is not configured: no practice has an appointed head yet. " +
    "Appoint responsible heads in the practices relationship to enable this report.",
  rows: [] as never[],
};

export async function getRevenueByHeadOfPractice(f: ReportFilters) {
  const db = getDb();
  const headUser = alias(users, "head_user");
  // Not configured until at least one practice has an appointed head. Also treat
  // an absent `practices` table (additive migration not yet applied) as not
  // configured, so the dimension degrades gracefully rather than erroring.
  try {
    const appointed = await db
      .select({ id: practices.id })
      .from(practices)
      .where(sql`${practices.headOfPracticeId} IS NOT NULL`)
      .limit(1);
    if (appointed.length === 0) return HOP_NOT_CONFIGURED;
  } catch {
    return HOP_NOT_CONFIGURED;
  }
  // Practice match: same location (city enum) AND same matter type. Matter type
  // is compared as text so a matter's varchar type lines up with the client/
  // practice enum (legacy free-text matter types simply won't match → unclassified).
  const practiceMatterType = sql`COALESCE(${clientMatters.matterType}::text, ${clients.matterType}::text)`;
  const rows = await db
    .select({
      headOfPracticeId: practices.headOfPracticeId,
      headOfPracticeName: sql<string>`COALESCE(${headUser.name}, 'Unassigned / Unclassified')`,
      clientCount: sql<string>`COUNT(DISTINCT ${financialRecords.clientId})`,
      matterCount: sql<string>`COUNT(DISTINCT ${financialRecords.clientMatterId})`,
      recordCount: sql<string>`COUNT(*)`,
      ...groupMoneyColumns,
      collectionRate,
    })
    .from(financialRecords)
    .leftJoin(clients, eq(financialRecords.clientId, clients.id))
    .leftJoin(clientMatters, eq(financialRecords.clientMatterId, clientMatters.id))
    .leftJoin(
      practices,
      and(eq(practices.location, clients.city), eq(sql`${practices.matterType}::text`, practiceMatterType)),
    )
    .leftJoin(headUser, eq(practices.headOfPracticeId, headUser.id))
    .where(whereOf(f))
    .groupBy(practices.headOfPracticeId, sql`COALESCE(${headUser.name}, 'Unassigned / Unclassified')`);
  return { configured: true as const, rows: sortByRevenueDesc(rows as any[]) };
}

/** D. Revenue by Client. */
export async function getRevenueByClient(f: ReportFilters): Promise<ClientReportRow[]> {
  const rows = await baseSelect({
    clientId:     financialRecords.clientId,
    clientNumber: clients.clientNumber,
    clientName:   sql<string>`COALESCE(${clients.clientName}, 'Client #' || ${financialRecords.clientId})`,
    matterCount:  sql<string>`COUNT(DISTINCT ${financialRecords.clientMatterId})`,
    recordCount:  sql<string>`COUNT(*)`,
    ...groupMoneyColumns,
  })
    .where(whereOf(f))
    .groupBy(
      financialRecords.clientId,
      clients.clientNumber,
      sql`COALESCE(${clients.clientName}, 'Client #' || ${financialRecords.clientId})`,
    );
  return sortByRevenueDesc(rows as any[]);
}

/** E. Revenue by Matter. Client-level records (no matter) group per client,
 *  flagged isClientLevel so the UI shows them under "Client-level / No Matter". */
export async function getRevenueByMatter(f: ReportFilters): Promise<MatterReportRow[]> {
  const rows = await baseSelect({
    clientMatterId:  financialRecords.clientMatterId,
    clientId:        financialRecords.clientId,
    clientName:      sql<string>`COALESCE(${clients.clientName}, 'Client #' || ${financialRecords.clientId})`,
    matterReference: sql<string | null>`COALESCE(${clientMatters.matterReference}, ${clientMatters.originalSerial})`,
    billingType:     clientMatters.billingType,
    leadPartnerName: sql<string | null>`COALESCE(${leadPartner.name}, ${clientMatters.leadPartnerFullName}, ${clientMatters.leadPartner})`,
    // A matter's records may name several responsible lawyers — aggregate the
    // distinct display names (no row multiplication; this is string_agg).
    responsibleLawyers: sql<string | null>`STRING_AGG(DISTINCT COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer}), ', ')`,
    recordCount: sql<string>`COUNT(*)`,
    ...groupMoneyColumns,
  })
    .where(whereOf(f))
    .groupBy(
      financialRecords.clientMatterId,
      financialRecords.clientId,
      sql`COALESCE(${clients.clientName}, 'Client #' || ${financialRecords.clientId})`,
      sql`COALESCE(${clientMatters.matterReference}, ${clientMatters.originalSerial})`,
      clientMatters.billingType,
      sql`COALESCE(${leadPartner.name}, ${clientMatters.leadPartnerFullName}, ${clientMatters.leadPartner})`,
    );
  return sortByRevenueDesc(
    (rows as any[]).map(r => ({ ...r, isClientLevel: r.clientMatterId == null })),
  );
}

/** F. Outstanding by Lawyer — only records with Outstanding > 0. */
export async function getOutstandingByLawyer(f: ReportFilters): Promise<OutstandingByLawyerRow[]> {
  const overdueDays = await getOverdueDays();
  const isOverdue = overdueCond(overdueDays);
  const rows = await baseSelect({
    lawyerId:   financialRecords.responsibleLawyerId,
    lawyerName: sql<string>`COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer}, 'Unassigned')`,
    openRecordCount: sql<string>`COUNT(*)`,
    revenue:    money(REVENUE),
    collected:  money(COLLECTED),
    outstanding: money(OUTSTANDING),
    // Effective due date = billing_date + overdue threshold (no due-date column).
    oldestDueDate: sql<string | null>`MIN(${dueDateExpr(overdueDays)})::text`,
    overdueOutstanding:   sql<string>`COALESCE(SUM(${OUTSTANDING}) FILTER (WHERE ${isOverdue}), 0)::numeric(18,2)::text`,
    notYetDueOutstanding: sql<string>`COALESCE(SUM(${OUTSTANDING}) FILTER (WHERE NOT ${isOverdue}), 0)::numeric(18,2)::text`,
  })
    .where(whereOf(f, [sql`${OUTSTANDING} > 0`]))
    .groupBy(
      financialRecords.responsibleLawyerId,
      sql`COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer}, 'Unassigned')`,
    );
  return (rows as any[]).sort((a, b) => Number(b.outstanding) - Number(a.outstanding));
}

/** G. To Be Billed by Lawyer — only records with To Be Billed > 0.
 *  "Already Billed" = Revenue (the approved To-Be-Billed formula's counterpart:
 *  toBeBilled = netFees − revenue, so revenue is the amount already billed). */
export async function getToBeBilledByLawyer(f: ReportFilters): Promise<ToBeBilledByLawyerRow[]> {
  const rows = await baseSelect({
    lawyerId:   financialRecords.responsibleLawyerId,
    lawyerName: sql<string>`COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer}, 'Unassigned')`,
    recordCount: sql<string>`COUNT(*)`,
    agreedFees:  money(AGREED),
    alreadyBilled: money(REVENUE),
    toBeBilled:  money(TO_BE_BILLED),
    oldestUnbilledRecordDate: sql<string | null>`MIN(${EFFECTIVE_DATE})::text`,
  })
    .where(whereOf(f, [sql`${TO_BE_BILLED} > 0`]))
    .groupBy(
      financialRecords.responsibleLawyerId,
      sql`COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer}, 'Unassigned')`,
    );
  return (rows as any[]).sort((a, b) => Number(b.toBeBilled) - Number(a.toBeBilled));
}

/** H. Collected Amount by Lawyer. Collection buckets are amount-based
 *  (collected vs revenue), since collection_status is manually controlled. */
export async function getCollectedByLawyer(f: ReportFilters): Promise<CollectedByLawyerRow[]> {
  const rows = await baseSelect({
    lawyerId:   financialRecords.responsibleLawyerId,
    lawyerName: sql<string>`COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer}, 'Unassigned')`,
    recordCount: sql<string>`COUNT(*)`,
    revenue:    money(REVENUE),
    collected:  money(COLLECTED),
    outstanding: money(OUTSTANDING),
    collectionRate,
    fullyCollectedCount:     sql<string>`COUNT(*) FILTER (WHERE ${REVENUE} > 0 AND ${COLLECTED} >= ${REVENUE})`,
    partiallyCollectedCount: sql<string>`COUNT(*) FILTER (WHERE ${COLLECTED} > 0 AND ${COLLECTED} < ${REVENUE})`,
    uncollectedCount:        sql<string>`COUNT(*) FILTER (WHERE ${COLLECTED} = 0 AND ${REVENUE} > 0)`,
  })
    .where(whereOf(f))
    .groupBy(
      financialRecords.responsibleLawyerId,
      sql`COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer}, 'Unassigned')`,
    );
  return (rows as any[]).sort((a, b) => Number(b.collected) - Number(a.collected));
}

/** I. Discount Report — records with Discount Amount > 0, plus summary cards.
 *  Notes: there is no discount-reason column (discountApproval is the approval
 *  level / "type"); updated-by is only in the per-record audit trail. */
export async function getDiscountReport(f: ReportFilters) {
  const db = getDb();
  const discountCond = sql`${DISCOUNT} > 0`;

  const rows = await db
    .select({
      financialRecordId: financialRecords.id,
      clientId:    financialRecords.clientId,
      clientName:  sql<string>`COALESCE(${clients.clientName}, 'Client #' || ${financialRecords.clientId})`,
      clientMatterId:  financialRecords.clientMatterId,
      matterReference: sql<string | null>`COALESCE(${clientMatters.matterReference}, ${clientMatters.originalSerial})`,
      responsibleLawyerName: sql<string | null>`COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer})`,
      leadPartnerName: sql<string | null>`COALESCE(${leadPartner.name}, ${clientMatters.leadPartnerFullName}, ${clientMatters.leadPartner})`,
      agreedFees: sql<string>`${AGREED}::numeric(18,2)::text`,
      discountType: financialRecords.discountApproval,
      discountPercentage: sql<string>`COALESCE(${financialRecords.discountPercentage}, 0)::numeric(5,2)::text`,
      discountAmount: sql<string>`${DISCOUNT}::numeric(18,2)::text`,
      netFees: sql<string>`${NET_FEES}::numeric(18,2)::text`,
      createdByName: createdByUser.name,
      lastUpdated: financialRecords.updatedAt,
    })
    .from(financialRecords)
    .leftJoin(clients, eq(financialRecords.clientId, clients.id))
    .leftJoin(clientMatters, eq(financialRecords.clientMatterId, clientMatters.id))
    .leftJoin(respLawyer, eq(financialRecords.responsibleLawyerId, respLawyer.id))
    .leftJoin(leadPartner, eq(clientMatters.leadLawyerId, leadPartner.id))
    .leftJoin(createdByUser, eq(financialRecords.createdBy, createdByUser.id))
    .where(whereOf(f, [discountCond]))
    .orderBy(desc(sql`${DISCOUNT}`));

  const [summary] = await baseSelect({
    totalDiscounts: money(DISCOUNT),
    avgDiscountPercentage: sql<string | null>`ROUND(AVG(COALESCE(${financialRecords.discountPercentage}, 0)::numeric), 2)::text`,
    discountedRecordCount: sql<string>`COUNT(*)`,
    largestDiscount: sql<string>`COALESCE(MAX(${DISCOUNT}), 0)::numeric(18,2)::text`,
  }).where(whereOf(f, [discountCond]));

  return {
    rows,
    summary: {
      totalDiscounts:        summary?.totalDiscounts ?? "0.00",
      avgDiscountPercentage: summary?.avgDiscountPercentage ?? null,
      discountedRecordCount: Number(summary?.discountedRecordCount ?? 0),
      largestDiscount:       summary?.largestDiscount ?? "0.00",
    },
  };
}

/** J. Invoice Status Report — grouped on the existing collection_status enum.
 *  No separate invoice entity exists: "Invoice Amount" = Revenue (amount
 *  invoiced to date under the approved formula set); limitation surfaced. */
export async function getInvoiceStatusReport(f: ReportFilters): Promise<InvoiceStatusRow[]> {
  const rows = await baseSelect({
    invoiceStatus: financialRecords.collectionStatus,
    recordCount: sql<string>`COUNT(*)`,
    netFees:     money(NET_FEES),
    invoiceAmount: money(REVENUE),
    collected:   money(COLLECTED),
    outstanding: money(OUTSTANDING),
    toBeBilled:  money(TO_BE_BILLED),
  })
    .where(whereOf(f))
    .groupBy(financialRecords.collectionStatus);
  const order = new Map(INVOICE_STATUSES.map((s, i) => [s as string, i]));
  return (rows as any[]).sort(
    (a, b) => (order.get(a.invoiceStatus ?? "") ?? 99) - (order.get(b.invoiceStatus ?? "") ?? 99),
  );
}

/** K. Overdue Invoice Report. Overdue = due date passed (billing_date +
 *  threshold), outstanding > 0, and status not Fully Collected / Not Billed
 *  (the enum has no "Cancelled" status). */
export async function getOverdueReport(f: ReportFilters) {
  const overdueDays = await getOverdueDays();
  const isOverdue = overdueCond(overdueDays);
  const withOutstanding = sql`${OUTSTANDING} > 0`;
  const daysOver = daysOverdueExpr(overdueDays);

  const rows = await baseSelect({
    financialRecordId: financialRecords.id,
    invoiceNumber: financialRecords.invoiceNumber,
    clientId:   financialRecords.clientId,
    clientName: sql<string>`COALESCE(${clients.clientName}, 'Client #' || ${financialRecords.clientId})`,
    clientMatterId:  financialRecords.clientMatterId,
    matterReference: sql<string | null>`COALESCE(${clientMatters.matterReference}, ${clientMatters.originalSerial})`,
    responsibleLawyerName: sql<string | null>`COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer})`,
    leadPartnerName: sql<string | null>`COALESCE(${leadPartner.name}, ${clientMatters.leadPartnerFullName}, ${clientMatters.leadPartner})`,
    invoiceDate: financialRecords.billingDate,
    dueDate: sql<string>`${dueDateExpr(overdueDays)}::text`,
    daysOverdue: sql<string>`${daysOver}::text`,
    invoiceAmount: sql<string>`${REVENUE}::numeric(18,2)::text`,
    collected:   sql<string>`${COLLECTED}::numeric(18,2)::text`,
    outstanding: sql<string>`${OUTSTANDING}::numeric(18,2)::text`,
    status: financialRecords.collectionStatus,
  })
    .where(whereOf(f, [isOverdue, withOutstanding]))
    .orderBy(desc(daysOver));

  // Aging buckets on days-overdue (0 counts in the 1–30 bucket: it became due today).
  const bucket = (lo: number | null, hi: number | null): SQL => {
    if (lo === null) return sql`${daysOver} > ${sql.raw(String(hi))}`;
    if (hi === null) return sql`${daysOver} >= ${sql.raw(String(lo))}`;
    return sql`${daysOver} >= ${sql.raw(String(lo))} AND ${daysOver} <= ${sql.raw(String(hi))}`;
  };
  const [aging] = await baseSelect({
    bucket1to30:   sql<string>`COALESCE(SUM(${OUTSTANDING}) FILTER (WHERE ${bucket(0, 30)}), 0)::numeric(18,2)::text`,
    bucket31to60:  sql<string>`COALESCE(SUM(${OUTSTANDING}) FILTER (WHERE ${bucket(31, 60)}), 0)::numeric(18,2)::text`,
    bucket61to90:  sql<string>`COALESCE(SUM(${OUTSTANDING}) FILTER (WHERE ${bucket(61, 90)}), 0)::numeric(18,2)::text`,
    bucket91to180: sql<string>`COALESCE(SUM(${OUTSTANDING}) FILTER (WHERE ${bucket(91, 180)}), 0)::numeric(18,2)::text`,
    bucket180plus: sql<string>`COALESCE(SUM(${OUTSTANDING}) FILTER (WHERE ${bucket(null, 180)}), 0)::numeric(18,2)::text`,
    totalOverdueOutstanding: money(OUTSTANDING),
    overdueCount: sql<string>`COUNT(*)`,
  }).where(whereOf(f, [isOverdue, withOutstanding]));

  return {
    rows,
    overdueDays,
    aging: {
      "1-30":   aging?.bucket1to30   ?? "0.00",
      "31-60":  aging?.bucket31to60  ?? "0.00",
      "61-90":  aging?.bucket61to90  ?? "0.00",
      "91-180": aging?.bucket91to180 ?? "0.00",
      "180+":   aging?.bucket180plus ?? "0.00",
      total:    aging?.totalOverdueOutstanding ?? "0.00",
      count:    Number(aging?.overdueCount ?? 0),
    },
  };
}

// ─── Detail rows (server-side pagination) ─────────────────────────────────────

export async function getReportDetails(f: ReportFilters, page = 1, pageSize = 25) {
  const overdueDays = await getOverdueDays();
  const isOverdue = overdueCond(overdueDays);
  const safePage = Math.max(1, Math.floor(page));
  const safeSize = Math.min(200, Math.max(1, Math.floor(pageSize)));

  const rows = await baseSelect({
    financialRecordId: financialRecords.id,
    clientId:    financialRecords.clientId,
    clientName:  sql<string>`COALESCE(${clients.clientName}, 'Client #' || ${financialRecords.clientId})`,
    clientMatterId:  financialRecords.clientMatterId,
    matterReference: sql<string | null>`COALESCE(${clientMatters.matterReference}, ${clientMatters.originalSerial})`,
    responsibleLawyerId:   financialRecords.responsibleLawyerId,
    responsibleLawyerName: sql<string | null>`COALESCE(${respLawyer.name}, ${financialRecords.responsibleLawyer})`,
    leadPartnerId:   clientMatters.leadLawyerId,
    leadPartnerName: sql<string | null>`COALESCE(${leadPartner.name}, ${clientMatters.leadPartnerFullName}, ${clientMatters.leadPartner})`,
    headOfPracticeId:   sql<null>`NULL`,      // relationship not configured
    headOfPracticeName: sql<null>`NULL`,
    feeType: financialRecords.feeType,
    billingType: clientMatters.billingType,
    invoiceStatus: financialRecords.collectionStatus,
    invoiceNumber: financialRecords.invoiceNumber,
    agreedFees:     sql<string>`${AGREED}::numeric(18,2)::text`,
    discountAmount: sql<string>`${DISCOUNT}::numeric(18,2)::text`,
    netFees:        sql<string>`${NET_FEES}::numeric(18,2)::text`,
    revenue:        sql<string>`${REVENUE}::numeric(18,2)::text`,
    collected:      sql<string>`${COLLECTED}::numeric(18,2)::text`,
    outstanding:    sql<string>`${OUTSTANDING}::numeric(18,2)::text`,
    toBeBilled:     sql<string>`${TO_BE_BILLED}::numeric(18,2)::text`,
    billingDate: financialRecords.billingDate,
    dueDate: sql<string | null>`CASE WHEN ${financialRecords.billingDate} IS NOT NULL THEN (${dueDateExpr(overdueDays)})::text ELSE NULL END`,
    isOverdue: sql<boolean>`(${isOverdue} AND ${OUTSTANDING} > 0)`,
    effectiveDate: sql<string>`${EFFECTIVE_DATE}::text`,
    createdAt: financialRecords.createdAt,
  })
    .where(whereOf(f))
    .orderBy(desc(sql`${EFFECTIVE_DATE}`), desc(financialRecords.id))
    .limit(safeSize)
    .offset((safePage - 1) * safeSize);

  const [count] = await baseSelect({ total: sql<string>`COUNT(*)` }).where(whereOf(f));

  return {
    rows,
    page: safePage,
    pageSize: safeSize,
    totalRows: Number(count?.total ?? 0),
    // The date each record was reported under: billingDate, else createdAt.
    reportingDateRule: "COALESCE(billing_date, created_at::date)" as const,
  };
}

// ─── CSV export (Phase 11) — same filters + same calculation functions ────────

export const EXPORT_REPORT_TYPES = [
  "summary", "byLawyer", "byLeadPartner", "byClient", "byMatter",
  "outstandingByLawyer", "toBeBilledByLawyer", "collectedByLawyer",
  "discountReport", "invoiceStatus", "overdue", "details",
] as const;
export type ExportReportType = (typeof EXPORT_REPORT_TYPES)[number];

const EXPORT_DETAILS_CAP = 10_000;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRows(lines: unknown[][]): string {
  return lines.map(cells => cells.map(csvCell).join(",")).join("\r\n");
}

function appliedFilterLines(f: ReportFilters): unknown[][] {
  const entries = Object.entries(f).filter(([, v]) => v !== undefined && v !== "");
  if (!entries.length) return [["Filters", "none"]];
  return entries.map(([k, v]) => [`Filter: ${k}`, String(v)]);
}

/** Table definitions per report: header labels + row → cells mapping. */
function exportTable(reportType: ExportReportType, data: any): { header: string[]; rows: unknown[][] } {
  switch (reportType) {
    case "byLawyer":
    case "byLeadPartner": {
      const nameKey = reportType === "byLawyer" ? "lawyerName" : "leadPartnerName";
      return {
        header: [reportType === "byLawyer" ? "Lawyer" : "Lead Partner", "Clients", "Matters", "Records",
          "Agreed Fees", "Discount", "Net Fees", "Revenue", "Collected", "Outstanding", "To Be Billed", "Collection Rate %"],
        rows: data.map((r: any) => [r[nameKey], r.clientCount, r.matterCount, r.recordCount,
          r.agreedFees, r.discount, r.netFees, r.revenue, r.collected, r.outstanding, r.toBeBilled, r.collectionRate ?? ""]),
      };
    }
    case "byClient":
      return {
        header: ["Client Number", "Client Name", "Matters", "Records",
          "Agreed Fees", "Discount", "Net Fees", "Revenue", "Collected", "Outstanding", "To Be Billed"],
        rows: data.map((r: any) => [r.clientNumber ?? "", r.clientName, r.matterCount, r.recordCount,
          r.agreedFees, r.discount, r.netFees, r.revenue, r.collected, r.outstanding, r.toBeBilled]),
      };
    case "byMatter":
      return {
        header: ["Matter Reference", "Client", "Responsible Lawyer(s)", "Lead Partner", "Billing Type", "Records",
          "Agreed Fees", "Discount", "Net Fees", "Revenue", "Collected", "Outstanding", "To Be Billed"],
        rows: data.map((r: any) => [
          r.isClientLevel ? "Client-level / No Matter" : (r.matterReference ?? `Matter #${r.clientMatterId}`),
          r.clientName, r.responsibleLawyers ?? "", r.leadPartnerName ?? "", r.billingType ?? "", r.recordCount,
          r.agreedFees, r.discount, r.netFees, r.revenue, r.collected, r.outstanding, r.toBeBilled]),
      };
    case "outstandingByLawyer":
      return {
        header: ["Lawyer", "Open Records", "Revenue", "Collected", "Outstanding",
          "Oldest Due Date", "Overdue Outstanding", "Not-Yet-Due Outstanding"],
        rows: data.map((r: any) => [r.lawyerName, r.openRecordCount, r.revenue, r.collected, r.outstanding,
          r.oldestDueDate ?? "", r.overdueOutstanding, r.notYetDueOutstanding]),
      };
    case "toBeBilledByLawyer":
      return {
        header: ["Lawyer", "Records", "Agreed Fees", "Already Billed", "To Be Billed", "Oldest Unbilled Record Date"],
        rows: data.map((r: any) => [r.lawyerName, r.recordCount, r.agreedFees, r.alreadyBilled, r.toBeBilled,
          r.oldestUnbilledRecordDate ?? ""]),
      };
    case "collectedByLawyer":
      return {
        header: ["Lawyer", "Records", "Revenue", "Collected", "Outstanding", "Collection Rate %",
          "Fully Collected", "Partially Collected", "Uncollected"],
        rows: data.map((r: any) => [r.lawyerName, r.recordCount, r.revenue, r.collected, r.outstanding,
          r.collectionRate ?? "", r.fullyCollectedCount, r.partiallyCollectedCount, r.uncollectedCount]),
      };
    case "discountReport":
      return {
        header: ["Client", "Matter", "Responsible Lawyer", "Lead Partner", "Agreed Fees",
          "Discount Type (Approval)", "Discount %", "Discount Amount", "Net Fees", "Created By", "Last Updated"],
        rows: data.rows.map((r: any) => [r.clientName, r.matterReference ?? "", r.responsibleLawyerName ?? "",
          r.leadPartnerName ?? "", r.agreedFees, r.discountType ?? "", r.discountPercentage, r.discountAmount,
          r.netFees, r.createdByName ?? "", r.lastUpdated]),
      };
    case "invoiceStatus":
      return {
        header: ["Invoice Status", "Records", "Net Fees", "Invoice Amount (Revenue)", "Collected", "Outstanding", "To Be Billed"],
        rows: data.map((r: any) => [r.invoiceStatus ?? "", r.recordCount, r.netFees, r.invoiceAmount,
          r.collected, r.outstanding, r.toBeBilled]),
      };
    case "overdue":
      return {
        header: ["Invoice Number", "Client", "Matter", "Responsible Lawyer", "Lead Partner",
          "Invoice Date", "Due Date", "Days Overdue", "Invoice Amount (Revenue)", "Collected", "Outstanding", "Status"],
        rows: data.rows.map((r: any) => [r.invoiceNumber ?? "", r.clientName, r.matterReference ?? "",
          r.responsibleLawyerName ?? "", r.leadPartnerName ?? "", r.invoiceDate ?? "", r.dueDate, r.daysOverdue,
          r.invoiceAmount, r.collected, r.outstanding, r.status ?? ""]),
      };
    case "details":
      return {
        header: ["Record ID", "Client", "Matter", "Responsible Lawyer", "Lead Partner", "Fee Type", "Billing Type",
          "Invoice Status", "Invoice Number", "Agreed Fees", "Discount", "Net Fees", "Revenue", "Collected",
          "Outstanding", "To Be Billed", "Billing Date", "Due Date", "Reporting Date"],
        rows: data.rows.map((r: any) => [r.financialRecordId, r.clientName, r.matterReference ?? "",
          r.responsibleLawyerName ?? "", r.leadPartnerName ?? "", r.feeType ?? "", r.billingType ?? "",
          r.invoiceStatus ?? "", r.invoiceNumber ?? "", r.agreedFees, r.discountAmount, r.netFees, r.revenue,
          r.collected, r.outstanding, r.toBeBilled, r.billingDate ?? "", r.dueDate ?? "", r.effectiveDate]),
      };
    case "summary":
      return { header: ["Metric", "Value"], rows: Object.entries(data).map(([k, v]) => [k, String(v)]) };
  }
}

export async function exportReportCsv(reportType: ExportReportType, f: ReportFilters) {
  const summary = await getReportSummary(f);
  let data: any;
  switch (reportType) {
    case "summary":             data = summary; break;
    case "byLawyer":            data = await getRevenueByLawyer(f); break;
    case "byLeadPartner":       data = await getRevenueByLeadPartner(f); break;
    case "byClient":            data = await getRevenueByClient(f); break;
    case "byMatter":            data = await getRevenueByMatter(f); break;
    case "outstandingByLawyer": data = await getOutstandingByLawyer(f); break;
    case "toBeBilledByLawyer":  data = await getToBeBilledByLawyer(f); break;
    case "collectedByLawyer":   data = await getCollectedByLawyer(f); break;
    case "discountReport":      data = await getDiscountReport(f); break;
    case "invoiceStatus":       data = await getInvoiceStatusReport(f); break;
    case "overdue":             data = await getOverdueReport(f); break;
    case "details":             data = await getReportDetails(f, 1, EXPORT_DETAILS_CAP); break;
  }

  const table = exportTable(reportType, data);
  const truncated = reportType === "details" && data.totalRows > EXPORT_DETAILS_CAP;

  const meta: unknown[][] = [
    ["Report", reportType],
    ["Generated (UTC)", new Date().toISOString()],
    ["Currency", summary.currency],
    ...appliedFilterLines(f),
    ["Total Agreed Fees", summary.totalAgreedFees],
    ["Total Discount", summary.totalDiscount],
    ["Total Net Fees", summary.totalNetFees],
    ["Total Revenue", summary.totalRevenue],
    ["Total Collected", summary.totalCollected],
    ["Total Outstanding", summary.totalOutstanding],
    ["Total To Be Billed", summary.totalToBeBilled],
    ["Overdue Amount", summary.overdueAmount],
    ["Financial Records", summary.recordCount],
    ["Overdue Invoices", summary.overdueInvoiceCount],
    ...(truncated ? [[`NOTE`, `detail export capped at ${EXPORT_DETAILS_CAP} of ${data.totalRows} rows`]] : []),
    [],
  ];

  // BOM so Excel opens UTF-8 CSVs correctly.
  const csv = "\uFEFF" + csvRows(meta) + "\r\n" + csvRows([table.header, ...table.rows]) + "\r\n";
  return { csv, filename: `financial-report-${reportType}-${new Date().toISOString().slice(0, 10)}.csv` };
}
