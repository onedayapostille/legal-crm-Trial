import { useState, useMemo } from "react";
import {
  DollarSign, Edit2, Filter, Plus, RefreshCw, TrendingUp, AlertTriangle,
  Clock, Search, X, Users, BarChart3, History,
} from "lucide-react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import DashboardLayout from "@/components/DashboardLayout";
import FinancialDialog from "@/components/FinancialDialog";
import type { MatterOption, ClientOption } from "@/components/FinancialDialog";
import { FinancialAuditTrail } from "@/components/FinancialAuditTrail";
import { useAuth } from "@/_core/hooks/useAuth";
import { hasPermission } from "@shared/const";
import { useQueryParam } from "@/hooks/useQueryParam";

// ─── Shared constants ─────────────────────────────────────────────────────────

// DB column is still `collection_status` — only the UI label changes.
const INVOICE_STATUS_COLORS: Record<string, string> = {
  "Not Billed":          "bg-gray-100 text-gray-700",
  "Partially Billed":    "bg-yellow-100 text-yellow-800",
  "Billed":              "bg-blue-100 text-blue-800",
  "Partially Collected": "bg-orange-100 text-orange-800",
  "Fully Collected":     "bg-green-100 text-green-800",
  "Overdue":             "bg-red-100 text-red-800",
};

const INVOICE_STATUS_VALUES = [
  "Not Billed", "Partially Billed", "Billed",
  "Partially Collected", "Fully Collected", "Overdue",
] as const;

/** Formats a raw DB value with SAR prefix — returns "—" for null / empty / 0-looking strings */
const formatCurrency = (v: string | number | null | undefined) =>
  v != null && v !== "" && Number(v) !== 0
    ? `SAR ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0 })}`
    : v != null && v !== "" ? `SAR 0` : "—";

/** Always emits "SAR X" — used for aggregated numeric values that might be 0 */
const fmt = (n: number) =>
  `SAR ${n.toLocaleString("en-US", { minimumFractionDigits: 0 })}`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClientSummaryRow {
  clientId: number;
  clientName: string;
  recordCount: number;
  agreedFees: number;
  netFees: number;
  revenue: number;
  toBeBilled: number;
  outstandingAmount: number;
  collectedAmount: number;
  statuses: string[];
}

interface MatterSummaryRow {
  key: string;
  clientId: number;
  clientName: string;
  clientMatterId: number | null;
  matterReference: string | null;
  matterType: string | null;
  matterStatus: string | null;
  leadPartner: string | null;
  responsibleLawyers: string[];
  recordCount: number;
  agreedFees: number;
  netFees: number;
  revenue: number;
  toBeBilled: number;
  outstandingAmount: number;
  collectedAmount: number;
  statuses: string[];
}

interface GrandTotals {
  agreedFees: number;
  netFees: number;
  revenue: number;
  toBeBilled: number;
  outstandingAmount: number;
  collectedAmount: number;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FinancialRecords() {
  const { user } = useAuth();
  const canManage      = hasPermission(user?.role, "financial:manage");
  const canViewClients = hasPermission(user?.role, "clients:view");   // NC-10

  // ── View / tab state (URL-backed so it survives Back navigation) ────────────
  const [viewModeRaw, setViewMode]   = useQueryParam("view", "records");
  const viewMode = viewModeRaw as "records" | "overdue" | "summary";
  const [summaryTabRaw, setSummaryTab] = useQueryParam("tab", "client");
  const summaryTab = summaryTabRaw as "client" | "matter";

  // ── Filter state (URL-backed) ───────────────────────────────────────────────
  const [invoiceStatus, setInvoiceStatus] = useQueryParam("status", "all");
  const [clientFilter, setClientFilter]   = useQueryParam("client", "all");
  const [matterFilter, setMatterFilter]   = useQueryParam("matter", "all");
  const [searchQuery, setSearchQuery]     = useQueryParam("q", "");
  const [dateFrom, setDateFrom]           = useQueryParam("from", "");
  const [dateTo,   setDateTo]             = useQueryParam("to", "");

  // ── Edit / add / audit state ───────────────────────────────────────────────
  const [addDialogOpen,  setAddDialogOpen]  = useState(false);
  const [editingRecord,  setEditingRecord]  = useState<any | null>(null);
  const [auditRecord,    setAuditRecord]    = useState<any | null>(null);

  // ── Settings ───────────────────────────────────────────────────────────────
  const { data: overdueDays = 30 } = trpc.settings.getOverdueDays.useQuery();

  // ── Data fetching ──────────────────────────────────────────────────────────
  const { data: records = [], isLoading, refetch } = trpc.financial.list.useQuery({
    // Server-side invoice-status filter; everything else is client-side
    collectionStatus: invoiceStatus !== "all" ? invoiceStatus : undefined,
  });

  const { data: summary } = trpc.financial.summary.useQuery();
  // NC-10: only call clients.list when the user has clients:view permission to avoid
  // a tRPC permission error for users who have financial:view but not clients:view.
  const { data: clients  = [] } = trpc.clients.list.useQuery({}, { enabled: canViewClients });
  const { data: allMatters = [] } = trpc.clientMatters.listAll.useQuery();

  // ── Derived lookup maps ────────────────────────────────────────────────────
  const clientMap = useMemo(
    () => Object.fromEntries(clients.map(c => [c.id, c.clientName])),
    [clients],
  );

  /** matterId → full matter object */
  const allMatterMap = useMemo(
    () => Object.fromEntries(allMatters.map(m => [m.id, m])),
    [allMatters],
  );

  /** clientId → MatterOption[] — for the edit dialog */
  const mattersByClient = useMemo(() => {
    const map: Record<number, MatterOption[]> = {};
    for (const m of allMatters) {
      if (!map[m.clientId]) map[m.clientId] = [];
      map[m.clientId].push(m as MatterOption);
    }
    return map;
  }, [allMatters]);

  /** Client IDs that appear in at least one record (for the client dropdown) */
  const activeClientIds = useMemo(
    () => Array.from(new Set(records.map(r => r.clientId))),
    [records],
  );

  /** Matter IDs that appear in at least one record (for the matter dropdown).
   *  Type guard narrows `number | null` → `number` so downstream `!` casts are safe. */
  const activeMatterIds = useMemo(
    () => Array.from(new Set(records.map(r => r.clientMatterId).filter((id): id is number => id !== null))),
    [records],
  );

  // ── Client-side filtering ──────────────────────────────────────────────────
  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return records.filter(r => {
      // Client dropdown
      if (clientFilter !== "all" && String(r.clientId) !== clientFilter) return false;
      // Matter dropdown
      if (matterFilter === "none" && r.clientMatterId)                    return false;
      if (matterFilter !== "all" && matterFilter !== "none" &&
          String(r.clientMatterId) !== matterFilter)                      return false;
      // Free-text search: client name · matter ref · invoice # · responsible lawyer
      if (q) {
        const clientName  = (clientMap[r.clientId] ?? "").toLowerCase();
        const matter      = r.clientMatterId ? allMatterMap[r.clientMatterId] : null;
        const matterRef   = (matter?.matterReference ?? matter?.originalSerial ?? "").toLowerCase();
        const invoiceNum  = (r.invoiceNumber     ?? "").toLowerCase();
        const responsible = (r.responsibleLawyer ?? "").toLowerCase();
        if (!clientName.includes(q) && !matterRef.includes(q) &&
            !invoiceNum.includes(q) && !responsible.includes(q)) return false;
      }
      // Billing date range — records without a billing date always pass
      if (dateFrom && r.billingDate && String(r.billingDate) < dateFrom) return false;
      if (dateTo   && r.billingDate && String(r.billingDate) > dateTo)   return false;
      return true;
    });
  }, [records, clientFilter, matterFilter, searchQuery, dateFrom, dateTo, clientMap, allMatterMap]);

  // ── Overdue records (date-based computed flag from server) ─────────────────
  // isComputedOverdue is annotated by the backend using the configured threshold.
  const overdueRecords = useMemo(
    () => filteredRecords.filter((r: any) => r.isComputedOverdue),
    [filteredRecords],
  );

  // ── Client Summary aggregation ─────────────────────────────────────────────
  const clientSummary = useMemo((): ClientSummaryRow[] => {
    const map = new Map<number, ClientSummaryRow & { _statuses: Set<string> }>();
    for (const r of filteredRecords) {
      if (!map.has(r.clientId)) {
        map.set(r.clientId, {
          clientId: r.clientId,
          clientName: clientMap[r.clientId] ?? `Client #${r.clientId}`,
          recordCount: 0,
          agreedFees: 0, netFees: 0, revenue: 0,
          toBeBilled: 0, outstandingAmount: 0, collectedAmount: 0,
          statuses: [],
          _statuses: new Set(),
        });
      }
      const row = map.get(r.clientId)!;
      row.recordCount++;
      row.agreedFees        += Number(r.agreedFees)        || 0;
      row.netFees           += Number(r.netFees)           || 0;
      row.revenue           += Number(r.revenue)           || 0;
      row.outstandingAmount += Number(r.outstandingAmount) || 0;
      row.collectedAmount   += Number(r.collectedAmount)   || 0;
      if (r.collectionStatus) row._statuses.add(r.collectionStatus);
    }
    return Array.from(map.values())
      .map(({ _statuses, ...row }) => ({
        ...row,
        toBeBilled: Math.max(0, row.agreedFees - row.revenue),
        statuses:   Array.from(_statuses),
      }))
      .sort((a, b) => a.clientName.localeCompare(b.clientName));
  }, [filteredRecords, clientMap]);

  // ── Matter Summary aggregation ─────────────────────────────────────────────
  const matterSummary = useMemo((): MatterSummaryRow[] => {
    // key: "m-{matterId}" for linked records, "c-{clientId}" for client-level records
    const map = new Map<string, MatterSummaryRow & { _statuses: Set<string>; _lawyers: Set<string> }>();
    for (const r of filteredRecords) {
      const key = r.clientMatterId ? `m-${r.clientMatterId}` : `c-${r.clientId}`;
      if (!map.has(key)) {
        const m = r.clientMatterId ? allMatterMap[r.clientMatterId] : null;
        map.set(key, {
          key,
          clientId:       r.clientId,
          clientName:     clientMap[r.clientId] ?? `Client #${r.clientId}`,
          clientMatterId: r.clientMatterId ?? null,
          matterReference:m?.matterReference ?? m?.originalSerial ?? null,
          matterType:     m?.matterType      ?? null,
          matterStatus:   m?.matterStatus    ?? null,
          leadPartner:    m?.leadPartnerFullName ?? null,
          responsibleLawyers: [],
          recordCount: 0,
          agreedFees: 0, netFees: 0, revenue: 0,
          toBeBilled: 0, outstandingAmount: 0, collectedAmount: 0,
          statuses: [],
          _statuses: new Set(),
          _lawyers:  new Set(),
        });
      }
      const row = map.get(key)!;
      row.recordCount++;
      row.agreedFees        += Number(r.agreedFees)        || 0;
      row.netFees           += Number(r.netFees)           || 0;
      row.revenue           += Number(r.revenue)           || 0;
      row.outstandingAmount += Number(r.outstandingAmount) || 0;
      row.collectedAmount   += Number(r.collectedAmount)   || 0;
      if (r.collectionStatus)  row._statuses.add(r.collectionStatus);
      if (r.responsibleLawyer) row._lawyers.add(r.responsibleLawyer);
    }
    return Array.from(map.values())
      .map(({ _statuses, _lawyers, ...row }) => ({
        ...row,
        toBeBilled:         Math.max(0, row.agreedFees - row.revenue),
        statuses:           Array.from(_statuses),
        responsibleLawyers: Array.from(_lawyers),
      }))
      .sort((a, b) => {
        const c = a.clientName.localeCompare(b.clientName);
        if (c !== 0) return c;
        // Linked matters before client-level rows
        if (!a.clientMatterId && b.clientMatterId)  return 1;
        if (a.clientMatterId  && !b.clientMatterId) return -1;
        return (a.matterReference ?? "").localeCompare(b.matterReference ?? "");
      });
  }, [filteredRecords, clientMap, allMatterMap]);

  // ── Grand totals (follow the filtered set) ─────────────────────────────────
  const grandTotals = useMemo((): GrandTotals => {
    return filteredRecords.reduce((acc, r) => {
      const agreed  = Number(r.agreedFees) || 0;
      const revenue = Number(r.revenue)    || 0;
      acc.agreedFees        += agreed;
      acc.netFees           += Number(r.netFees)           || 0;
      acc.revenue           += revenue;
      acc.toBeBilled        += Math.max(0, agreed - revenue);
      acc.outstandingAmount += Number(r.outstandingAmount) || 0;
      acc.collectedAmount   += Number(r.collectedAmount)   || 0;
      return acc;
    }, { agreedFees: 0, netFees: 0, revenue: 0, toBeBilled: 0, outstandingAmount: 0, collectedAmount: 0 });
  }, [filteredRecords]);

  // ── Permission guard ───────────────────────────────────────────────────────
  if (!hasPermission(user?.role, "financial:view")) {
    return (
      <DashboardLayout>
        <div className="p-12 text-center">
          <AlertTriangle className="h-12 w-12 mx-auto mb-3 text-destructive opacity-60" />
          <h2 className="text-xl font-semibold">Access Restricted</h2>
          <p className="text-muted-foreground mt-2">
            You don't have permission to view financial records.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function matterCell(r: any) {
    if (!r.clientMatterId) {
      return <span className="text-xs text-muted-foreground italic">Client-level</span>;
    }
    const m = allMatterMap[r.clientMatterId];
    if (!m) return <span className="font-mono text-xs">#{r.clientMatterId}</span>;
    return (
      <span className="text-xs leading-tight">
        <Link href={`/clients/${m.clientId}`} className="font-medium text-blue-600 hover:underline">
          {m.matterReference ?? m.originalSerial ?? `#${m.id}`}
        </Link>
        {m.matterType && (
          <span className="text-muted-foreground"> · {m.matterType}</span>
        )}
      </span>
    );
  }

  const hasActiveFilters =
    invoiceStatus !== "all" || clientFilter !== "all" || matterFilter !== "all" ||
    searchQuery.trim() !== "" || dateFrom !== "" || dateTo !== "";

  function clearAllFilters() {
    setInvoiceStatus("all");
    setClientFilter("all");
    setMatterFilter("all");
    setSearchQuery("");
    setDateFrom("");
    setDateTo("");
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="space-y-5">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Financial Records</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Fee agreements, billing, and collection tracking
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Quick Add */}
            {canManage && (
              <Button size="sm" onClick={() => setAddDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-1.5" />Add Financial Record
              </Button>
            )}

            {/* View toggle */}
            <div className="flex rounded-lg border bg-muted p-0.5 gap-0.5">
              <Button
                variant={viewMode === "records" ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs px-3"
                onClick={() => setViewMode("records")}
              >
                <DollarSign className="h-3.5 w-3.5 mr-1.5" />Records
              </Button>
              <Button
                variant={viewMode === "overdue" ? "default" : "ghost"}
                size="sm"
                className={`h-7 text-xs px-3 ${viewMode !== "overdue" && overdueRecords.length > 0 ? "text-red-600" : ""}`}
                onClick={() => setViewMode("overdue")}
              >
                <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
                Overdue
                {overdueRecords.length > 0 && (
                  <span className="ml-1 rounded-full bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 leading-none">
                    {overdueRecords.length}
                  </span>
                )}
              </Button>
              <Button
                variant={viewMode === "summary" ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs px-3"
                onClick={() => setViewMode("summary")}
              >
                <BarChart3 className="h-3.5 w-3.5 mr-1.5" />Summary
              </Button>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-1" />Refresh
            </Button>
          </div>
        </div>

        {/* ── KPI cards (global totals — not affected by filters) ─────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SummaryCard
            label="Total Revenue"
            value={formatCurrency(summary?.totalRevenue ?? 0)}
            icon={TrendingUp}
            color="bg-green-600"
          />
          <SummaryCard
            label="Total Outstanding"
            value={formatCurrency(summary?.totalOutstanding ?? 0)}
            icon={Clock}
            color="bg-orange-500"
          />
          <SummaryCard
            label="Overdue Records"
            value={String(summary?.overdueCount ?? 0)}
            icon={AlertTriangle}
            color="bg-red-600"
          />
        </div>

        {/* ── Filters ─────────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="pt-4 pb-4 space-y-3">

            {/* Row 1: search + dropdowns */}
            <div className="flex flex-wrap gap-3 items-center">

              {/* Free-text search */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search client, matter, invoice…"
                  className="pl-8 h-9 w-64 text-sm"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Invoice Status */}
              <Select value={invoiceStatus} onValueChange={setInvoiceStatus}>
                <SelectTrigger className="w-48 h-9">
                  <Filter className="h-4 w-4 mr-2 shrink-0" />
                  <SelectValue placeholder="Invoice Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Invoice Statuses</SelectItem>
                  {INVOICE_STATUS_VALUES.map(s => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Client */}
              <Select value={clientFilter} onValueChange={v => { setClientFilter(v); setMatterFilter("all"); }}>
                <SelectTrigger className="w-48 h-9">
                  <SelectValue placeholder="All Clients" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Clients</SelectItem>
                  {activeClientIds.map(id => (
                    <SelectItem key={id} value={String(id)}>
                      {clientMap[id] ?? `Client #${id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Matter */}
              <Select value={matterFilter} onValueChange={setMatterFilter}>
                <SelectTrigger className="w-52 h-9">
                  <SelectValue placeholder="All Matters" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Matters</SelectItem>
                  <SelectItem value="none">Client-level only</SelectItem>
                  {activeMatterIds
                    .filter(mid => {
                      if (clientFilter === "all") return true;
                      const m = allMatterMap[mid];
                      return m && String(m.clientId) === clientFilter;
                    })
                    .map(mid => {
                      const m = allMatterMap[mid];
                      if (!m) return null;
                      return (
                        <SelectItem key={mid} value={String(mid)}>
                          {m.matterReference ?? m.originalSerial ?? `Matter #${mid}`}
                          {m.matterType ? ` · ${m.matterType}` : ""}
                        </SelectItem>
                      );
                    })}
                </SelectContent>
              </Select>
            </div>

            {/* Row 2: billing date range + clear */}
            <div className="flex flex-wrap gap-3 items-center">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Billing date:</span>
              <Input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="h-8 w-36 text-xs"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="h-8 w-36 text-xs"
              />
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground text-xs h-8"
                  onClick={clearAllFilters}
                >
                  <X className="h-3 w-3 mr-1" />Clear all filters
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── Totals strip — reflects current filters ──────────────────────── */}
        {filteredRecords.length > 0 && (
          <div className="rounded-lg border bg-muted/30 px-4 py-2.5">
            <div className="flex flex-wrap gap-x-6 gap-y-1.5 items-center">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Filtered totals&nbsp;·&nbsp;{filteredRecords.length}&nbsp;record{filteredRecords.length !== 1 ? "s" : ""}
                {hasActiveFilters && (
                  <span className="normal-case font-normal"> (of {records.length})</span>
                )}
              </span>
              <TotalPill label="Agreed"       value={fmt(grandTotals.agreedFees)} />
              <TotalPill label="Net Fees"     value={fmt(grandTotals.netFees)} />
              <TotalPill label="Revenue"      value={fmt(grandTotals.revenue)}      color="text-green-700" />
              <TotalPill label="To Be Billed" value={fmt(grandTotals.toBeBilled)}   color="text-amber-600 font-semibold" />
              <TotalPill label="Outstanding"  value={fmt(grandTotals.outstandingAmount)} color="text-red-600" />
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/*  RECORDS VIEW                                                        */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {viewMode === "records" && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <DollarSign className="h-4 w-4" />
                {filteredRecords.length} financial record{filteredRecords.length !== 1 ? "s" : ""}
                {hasActiveFilters && (
                  <span className="text-xs font-normal text-muted-foreground">
                    (filtered from {records.length})
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-8 text-center text-muted-foreground">Loading…</div>
              ) : filteredRecords.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <DollarSign className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p>No financial records match the current filters.</p>
                  {hasActiveFilters && (
                    <Button variant="link" size="sm" onClick={clearAllFilters}>
                      Clear all filters
                    </Button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Client</TableHead>
                        <TableHead>Matter</TableHead>
                        <TableHead>Fee Type</TableHead>
                        <TableHead>Agreed Fees</TableHead>
                        <TableHead>To Be Billed</TableHead>
                        <TableHead>Net Fees</TableHead>
                        <TableHead>Revenue</TableHead>
                        <TableHead>Collected</TableHead>
                        <TableHead>Outstanding</TableHead>
                        <TableHead>Invoice Status</TableHead>
                        <TableHead>Invoice #</TableHead>
                        <TableHead>Responsible</TableHead>
                        <TableHead className="w-20" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRecords.map(r => (
                        <TableRow key={r.id}>
                          <TableCell className="font-medium text-sm">
                            <Link href={`/clients/${r.clientId}`} className="text-blue-600 hover:underline">
                              {clientMap[r.clientId] ?? `Client #${r.clientId}`}
                            </Link>
                          </TableCell>
                          <TableCell className="min-w-[110px]">{matterCell(r)}</TableCell>
                          <TableCell className="text-sm">{r.feeType ?? "—"}</TableCell>
                          <TableCell className="text-sm">{formatCurrency(r.agreedFees)}</TableCell>
                          <TableCell className="text-sm">
                            {(() => {
                              // Revenue is the single amount source (Billed Amount removed).
                              const agreed  = Number(r.agreedFees) || 0;
                              const revenue = Number(r.revenue)    || 0;
                              const tbb     = Math.max(0, agreed - revenue);
                              const over    = agreed > 0 && revenue > agreed;
                              if (over) return <span className="text-red-600 font-medium text-xs">Over-recognized</span>;
                              if (tbb === 0 && agreed > 0) return <span className="text-green-700 text-xs font-medium">Fully billed</span>;
                              return <span className={tbb > 0 ? "text-amber-700 font-medium" : "text-muted-foreground"}>{formatCurrency(tbb)}</span>;
                            })()}
                          </TableCell>
                          <TableCell className="text-sm">{formatCurrency(r.netFees)}</TableCell>
                          <TableCell className="text-sm">{formatCurrency(r.revenue)}</TableCell>
                          <TableCell className="text-sm">{formatCurrency(r.collectedAmount)}</TableCell>
                          <TableCell className="text-sm">{formatCurrency(r.outstandingAmount)}</TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={INVOICE_STATUS_COLORS[r.collectionStatus ?? ""] ?? ""}
                            >
                              {r.collectionStatus ?? "—"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm font-mono">{r.invoiceNumber ?? "—"}</TableCell>
                          <TableCell className="text-sm">{r.responsibleLawyer ?? "—"}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setAuditRecord(r)}
                                title="View change history"
                              >
                                <History className="h-4 w-4 text-muted-foreground" />
                              </Button>
                              {canManage && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setEditingRecord(r)}
                                  title="Edit record"
                                >
                                  <Edit2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/*  OVERDUE VIEW                                                         */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {viewMode === "overdue" && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-red-700">
                <AlertTriangle className="h-4 w-4" />
                Overdue Records
                <span className="text-xs font-normal text-muted-foreground ml-1">
                  ({overdueRecords.length} record{overdueRecords.length !== 1 ? "s" : ""})
                </span>
              </CardTitle>
              {/* Explanation text driven by the configured threshold */}
              <p className="text-sm text-muted-foreground">
                Records appear here when unpaid for more than{" "}
                <span className="font-semibold text-foreground">{overdueDays} day{overdueDays !== 1 ? "s" : ""}</span>{" "}
                after billing date. Only billed/partially-collected invoices are evaluated;
                fully collected and unbilled records are excluded.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-8 text-center text-muted-foreground">Loading…</div>
              ) : overdueRecords.length === 0 ? (
                <div className="p-12 text-center text-muted-foreground">
                  <AlertTriangle className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p className="font-medium">No overdue records</p>
                  <p className="text-xs mt-1 opacity-70">
                    All billed invoices have been paid within {overdueDays} day{overdueDays !== 1 ? "s" : ""}.
                  </p>
                  {hasActiveFilters && (
                    <Button variant="link" size="sm" onClick={clearAllFilters} className="mt-2">
                      Clear filters to see all records
                    </Button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-red-50/50">
                        <TableHead>Client</TableHead>
                        <TableHead>Matter</TableHead>
                        <TableHead>Fee Type</TableHead>
                        <TableHead>Agreed Fees</TableHead>
                        <TableHead>Net Fees</TableHead>
                        <TableHead>Revenue</TableHead>
                        <TableHead>Collected</TableHead>
                        <TableHead>Outstanding</TableHead>
                        <TableHead>Invoice Status</TableHead>
                        <TableHead>Billing Date</TableHead>
                        <TableHead>Days Overdue</TableHead>
                        <TableHead>Invoice #</TableHead>
                        <TableHead>Responsible</TableHead>
                        <TableHead className="w-20" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {overdueRecords.map((r: any) => {
                        const daysOverdue = r.billingDate
                          ? Math.floor(
                              (Date.now() - new Date(r.billingDate).setHours(0, 0, 0, 0)) /
                              (1000 * 60 * 60 * 24),
                            )
                          : null;
                        return (
                          <TableRow key={r.id} className="bg-red-50/20 hover:bg-red-50/40">
                            <TableCell className="font-medium text-sm">
                              <Link href={`/clients/${r.clientId}`} className="text-blue-600 hover:underline">
                                {clientMap[r.clientId] ?? `Client #${r.clientId}`}
                              </Link>
                            </TableCell>
                            <TableCell className="min-w-[110px]">{matterCell(r)}</TableCell>
                            <TableCell className="text-sm">{r.feeType ?? "—"}</TableCell>
                            <TableCell className="text-sm">{formatCurrency(r.agreedFees)}</TableCell>
                            <TableCell className="text-sm">{formatCurrency(r.netFees)}</TableCell>
                            <TableCell className="text-sm">{formatCurrency(r.revenue)}</TableCell>
                            <TableCell className="text-sm">{formatCurrency(r.collectedAmount)}</TableCell>
                            <TableCell className="text-sm text-red-700 font-medium">
                              {formatCurrency(r.outstandingAmount)}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={INVOICE_STATUS_COLORS[r.collectionStatus ?? ""] ?? ""}
                              >
                                {r.collectionStatus ?? "—"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {r.billingDate ?? "—"}
                            </TableCell>
                            <TableCell>
                              {daysOverdue !== null ? (
                                <span className="text-sm font-semibold text-red-700">
                                  {daysOverdue}d
                                </span>
                              ) : "—"}
                            </TableCell>
                            <TableCell className="text-sm font-mono">{r.invoiceNumber ?? "—"}</TableCell>
                            <TableCell className="text-sm">{r.responsibleLawyer ?? "—"}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setAuditRecord(r)}
                                  title="View change history"
                                >
                                  <History className="h-4 w-4 text-muted-foreground" />
                                </Button>
                                {canManage && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setEditingRecord(r)}
                                    title="Edit record"
                                  >
                                    <Edit2 className="h-4 w-4" />
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/*  SUMMARY VIEW                                                        */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {viewMode === "summary" && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="h-4 w-4" />
                  Financial Summary
                  <span className="text-xs font-normal text-muted-foreground">
                    {filteredRecords.length} record{filteredRecords.length !== 1 ? "s" : ""}
                    {hasActiveFilters && ` of ${records.length}`}
                  </span>
                </CardTitle>

                {/* Sub-tab toggle */}
                <div className="flex rounded-lg border bg-muted p-0.5 gap-0.5">
                  <Button
                    variant={summaryTab === "client" ? "default" : "ghost"}
                    size="sm"
                    className="h-7 text-xs px-3"
                    onClick={() => setSummaryTab("client")}
                  >
                    <Users className="h-3.5 w-3.5 mr-1.5" />By Client
                  </Button>
                  <Button
                    variant={summaryTab === "matter" ? "default" : "ghost"}
                    size="sm"
                    className="h-7 text-xs px-3"
                    onClick={() => setSummaryTab("matter")}
                  >
                    <BarChart3 className="h-3.5 w-3.5 mr-1.5" />By Matter
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-8 text-center text-muted-foreground">Loading…</div>
              ) : filteredRecords.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <DollarSign className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p>No financial records match the current filters.</p>
                  {hasActiveFilters && (
                    <Button variant="link" size="sm" onClick={clearAllFilters}>
                      Clear all filters
                    </Button>
                  )}
                </div>
              ) : summaryTab === "client" ? (
                <ClientSummaryTable rows={clientSummary} totals={grandTotals} />
              ) : (
                <MatterSummaryTable rows={matterSummary} totals={grandTotals} />
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Quick Add dialog — client picker + dynamic matter loading built into the dialog */}
      <FinancialDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        allClients={clients as ClientOption[]}
      />

      {/* Edit dialog — client + matters pre-resolved by the page */}
      <FinancialDialog
        open={editingRecord !== null}
        onClose={() => setEditingRecord(null)}
        clientId={editingRecord?.clientId}
        record={editingRecord}
        matters={
          editingRecord
            ? (mattersByClient[editingRecord.clientId] ?? [])
            : undefined
        }
      />

      {/* Audit trail dialog — read-only */}
      {auditRecord && (
        <FinancialAuditTrail
          open={auditRecord !== null}
          onClose={() => setAuditRecord(null)}
          record={auditRecord}
        />
      )}
    </DashboardLayout>
  );
}

// ─── TotalPill ────────────────────────────────────────────────────────────────

function TotalPill({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-xs text-muted-foreground">{label}:</span>
      <span className={`text-sm font-semibold ${color ?? "text-foreground"}`}>{value}</span>
    </span>
  );
}

// ─── StatusBadges ─────────────────────────────────────────────────────────────

function StatusBadges({ statuses }: { statuses: string[] }) {
  if (statuses.length === 0) return <span className="text-muted-foreground text-xs">—</span>;
  const shown  = statuses.slice(0, 2);
  const hidden = statuses.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map(s => (
        <Badge
          key={s}
          variant="outline"
          className={`text-xs py-0 px-1.5 ${INVOICE_STATUS_COLORS[s] ?? ""}`}
        >
          {s}
        </Badge>
      ))}
      {hidden > 0 && (
        <Badge variant="secondary" className="text-xs py-0 px-1.5">+{hidden}</Badge>
      )}
    </div>
  );
}

// ─── TBB Cell ─────────────────────────────────────────────────────────────────

function TbbCell({ agreed, revenue }: { agreed: number; revenue: number }) {
  const tbb  = Math.max(0, agreed - revenue);
  const over = agreed > 0 && revenue > agreed;
  if (over)               return <span className="text-red-600 font-medium text-xs">Over-recognized</span>;
  if (tbb === 0 && agreed > 0) return <span className="text-green-700 text-xs font-medium">Fully billed</span>;
  if (tbb === 0)          return <span className="text-muted-foreground text-xs">—</span>;
  return <span className="text-amber-700 font-semibold text-sm">{fmt(tbb)}</span>;
}

// ─── Client Summary Table ─────────────────────────────────────────────────────

function ClientSummaryTable({ rows, totals }: { rows: ClientSummaryRow[]; totals: GrandTotals }) {
  const totalRecords = rows.reduce((s, r) => s + r.recordCount, 0);
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="min-w-[190px] pl-4">Client</TableHead>
            <TableHead className="text-center w-20">Records</TableHead>
            <TableHead className="text-right">Agreed Fees</TableHead>
            <TableHead className="text-right">Net Fees</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead className="text-right text-amber-700">To Be Billed</TableHead>
            <TableHead className="text-right">Outstanding</TableHead>
            <TableHead className="min-w-[160px]">Invoice Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(r => (
            <TableRow key={r.clientId} className="hover:bg-muted/20">
              <TableCell className="pl-4 font-medium">
                <Link href={`/clients/${r.clientId}`}>
                  <span className="text-sm text-blue-600 hover:underline cursor-pointer">
                    {r.clientName}
                  </span>
                </Link>
              </TableCell>
              <TableCell className="text-center text-xs text-muted-foreground">{r.recordCount}</TableCell>
              <TableCell className="text-right text-sm">{fmt(r.agreedFees)}</TableCell>
              <TableCell className="text-right text-sm">{fmt(r.netFees)}</TableCell>
              <TableCell className="text-right text-sm font-medium text-green-700">{fmt(r.revenue)}</TableCell>
              <TableCell className="text-right">
                <TbbCell agreed={r.agreedFees} revenue={r.revenue} />
              </TableCell>
              <TableCell className="text-right text-sm text-red-600">{fmt(r.outstandingAmount)}</TableCell>
              <TableCell><StatusBadges statuses={r.statuses} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
        {/* Grand total footer */}
        <tfoot>
          <tr className="border-t-2 border-border bg-muted/60 font-semibold text-sm">
            <td className="px-4 py-2.5 pl-4">Grand Total</td>
            <td className="px-4 py-2.5 text-center text-xs">{totalRecords}</td>
            <td className="px-4 py-2.5 text-right">{fmt(totals.agreedFees)}</td>
            <td className="px-4 py-2.5 text-right">{fmt(totals.netFees)}</td>
            <td className="px-4 py-2.5 text-right text-green-700">{fmt(totals.revenue)}</td>
            <td className="px-4 py-2.5 text-right text-amber-700">{fmt(totals.toBeBilled)}</td>
            <td className="px-4 py-2.5 text-right text-red-600">{fmt(totals.outstandingAmount)}</td>
            <td className="px-4 py-2.5" />
          </tr>
        </tfoot>
      </Table>
    </div>
  );
}

// ─── Matter Summary Table ─────────────────────────────────────────────────────

function MatterSummaryTable({ rows, totals }: { rows: MatterSummaryRow[]; totals: GrandTotals }) {
  const totalRecords = rows.reduce((s, r) => s + r.recordCount, 0);
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="min-w-[170px] pl-4">Client</TableHead>
            <TableHead className="min-w-[150px]">Matter</TableHead>
            <TableHead className="min-w-[110px]">Matter Status</TableHead>
            <TableHead className="min-w-[150px]">Lead Partner / Lawyer</TableHead>
            <TableHead className="text-center w-20">Records</TableHead>
            <TableHead className="text-right">Agreed Fees</TableHead>
            <TableHead className="text-right">Net Fees</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead className="text-right text-amber-700">To Be Billed</TableHead>
            <TableHead className="text-right">Outstanding</TableHead>
            <TableHead className="min-w-[160px]">Invoice Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(r => (
            <TableRow key={r.key} className="hover:bg-muted/20">
              {/* Client */}
              <TableCell className="pl-4 font-medium">
                <Link href={`/clients/${r.clientId}`}>
                  <span className="text-sm text-blue-600 hover:underline cursor-pointer">
                    {r.clientName}
                  </span>
                </Link>
              </TableCell>

              {/* Matter reference */}
              <TableCell>
                {r.clientMatterId ? (
                  <div className="text-xs leading-tight">
                    <Link href={`/clients/${r.clientId}`} className="font-semibold text-sm text-blue-600 hover:underline">
                      {r.matterReference ?? `#${r.clientMatterId}`}
                    </Link>
                    {r.matterType && (
                      <p className="text-muted-foreground">{r.matterType}</p>
                    )}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground italic">Client-level record</span>
                )}
              </TableCell>

              {/* Matter status */}
              <TableCell>
                {r.matterStatus
                  ? <Badge variant="secondary" className="text-xs">{r.matterStatus}</Badge>
                  : <span className="text-muted-foreground text-xs">—</span>}
              </TableCell>

              {/* Lead partner / responsible lawyer */}
              <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate">
                {r.leadPartner ?? (r.responsibleLawyers.length > 0 ? r.responsibleLawyers.join(", ") : "—")}
              </TableCell>

              <TableCell className="text-center text-xs text-muted-foreground">{r.recordCount}</TableCell>
              <TableCell className="text-right text-sm">{fmt(r.agreedFees)}</TableCell>
              <TableCell className="text-right text-sm">{fmt(r.netFees)}</TableCell>
              <TableCell className="text-right text-sm font-medium text-green-700">{fmt(r.revenue)}</TableCell>
              <TableCell className="text-right">
                <TbbCell agreed={r.agreedFees} revenue={r.revenue} />
              </TableCell>
              <TableCell className="text-right text-sm text-red-600">{fmt(r.outstandingAmount)}</TableCell>
              <TableCell><StatusBadges statuses={r.statuses} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
        {/* Grand total footer */}
        <tfoot>
          <tr className="border-t-2 border-border bg-muted/60 font-semibold text-sm">
            <td className="px-4 py-2.5 pl-4" colSpan={4}>Grand Total</td>
            <td className="px-4 py-2.5 text-center text-xs">{totalRecords}</td>
            <td className="px-4 py-2.5 text-right">{fmt(totals.agreedFees)}</td>
            <td className="px-4 py-2.5 text-right">{fmt(totals.netFees)}</td>
            <td className="px-4 py-2.5 text-right text-green-700">{fmt(totals.revenue)}</td>
            <td className="px-4 py-2.5 text-right text-amber-700">{fmt(totals.toBeBilled)}</td>
            <td className="px-4 py-2.5 text-right text-red-600">{fmt(totals.outstandingAmount)}</td>
            <td className="px-4 py-2.5" />
          </tr>
        </tfoot>
      </Table>
    </div>
  );
}

// ─── SummaryCard ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, icon: Icon, color }: {
  label: string;
  value: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
          </div>
          <div className={`p-3 rounded-xl ${color}`}>
            <Icon className="h-5 w-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
