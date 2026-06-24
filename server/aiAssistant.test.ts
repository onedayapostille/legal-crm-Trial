import { describe, expect, it, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import {
  gatherCrmData, getConversionRate, getClientsSummary, getTasksSummary,
  aiPeriodStart, __resetAiRateLimit,
} from "./aiAnalytics";
import { getClientConversionMetrics } from "./db";
import { NVIDIA_UNAVAILABLE_MESSAGE } from "./_core/nvidia";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;
function callerFor(role: string, id: number) {
  const user: AuthenticatedUser = {
    id, openId: `test-${role}-${id}`, email: `u${id}@example.com`, name: `User ${id}`,
    loginMethod: "manus", role: role as any, status: "active",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}

// Runs OFFLINE: NVIDIA_API_KEY is unset in tests, so ai.ask gathers real CRM data
// (DB) but the NVIDIA call short-circuits to the safe fallback — no network.
beforeEach(() => __resetAiRateLimit());

describe("AI Assistant — RBAC access", () => {
  it("unauthorized role (viewer) gets 403 (FORBIDDEN)", async () => {
    const viewer = callerFor("viewer", 9);
    await expect(viewer.ai.ask({ question: "anything", period: "month" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admin can ask and receives the full data scope (operational + financial)", async () => {
    const admin = callerFor("admin", 1);
    const res = await admin.ai.ask({ question: "Summarize performance", period: "month" });
    expect(res.dataScope).toEqual(expect.arrayContaining([
      "clientsSummary", "leadsSummary", "conversionRate", "mattersSummary",
      "tasksSummary", "lawyerWorkload", "financialSummary", "outstandingAmounts",
    ]));
  });

  it("finance user receives ONLY financial data scope", async () => {
    const finance = callerFor("finance", 4);
    const res = await finance.ai.ask({ question: "Outstanding?", period: "quarter" });
    expect(res.dataScope.sort()).toEqual(["financialSummary", "outstandingAmounts"]);
    // No operational/client data for finance.
    expect(res.dataScope).not.toContain("clientsSummary");
    expect(res.dataScope).not.toContain("tasksSummary");
  });

  it("partner/lawyer receive permitted operational data but NOT financial data", async () => {
    for (const role of ["partner", "lawyer"]) {
      const caller = callerFor(role, 7);
      const res = await caller.ai.ask({ question: "My tasks?", period: "month" });
      expect(res.dataScope).toContain("tasksSummary");
      expect(res.dataScope).toContain("mattersSummary");
      expect(res.dataScope).not.toContain("financialSummary");
      expect(res.dataScope).not.toContain("outstandingAmounts");
    }
  });
});

describe("AI Assistant — NVIDIA failure + key safety", () => {
  it("returns the safe fallback when NVIDIA is unavailable (no key configured)", async () => {
    const admin = callerFor("admin", 1);
    const res = await admin.ai.ask({ question: "Conversion this month?", period: "month" });
    expect(res.ok).toBe(false);
    expect(res.answer).toBe(NVIDIA_UNAVAILABLE_MESSAGE);
  });

  it("never exposes the NVIDIA API key in the response", async () => {
    const admin = callerFor("admin", 1);
    const res = await admin.ai.ask({ question: "Risks?", period: "all" });
    const serialized = JSON.stringify(res).toLowerCase();
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("nvapi-");
    // Response carries only a scope name list + answer/flags, never raw CRM rows.
    expect(Object.keys(res).sort()).toEqual(["answer", "dataScope", "ok", "period"]);
  });
});

describe("AI Assistant — period filters + safe analytics (no raw SQL to AI)", () => {
  it("ai.ask works for every period and echoes it back", async () => {
    const admin = callerFor("admin", 1);
    for (const period of ["month", "quarter", "year", "all"] as const) {
      const res = await admin.ai.ask({ question: "status?", period });
      expect(res.period).toBe(period);
    }
  });

  it("aiPeriodStart computes month/quarter/year boundaries and null for all", () => {
    const now = new Date(2026, 5, 15); // 2026-06-15
    expect(aiPeriodStart("month", now)).toEqual(new Date(2026, 5, 1));
    expect(aiPeriodStart("quarter", now)).toEqual(new Date(2026, 3, 1)); // Q2 → Apr 1
    expect(aiPeriodStart("year", now)).toEqual(new Date(2026, 0, 1));
    expect(aiPeriodStart("all", now)).toBeNull();
  });

  it("Conversion Rate comes from the Leads Pipeline (matches getClientConversionMetrics)", async () => {
    const fromAi = await getConversionRate("month");
    const canonical = await getClientConversionMetrics("month");
    expect(fromAi.conversionRate).toBe(canonical.conversionRate);
    expect(fromAi.convertedLeads).toBe(canonical.converted);
    expect(fromAi.totalLeads).toBe(canonical.total);
  });

  it("analytics summaries return plain JSON (numbers/strings only — never a DB handle)", async () => {
    const clientsSummary = await getClientsSummary("all");
    // JSON round-trips cleanly → contains no functions / DB clients / SQL.
    expect(() => JSON.parse(JSON.stringify(clientsSummary))).not.toThrow();
    expect(typeof clientsSummary.totalClients).toBe("number");
    const json = JSON.stringify(clientsSummary).toLowerCase();
    expect(json).not.toContain("select ");
    expect(json).not.toContain("drizzle");
  });

  it("task scope differs by role: a lawyer's tasksSummary is restricted to their visibility", async () => {
    const firmWide = await getTasksSummary("all");                 // no viewer → firm-wide
    const lawyerScoped = await getTasksSummary("all", { id: 99999, role: "lawyer" });
    expect(firmWide.scope).toBe("firm-wide");
    expect(lawyerScoped.scope).toBe("assigned/visible to you");
    // A lawyer with no tasks sees <= the firm-wide total.
    expect(lawyerScoped.totalTasks).toBeLessThanOrEqual(firmWide.totalTasks);
  });
});

describe("AI Assistant — audit logging", () => {
  it("writes an audit row (question + scope + model) and does NOT store the answer", async () => {
    const admin = callerFor("admin", 1);
    const stamp = `audit-probe-${Date.now()}`;
    await admin.ai.ask({ question: stamp, period: "quarter" });

    const logs = await admin.ai.auditLog({ limit: 50 });
    const row: any = logs.find((l: any) => l.question === stamp);
    expect(row).toBeTruthy();
    expect(row.period).toBe("quarter");
    expect(typeof row.dataScopeUsed).toBe("string");
    expect(row.dataScopeUsed.length).toBeGreaterThan(0);
    // The audit row has no column for the AI answer.
    expect("answer" in row).toBe(false);
  });

  it("non-admins cannot read the AI audit log", async () => {
    const partner = callerFor("partner", 7);
    await expect(partner.ai.auditLog({ limit: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
