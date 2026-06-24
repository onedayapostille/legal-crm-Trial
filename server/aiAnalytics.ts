import { and, count, desc, eq, gte, isNotNull, lt, ne, sql } from "drizzle-orm";
import {
  getDb,
  getClientConversionMetrics,
  getFinancialSummary,
  getRecentActivity,
  taskVisibilityCondition,
  type TaskViewer,
} from "./db";
import {
  clients, leads, clientMatters, financialRecords, tasks, users,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import type { NvidiaChatMessage } from "./_core/nvidia";

/**
 * Read-only CRM analytics for the AI Assistant.
 *
 * The AI NEVER touches the database and NEVER sees or generates SQL. It only
 * receives the structured JSON produced by these safe, parameterized aggregate
 * functions. What data a user's question can reach is decided here, server-side,
 * by `gatherCrmData` based on the caller's role.
 */

export type AiPeriod = "month" | "quarter" | "year" | "all";

/** Inclusive lower-bound date for a period, or null for "all time". */
export function aiPeriodStart(period: AiPeriod, now = new Date()): Date | null {
  const y = now.getFullYear();
  const m = now.getMonth();
  if (period === "month") return new Date(y, m, 1);
  if (period === "quarter") return new Date(y, Math.floor(m / 3) * 3, 1);
  if (period === "year") return new Date(y, 0, 1);
  return null;
}

const PERIOD_LABEL: Record<AiPeriod, string> = {
  month: "This Month",
  quarter: "This Quarter",
  year: "This Year",
  all: "All Time",
};

// ── Individual read-only summaries ────────────────────────────────────────────

export async function getClientsSummary(period: AiPeriod) {
  const db = getDb();
  const start = aiPeriodStart(period);
  const inRange = start ? gte(clients.createdAt, start) : undefined;
  const rows = await db
    .select({ status: clients.clientStatus, c: count() })
    .from(clients)
    .where(inRange)
    .groupBy(clients.clientStatus);
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { byStatus[r.status] = Number(r.c); total += Number(r.c); }
  return {
    period: PERIOD_LABEL[period],
    totalClients: total,
    existingClients: byStatus["Existing Client"] ?? 0,
    leads: byStatus["Leads"] ?? 0,
    rejected: byStatus["Rejected"] ?? 0,
  };
}

export async function getLeadsSummary(period: AiPeriod) {
  const db = getDb();
  const start = aiPeriodStart(period);
  const inRange = start ? gte(leads.createdAt, start) : undefined;
  const rows = await db
    .select({ status: leads.currentStatus, c: count() })
    .from(leads)
    .where(inRange)
    .groupBy(leads.currentStatus);
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { byStatus[r.status] = Number(r.c); total += Number(r.c); }
  // Open leads that still need follow-up (not Converted, not Lost).
  const FOLLOW_UP = ["New", "Contacted", "Meeting Scheduled", "Proposal Sent", "On Hold"];
  const needFollowUp = FOLLOW_UP.reduce((s, k) => s + (byStatus[k] ?? 0), 0);
  return {
    period: PERIOD_LABEL[period],
    totalLeads: total,
    byStatus,
    converted: byStatus["Converted"] ?? 0,
    lost: byStatus["Lost"] ?? 0,
    needFollowUp,
  };
}

export async function getConversionRate(period: AiPeriod) {
  // Source of truth: the Leads Pipeline (canonical clients intake model), NOT the
  // revenue Pipeline and NOT raw SQL from the AI.
  const m = await getClientConversionMetrics(period);
  return {
    period: PERIOD_LABEL[period],
    conversionRate: m.conversionRate,
    convertedLeads: m.convertedLeads,
    totalLeads: m.totalLeads,
  };
}

export async function getFinancialSummaryForAi(period: AiPeriod) {
  // Firm financial position is point-in-time; reported all-time. Period is echoed
  // for context. (Does not alter any existing financial formula.)
  const f = await getFinancialSummary();
  return {
    period: PERIOD_LABEL[period],
    note: "Financial figures reflect the current firm-wide position (point-in-time).",
    totalRevenue: f.totalRevenue,
    totalOutstanding: f.totalOutstanding,
    totalToBeBilled: f.totalToBeBilled,
    overdueInvoices: f.overdueCount,
    overdueThresholdDays: f.overdueDays,
  };
}

export async function getOutstandingAmounts(period: AiPeriod) {
  const db = getDb();
  const [totals] = await db
    .select({
      totalOutstanding: sql<string>`COALESCE(SUM(${financialRecords.outstandingAmount}), 0)`,
      withBalance: sql<string>`COUNT(*) FILTER (WHERE COALESCE(${financialRecords.outstandingAmount}, 0) > 0)`,
    })
    .from(financialRecords);
  const top = await db
    .select({
      clientName: clients.clientName,
      outstanding: sql<string>`COALESCE(SUM(${financialRecords.outstandingAmount}), 0)`,
    })
    .from(financialRecords)
    .leftJoin(clients, eq(clients.id, financialRecords.clientId))
    .groupBy(clients.clientName)
    .having(sql`COALESCE(SUM(${financialRecords.outstandingAmount}), 0) > 0`)
    .orderBy(desc(sql`COALESCE(SUM(${financialRecords.outstandingAmount}), 0)`))
    .limit(5);
  return {
    period: PERIOD_LABEL[period],
    totalOutstanding: Number(totals?.totalOutstanding ?? 0),
    recordsWithBalance: Number(totals?.withBalance ?? 0),
    topOutstandingClients: top.map(t => ({
      client: t.clientName ?? "Unknown",
      outstanding: Number(t.outstanding),
    })),
  };
}

export async function getMattersSummary(period: AiPeriod) {
  const db = getDb();
  const start = aiPeriodStart(period);
  const inRange = start ? gte(clientMatters.createdAt, start) : undefined;
  const rows = await db
    .select({ status: clientMatters.matterStatus, c: count() })
    .from(clientMatters)
    .where(inRange)
    .groupBy(clientMatters.matterStatus);
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { byStatus[r.status ?? "Unspecified"] = Number(r.c); total += Number(r.c); }
  // "Delayed" signal: open matters explicitly flagged On Hold / Delayed in status.
  const [delayed] = await db
    .select({ c: count() })
    .from(clientMatters)
    .where(
      and(
        inRange,
        sql`(${clientMatters.matterStatus} ILIKE '%hold%' OR ${clientMatters.matterStatus} ILIKE '%delay%')`,
      ),
    );
  return {
    period: PERIOD_LABEL[period],
    totalMatters: total,
    byStatus,
    delayedMatters: Number(delayed?.c ?? 0),
  };
}

export async function getTasksSummary(period: AiPeriod, viewer?: TaskViewer) {
  const db = getDb();
  const start = aiPeriodStart(period);
  const scope = viewer ? await taskVisibilityCondition(viewer) : null;

  const baseConds = [start ? gte(tasks.createdAt, start) : undefined, scope ?? undefined];
  const rows = await db
    .select({ status: tasks.status, c: count() })
    .from(tasks)
    .where(and(...baseConds))
    .groupBy(tasks.status);
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { byStatus[r.status] = Number(r.c); total += Number(r.c); }

  // Overdue ignores the period (an old overdue task is still overdue) but respects
  // the viewer's visibility scope.
  const [overdue] = await db
    .select({ c: count() })
    .from(tasks)
    .where(and(
      isNotNull(tasks.dueDate),
      lt(tasks.dueDate, sql`CURRENT_DATE`),
      ne(tasks.status, "done"),
      ne(tasks.status, "cancelled"),
      scope ?? undefined,
    ));

  return {
    period: PERIOD_LABEL[period],
    scope: viewer ? "assigned/visible to you" : "firm-wide",
    totalTasks: total,
    byStatus,
    openTasks: (byStatus["todo"] ?? 0) + (byStatus["in_progress"] ?? 0),
    overdueTasks: Number(overdue?.c ?? 0),
  };
}

export async function getLawyerWorkload(period: AiPeriod, viewer?: TaskViewer) {
  const db = getDb();
  const scope = viewer ? await taskVisibilityCondition(viewer) : null;
  // Open tasks grouped by assignee, with an overdue tally per lawyer.
  const rows = await db
    .select({
      lawyer: users.name,
      open: sql<string>`COUNT(*) FILTER (WHERE ${tasks.status} IN ('todo','in_progress'))`,
      overdue: sql<string>`COUNT(*) FILTER (WHERE ${tasks.dueDate} IS NOT NULL AND ${tasks.dueDate} < CURRENT_DATE AND ${tasks.status} NOT IN ('done','cancelled'))`,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedTo))
    .where(and(isNotNull(tasks.assignedTo), scope ?? undefined))
    .groupBy(users.name);
  return {
    period: PERIOD_LABEL[period],
    scope: viewer ? "you only" : "firm-wide",
    lawyers: rows
      .map(r => ({ lawyer: r.lawyer ?? "Unassigned", openTasks: Number(r.open), overdueTasks: Number(r.overdue) }))
      .filter(r => r.openTasks > 0 || r.overdueTasks > 0)
      .sort((a, b) => b.overdueTasks - a.overdueTasks || b.openTasks - a.openTasks),
  };
}

export async function getRecentActivitySummary(_period: AiPeriod) {
  const rows = await getRecentActivity(10);
  return rows.map((r: any) => ({
    action: r.action ?? null,
    entityType: r.entityType ?? null,
    description: typeof r.description === "string" ? r.description.slice(0, 160) : null,
    at: r.createdAt ?? null,
  }));
}

// ── Role-scoped data gathering ────────────────────────────────────────────────

export type AiGathered = {
  data: Record<string, unknown>;
  scope: { role: string; period: AiPeriod; sections: string[] };
};

/**
 * Build the structured JSON the AI may use, scoped to the caller's role:
 *   - admin / manager → all operational + financial summaries
 *   - finance         → financial summaries ONLY
 *   - partner/lawyer/staff → operational summaries (no financial); tasks +
 *                            workload restricted to what the viewer may see
 */
export async function gatherCrmData(
  viewer: { id: number; role: string },
  period: AiPeriod,
): Promise<AiGathered> {
  const role = viewer.role;
  const data: Record<string, unknown> = {};
  const sections: string[] = [];
  const add = (name: string, value: unknown) => { data[name] = value; sections.push(name); };

  const isAdminLike = role === "admin" || role === "manager";
  const isFinance = role === "finance";

  if (isFinance) {
    add("financialSummary", await getFinancialSummaryForAi(period));
    add("outstandingAmounts", await getOutstandingAmounts(period));
    return { data, scope: { role, period, sections } };
  }

  // Operational (non-financial) summaries for everyone else.
  add("clientsSummary", await getClientsSummary(period));
  add("leadsSummary", await getLeadsSummary(period));
  add("conversionRate", await getConversionRate(period));
  add("mattersSummary", await getMattersSummary(period));

  // Partner/lawyer/staff are restricted to tasks/workload they may see.
  const restrictToOwn = !isAdminLike;
  const taskViewer = restrictToOwn ? { id: viewer.id, role } : undefined;
  add("tasksSummary", await getTasksSummary(period, taskViewer));
  add("lawyerWorkload", await getLawyerWorkload(period, taskViewer));
  add("recentActivity", await getRecentActivitySummary(period));

  // Admin/manager additionally see financials.
  if (isAdminLike) {
    add("financialSummary", await getFinancialSummaryForAi(period));
    add("outstandingAmounts", await getOutstandingAmounts(period));
  }

  return { data, scope: { role, period, sections } };
}

// ── Prompt construction ───────────────────────────────────────────────────────

export const AI_SYSTEM_PROMPT = `You are an internal CRM assistant for AlGhazzawi & Partners.
Answer only using the CRM data provided by the backend.
Do not invent clients, matters, financial numbers, deadlines, or legal conclusions.
If data is missing, clearly say that the CRM data is not available.
Provide concise management insights, risks, and recommended next actions.
Do not expose internal reasoning or chain-of-thought.
Return the final answer only.
Use a professional tone suitable for law firm management.`;

export function buildAiMessages(
  question: string,
  data: Record<string, unknown>,
  period: AiPeriod,
): NvidiaChatMessage[] {
  return [
    { role: "system", content: AI_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Question: ${question}\n\n` +
        `Reporting period: ${PERIOD_LABEL[period]}\n\n` +
        `CRM Data (the only facts you may use):\n${JSON.stringify(data, null, 2)}`,
    },
  ];
}

export const AI_MODEL_NAME = ENV.nvidiaModel;

// ── Simple per-user rate limiter (in-memory sliding window) ───────────────────

const RATE_LIMIT = 20;          // max requests
const RATE_WINDOW_MS = 60_000;  // per minute, per user
const hits = new Map<number, number[]>();

/** Returns { allowed, retryAfterMs }. Records the hit when allowed. */
export function checkAiRateLimit(userId: number, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
  const arr = (hits.get(userId) ?? []).filter(ts => now - ts < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) {
    const retryAfterMs = RATE_WINDOW_MS - (now - arr[0]);
    hits.set(userId, arr);
    return { allowed: false, retryAfterMs };
  }
  arr.push(now);
  hits.set(userId, arr);
  return { allowed: true, retryAfterMs: 0 };
}

/** Test helper — clears the limiter state. */
export function __resetAiRateLimit() { hits.clear(); }
