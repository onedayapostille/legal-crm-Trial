import { useState } from "react";
import { Link } from "wouter";
import {
  Users, Briefcase, CheckSquare, TrendingUp, DollarSign,
  ArrowRight, Plus, Clock, AlertCircle, Building2, UserCheck,
  UserX, Calendar, AlertTriangle, Receipt, ShieldCheck, Loader2,
} from "lucide-react";
import ConflictCheckDialog from "@/components/ConflictCheckDialog";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import DashboardLayout from "@/components/DashboardLayout";
import { TaskDetailDialog } from "@/components/TaskDetailDialog";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/permissions";

function StatCard({
  title, value, subtitle, icon: Icon, color, href
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ElementType;
  color: string;
  href?: string;
}) {
  const content = (
    <Card className="hover:shadow-md transition-shadow cursor-pointer">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold mt-1">{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
          </div>
          <div className={`p-3 rounded-xl ${color}`}>
            <Icon className="h-6 w-6 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}

export default function Dashboard() {
  const { data: stats, isLoading } = trpc.dashboard.stats.useQuery();
  const { data: me } = trpc.auth.me.useQuery();
  const { data: recentActivity } = trpc.dashboard.recentActivity.useQuery({ limit: 8 });
  const { data: tasks } = trpc.tasks.list.useQuery({});
  const { user } = useAuth();

  // AlGhazzawi client stats — capabilities from the central policy; all data
  // below is additionally scoped server-side to what the viewer may see.
  const canViewClients = can(user?.role, "clients.view");
  const canViewFinancial = can(user?.role, "financial.view");
  const { data: clientStats } = trpc.clients.dashboardStats.useQuery(undefined, { enabled: canViewClients });
  // Recent Leads = Lead-status clients created in the last 30 days (newest first,
  // capped server-side). Date window uses the DB clock for timezone consistency.
  const {
    data: recentLeads = [],
    isLoading: recentLeadsLoading,
    isError: recentLeadsError,
    isSuccess: recentLeadsLoaded,
  } = trpc.clients.recentLeads.useQuery(
    { days: 30, limit: 5 },
    { enabled: canViewClients },
  );
  const { data: financialSummary } = trpc.financial.summary.useQuery(undefined, { enabled: canViewFinancial });
  const { data: tbbBreakdown } = trpc.financial.toBeBilledBreakdown.useQuery(undefined, { enabled: canViewFinancial });

  // "To Be Billed" breakdown view toggle
  const [tbbView, setTbbView] = useState<"client" | "matter">("client");

  // Conversion Rate date range: this month / this quarter / all time
  const [convRange, setConvRange] = useState<"month" | "quarter" | "all">("all");
  const { data: conversion } = trpc.clients.conversionMetrics.useQuery({ range: convRange });

  // Conflict Check dialog
  const [conflictOpen, setConflictOpen] = useState(false);

  // Task details modal (opened from the Pending Tasks widget).
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);

  const pendingTasks = tasks?.filter(t => t.status !== "done") ?? [];
  const overdueTasks = pendingTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date());

  const formatSAR = (n: number) =>
    `SAR ${new Intl.NumberFormat("en-US", { minimumFractionDigits: 0 }).format(n)}`;
  const formatCurrency = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(n);
  const conversionPeriodLabel = {
    month: "This Month",
    quarter: "This Quarter",
    all: "All Time",
  }[convRange];
  const conversionRate = conversion?.conversionRate ?? 0;
  const convertedLeads = conversion?.convertedLeads ?? conversion?.converted ?? 0;
  const totalLeads = conversion?.totalLeads ?? conversion?.total ?? 0;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              Welcome back{me?.name ? `, ${me.name}` : ""}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setConflictOpen(true)}>
              <ShieldCheck className="h-4 w-4 mr-1" /> Run Conflict Check
            </Button>
            {canViewClients && (
              <Link href="/clients/new">
                <Button size="sm">
                  <Plus className="h-4 w-4 mr-1" /> New Client
                </Button>
              </Link>
            )}
            <Link href="/leads/new">
              <Button size="sm" variant="outline">
                <Plus className="h-4 w-4 mr-1" /> New Lead
              </Button>
            </Link>
            <Link href="/tasks/new">
              <Button size="sm" variant="outline">
                <Plus className="h-4 w-4 mr-1" /> New Task
              </Button>
            </Link>
          </div>
        </div>

        {/* KPI Cards */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}><CardContent className="pt-6"><div className="h-16 animate-pulse bg-muted rounded" /></CardContent></Card>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              title="Active Leads"
              value={clientStats?.leads ?? 0}
              subtitle="In Lead status — excludes Rejected"
              icon={Users}
              color="bg-blue-500"
              href="/clients/leads"
            />
            <StatCard
              title="Active Matters"
              value={stats?.activeMatters ?? 0}
              subtitle="Status = Active"
              icon={Briefcase}
              color="bg-indigo-500"
              href="/matters?status=Active"
            />
            <StatCard
              title="Pending Tasks"
              value={stats?.pendingTasks ?? 0}
              subtitle={overdueTasks.length > 0 ? `${overdueTasks.length} overdue` : "All on track"}
              icon={CheckSquare}
              color={overdueTasks.length > 0 ? "bg-orange-500" : "bg-green-500"}
              href="/tasks"
            />
            <Card className="hover:shadow-md transition-shadow">
              <CardContent className="pt-6">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-muted-foreground">Conversion Rate</p>
                    <p className="text-3xl font-bold mt-1">
                      {conversionRate.toFixed(1)}%
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {convertedLeads} converted / {totalLeads} leads
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{conversionPeriodLabel}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-purple-500">
                    <TrendingUp className="h-6 w-6 text-white" />
                  </div>
                </div>
                <div className="flex gap-1 mt-3">
                  {([
                    ["month", "Month"],
                    ["quarter", "Quarter"],
                    ["all", "All"],
                  ] as const).map(([value, label]) => (
                    <Button
                      key={value}
                      variant={convRange === value ? "secondary" : "ghost"}
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => setConvRange(value)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* AlGhazzawi Client Registry Cards */}
        {canViewClients && clientStats && (
          <>
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Client Registry
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatCard
                  title="Total Clients"
                  value={clientStats.total}
                  icon={Building2}
                  color="bg-slate-600"
                  href="/clients"
                />
                <StatCard
                  title="Existing Clients"
                  value={clientStats.existing}
                  subtitle="Active / converted clients"
                  icon={UserCheck}
                  color="bg-green-600"
                  href="/clients/existing"
                />
                <StatCard
                  title="Leads Pipeline"
                  value={clientStats.leads}
                  subtitle="In Lead status — needs follow-up"
                  icon={Users}
                  color="bg-blue-600"
                  href="/clients/leads"
                />
                <StatCard
                  title="Rejected"
                  value={clientStats.rejected}
                  icon={UserX}
                  color="bg-red-500"
                  href="/clients/rejected"
                />
              </div>
            </div>

            {canViewFinancial && financialSummary && (
              <div className="space-y-4">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Financial Overview
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatCard
                    title="Total Revenue"
                    value={formatSAR(financialSummary.totalRevenue)}
                    icon={DollarSign}
                    color="bg-emerald-600"
                    href="/financial"
                  />
                  <StatCard
                    title="Outstanding Amount"
                    value={formatSAR(financialSummary.totalOutstanding)}
                    icon={Clock}
                    color="bg-orange-500"
                    href="/financial"
                  />
                  <StatCard
                    title="Overdue Collections"
                    value={financialSummary.overdueCount}
                    icon={AlertTriangle}
                    color="bg-red-600"
                    href="/financial"
                  />
                  <StatCard
                    title="To Be Billed"
                    value={formatSAR(financialSummary.totalToBeBilled)}
                    subtitle="Pending invoicing"
                    icon={Receipt}
                    color="bg-amber-500"
                    href="/financial"
                  />
                </div>

                {/* To Be Billed breakdown widget */}
                {tbbBreakdown && (tbbBreakdown.byClient.length > 0 || tbbBreakdown.byMatter.length > 0) && (
                  <Card>
                    <CardHeader className="pb-2 pt-4 px-4">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Receipt className="h-4 w-4 text-amber-500" />
                          To Be Billed — Breakdown
                        </CardTitle>
                        <div className="flex gap-1">
                          <Button
                            variant={tbbView === "client" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setTbbView("client")}
                          >
                            By Client
                          </Button>
                          <Button
                            variant={tbbView === "matter" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setTbbView("matter")}
                          >
                            By Matter
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="p-0">
                      {tbbView === "client" ? (
                        tbbBreakdown.byClient.length === 0 ? (
                          <p className="text-xs text-muted-foreground px-4 pb-4">No pending billing by client.</p>
                        ) : (
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="pl-4">Client</TableHead>
                                <TableHead className="text-right pr-4">To Be Billed</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {tbbBreakdown.byClient.map(r => (
                                <TableRow key={r.clientId}>
                                  <TableCell className="pl-4">
                                    <Link href={`/clients/${r.clientId}`} className="text-sm text-blue-600 hover:underline">
                                      {r.clientName}
                                    </Link>
                                  </TableCell>
                                  <TableCell className="text-right pr-4 text-sm font-medium text-amber-700">
                                    {formatSAR(r.toBeBilled)}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        )
                      ) : (
                        tbbBreakdown.byMatter.length === 0 ? (
                          <p className="text-xs text-muted-foreground px-4 pb-4">No matter-level pending billing found.</p>
                        ) : (
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="pl-4">Client</TableHead>
                                <TableHead>Matter</TableHead>
                                <TableHead className="text-right pr-4">To Be Billed</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {tbbBreakdown.byMatter.map(r => (
                                <TableRow key={`m-${r.clientMatterId ?? r.clientId}`}>
                                  <TableCell className="pl-4">
                                    <Link href={`/clients/${r.clientId}`} className="text-xs text-blue-600 hover:underline">
                                      {r.clientName}
                                    </Link>
                                  </TableCell>
                                  <TableCell className="text-xs text-muted-foreground">
                                    {r.matterReference ?? `Matter #${r.clientMatterId}`}
                                    {r.matterType ? ` · ${r.matterType}` : ""}
                                  </TableCell>
                                  <TableCell className="text-right pr-4 text-sm font-medium text-amber-700">
                                    {formatSAR(r.toBeBilled)}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        )
                      )}
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            <StatCard
              title="Actions Due This Week"
              value={clientStats.actionsThisWeek}
              subtitle="Client action log items"
              icon={Calendar}
              color="bg-violet-600"
              href="/client-actions"
            />
          </>
        )}

        {/* Revenue card (null when the viewer has no firm-wide financial access) */}
        {stats && stats.totalRevenue != null && stats.totalRevenue > 0 && (
          <Card className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white border-0">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-blue-100 text-sm font-medium">Total Revenue (Converted)</p>
                  <p className="text-3xl font-bold mt-1">{formatCurrency(stats.totalRevenue)}</p>
                </div>
                <DollarSign className="h-12 w-12 text-blue-200 opacity-60" />
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Recent Leads */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Recent Leads</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Showing leads from the last 30 days.
                  </p>
                </div>
                {/* View All → full Leads Pipeline (no date restriction) */}
                <Link href="/clients/leads">
                  <Button variant="ghost" size="sm" className="text-xs">
                    View All <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {/* Distinguish loading / error from a confirmed-empty result so the
                  "No new leads" message appears ONLY when the backend has actually
                  returned zero leads for the last 30 days — not while the query is
                  still in flight or the user lacks clients:view. */}
              {!canViewClients ? (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  You don’t have permission to view leads.
                </div>
              ) : recentLeadsLoading ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading recent leads…
                </div>
              ) : recentLeadsError ? (
                <div className="text-center py-6 text-destructive text-sm">
                  Couldn’t load recent leads. Please retry.
                </div>
              ) : recentLeadsLoaded && recentLeads.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  No new leads in the last 30 days.{" "}
                  <Link href="/clients/new" className="text-blue-600 hover:underline">Add a lead</Link>
                </div>
              ) : (
                <div className="space-y-3">
                  {recentLeads.map(lead => (
                    <Link key={lead.id} href={`/clients/${lead.id}`}>
                      <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer">
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{lead.clientName}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {lead.clientNumber || lead.city || lead.matterType || "New lead"}
                          </p>
                        </div>
                        <StatusBadge status={lead.clientStatus ?? "Leads"} />
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Pending Tasks */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Pending Tasks</CardTitle>
                <Link href="/tasks">
                  <Button variant="ghost" size="sm" className="text-xs">
                    View all <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {pendingTasks.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  No pending tasks.
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingTasks.slice(0, 5).map(task => {
                    const isOverdue = task.dueDate && new Date(task.dueDate) < new Date();
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => setDetailTaskId(task.id)}
                        className="w-full text-left flex items-start gap-3 py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors"
                        title="View task details"
                      >
                        {isOverdue ? (
                          <AlertCircle className="h-4 w-4 text-orange-500 mt-0.5 flex-shrink-0" />
                        ) : (
                          <Clock className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm truncate">{task.title}</p>
                          {task.dueDate && (
                            <p className={`text-xs mt-0.5 ${isOverdue ? "text-orange-500" : "text-muted-foreground"}`}>
                              Due {new Date(task.dueDate).toLocaleDateString()}
                            </p>
                          )}
                        </div>
                        <PriorityBadge priority={task.priority ?? "medium"} />
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Recent Activity */}
        {recentActivity && recentActivity.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Recent Activity</CardTitle>
              <CardDescription>Latest actions in the CRM</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {recentActivity.map(log => (
                  <div key={log.id} className="flex items-start gap-3 text-sm">
                    <div className="w-2 h-2 rounded-full bg-blue-500 mt-2 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">{log.description ?? log.action}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(log.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <ConflictCheckDialog open={conflictOpen} onClose={() => setConflictOpen(false)} />
      <TaskDetailDialog
        taskId={detailTaskId}
        open={detailTaskId != null}
        onClose={() => setDetailTaskId(null)}
      />
    </DashboardLayout>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    New: "bg-blue-100 text-blue-700",
    // Client-module statuses (Recent Leads shows Lead-status clients)
    Leads: "bg-blue-100 text-blue-700",
    "Existing Client": "bg-green-100 text-green-700",
    Rejected: "bg-red-100 text-red-700",
    Contacted: "bg-yellow-100 text-yellow-700",
    "Meeting Scheduled": "bg-purple-100 text-purple-700",
    "Proposal Sent": "bg-orange-100 text-orange-700",
    Converted: "bg-green-100 text-green-700",
    Lost: "bg-red-100 text-red-700",
    "On Hold": "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const map: Record<string, string> = {
    low: "bg-gray-100 text-gray-600",
    medium: "bg-blue-100 text-blue-700",
    high: "bg-orange-100 text-orange-700",
    urgent: "bg-red-100 text-red-700",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${map[priority] ?? "bg-gray-100 text-gray-600"}`}>
      {priority}
    </span>
  );
}
