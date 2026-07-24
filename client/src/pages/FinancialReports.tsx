import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, BarChart3, Download, FileText, Loader2, RefreshCw, Search, X,
} from "lucide-react";
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
import { useAuth } from "@/_core/hooks/useAuth";
import { userCan } from "@/lib/permissions";
import { useQueryParam } from "@/hooks/useQueryParam";

// ─── Formatting (display only — totals are computed server-side in SQL) ───────

/** SAR money display. Values arrive as exact numeric strings from the API. */
const sar = (v: string | number | null | undefined) =>
  `SAR ${Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Exact display-side column sum: integer cents, no float drift. */
const sumCents = (values: Array<string | number | null | undefined>) =>
  values.reduce<number>((acc, v) => acc + Math.round(Number(v ?? 0) * 100), 0);
const sarFromCents = (cents: number) =>
  `SAR ${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

const pct = (v: string | null | undefined) => (v == null ? "—" : `${v}%`);

const FEE_TYPES = [
  "Billable Hours", "Fixed / Project-Based Fees", "Retainers",
  "Success Fees", "Advisory / Special Mandates", "Blended",
] as const;

const INVOICE_STATUSES = [
  "Not Billed", "Partially Billed", "Billed",
  "Partially Collected", "Fully Collected", "Overdue",
] as const;

const TABS = [
  { key: "overview",    label: "Overview" },
  { key: "lawyer",      label: "By Lawyer" },
  { key: "partner",     label: "By Partner" },
  { key: "hop",         label: "By Head of Practice" },
  { key: "client",      label: "By Client" },
  { key: "matter",      label: "By Matter" },
  { key: "outstanding", label: "Outstanding" },
  { key: "tbb",         label: "To Be Billed" },
  { key: "collected",   label: "Collected" },
  { key: "discounts",   label: "Discounts" },
  { key: "status",      label: "Invoice Status" },
  { key: "overdue",     label: "Overdue" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** Tab → export report type (matches EXPORT_REPORT_TYPES on the server). */
const TAB_EXPORT: Record<TabKey, string | null> = {
  overview: "invoiceStatus",
  lawyer: "byLawyer",
  partner: "byLeadPartner",
  hop: null,
  client: "byClient",
  matter: "byMatter",
  outstanding: "outstandingByLawyer",
  tbb: "toBeBilledByLawyer",
  collected: "collectedByLawyer",
  discounts: "discountReport",
  status: "invoiceStatus",
  overdue: "overdue",
};

export default function FinancialReports() {
  const { user } = useAuth();
  const canViewClients = userCan(user, "clients:view");

  // ── URL-backed filter state ────────────────────────────────────────────────
  const [tabRaw, setTab]            = useQueryParam("tab", "overview");
  const tab = (TABS.some(t => t.key === tabRaw) ? tabRaw : "overview") as TabKey;
  const [dateFrom, setDateFrom]     = useQueryParam("from", "");
  const [dateTo, setDateTo]         = useQueryParam("to", "");
  const [clientF, setClientF]       = useQueryParam("client", "all");
  const [matterF, setMatterF]       = useQueryParam("matter", "all");
  const [lawyerF, setLawyerF]       = useQueryParam("lawyer", "all");
  const [partnerF, setPartnerF]     = useQueryParam("partner", "all");
  const [feeTypeF, setFeeTypeF]     = useQueryParam("feeType", "all");
  const [statusF, setStatusF]       = useQueryParam("status", "all");
  const [billingTypeF, setBillingTypeF] = useQueryParam("billingType", "all");
  const [searchQ, setSearchQ]       = useQueryParam("q", "");
  const [noMatterF, setNoMatterF]   = useQueryParam("noMatter", "include");   // include | exclude
  const [unassignedF, setUnassignedF] = useQueryParam("unassigned", "include");
  const [pageRaw, setPage]          = useQueryParam("page", "1");
  const page = Math.max(1, Number(pageRaw) || 1);

  // Debounced search box (350 ms) so typing doesn't refetch per keystroke.
  const [searchInput, setSearchInput] = useState(searchQ);
  useEffect(() => { setSearchInput(searchQ); }, [searchQ]);
  useEffect(() => {
    const t = setTimeout(() => { if (searchInput !== searchQ) { setSearchQ(searchInput); setPage("1"); } }, 350);
    return () => clearTimeout(t);
  }, [searchInput]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Central filter object — the SAME object goes to every endpoint ──────────
  const filters = useMemo(() => ({
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    clientId: clientF !== "all" ? Number(clientF) : undefined,
    clientMatterId: matterF !== "all" && matterF !== "none" ? Number(matterF) : undefined,
    lawyerId: lawyerF !== "all" ? Number(lawyerF) : undefined,
    leadPartnerId: partnerF !== "all" ? Number(partnerF) : undefined,
    feeType: feeTypeF !== "all" ? (feeTypeF as (typeof FEE_TYPES)[number]) : undefined,
    invoiceStatus: statusF !== "all" ? (statusF as (typeof INVOICE_STATUSES)[number]) : undefined,
    billingType: billingTypeF !== "all" ? (billingTypeF as (typeof FEE_TYPES)[number]) : undefined,
    search: searchQ || undefined,
    includeNoMatter: noMatterF === "exclude" ? false : undefined,
    onlyNoMatter: matterF === "none" ? true : undefined,
    includeUnassignedLawyer: unassignedF === "exclude" ? false : undefined,
  }), [dateFrom, dateTo, clientF, matterF, lawyerF, partnerF, feeTypeF, statusF, billingTypeF, searchQ, noMatterF, unassignedF]);

  const resetFilters = () => {
    setDateFrom(""); setDateTo(""); setClientF("all"); setMatterF("all");
    setLawyerF("all"); setPartnerF("all"); setFeeTypeF("all"); setStatusF("all");
    setBillingTypeF("all"); setSearchQ(""); setSearchInput("");
    setNoMatterF("include"); setUnassignedF("include"); setPage("1");
  };

  // ── Dropdown data ──────────────────────────────────────────────────────────
  const { data: clients = [] } = trpc.clients.list.useQuery({}, { enabled: canViewClients });
  const { data: matters = [] } = trpc.clientMatters.listAll.useQuery();
  const { data: lawyers = [] } = trpc.users.eligibleLawyers.useQuery({ field: "responsibleLawyer" });
  const { data: partners = [] } = trpc.users.eligibleLawyers.useQuery({ field: "leadPartner" });

  // ── Report data (KPIs always; grouped report per active tab) ───────────────
  const summaryQ = trpc.financialReports.summary.useQuery(filters);
  const byLawyerQ = trpc.financialReports.byLawyer.useQuery(filters, { enabled: tab === "lawyer" });
  const byPartnerQ = trpc.financialReports.byLeadPartner.useQuery(filters, { enabled: tab === "partner" });
  const byHopQ = trpc.financialReports.byHeadOfPractice.useQuery(filters, { enabled: tab === "hop" });
  const byClientQ = trpc.financialReports.byClient.useQuery(filters, { enabled: tab === "client" });
  const byMatterQ = trpc.financialReports.byMatter.useQuery(filters, { enabled: tab === "matter" });
  const outstandingQ = trpc.financialReports.outstandingByLawyer.useQuery(filters, { enabled: tab === "outstanding" });
  const tbbQ = trpc.financialReports.toBeBilledByLawyer.useQuery(filters, { enabled: tab === "tbb" });
  const collectedQ = trpc.financialReports.collectedByLawyer.useQuery(filters, { enabled: tab === "collected" });
  const discountQ = trpc.financialReports.discountReport.useQuery(filters, { enabled: tab === "discounts" });
  const statusQ = trpc.financialReports.invoiceStatus.useQuery(filters, { enabled: tab === "status" || tab === "overview" });
  const overdueQ = trpc.financialReports.overdue.useQuery(filters, { enabled: tab === "overdue" });
  const detailsQ = trpc.financialReports.details.useQuery({ ...filters, page, pageSize: 25 });

  const summary = summaryQ.data;

  // ── CSV export (server-generated, same filters + same calculation service) ──
  const exportMut = trpc.financialReports.export.useMutation({
    onSuccess: ({ csv, filename }) => {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    },
  });
  const exportCsv = (reportType: string) =>
    exportMut.mutate({ ...filters, reportType: reportType as any });

  // ── Active filter chips ────────────────────────────────────────────────────
  const chips: Array<{ label: string; clear: () => void }> = [];
  if (dateFrom) chips.push({ label: `From ${dateFrom}`, clear: () => setDateFrom("") });
  if (dateTo)   chips.push({ label: `To ${dateTo}`,     clear: () => setDateTo("") });
  if (clientF !== "all") chips.push({
    label: `Client: ${clients.find(c => String(c.id) === clientF)?.clientName ?? clientF}`,
    clear: () => setClientF("all"),
  });
  if (matterF !== "all") chips.push({
    label: matterF === "none" ? "Client-level records only"
      : `Matter: ${matters.find(m => String(m.id) === matterF)?.matterReference ?? matterF}`,
    clear: () => setMatterF("all"),
  });
  if (lawyerF !== "all") chips.push({
    label: `Lawyer: ${lawyers.find(l => String(l.id) === lawyerF)?.fullName ?? lawyerF}`,
    clear: () => setLawyerF("all"),
  });
  if (partnerF !== "all") chips.push({
    label: `Partner: ${partners.find(p => String(p.id) === partnerF)?.fullName ?? partnerF}`,
    clear: () => setPartnerF("all"),
  });
  if (feeTypeF !== "all")     chips.push({ label: `Fee: ${feeTypeF}`,        clear: () => setFeeTypeF("all") });
  if (statusF !== "all")      chips.push({ label: `Status: ${statusF}`,      clear: () => setStatusF("all") });
  if (billingTypeF !== "all") chips.push({ label: `Billing: ${billingTypeF}`, clear: () => setBillingTypeF("all") });
  if (searchQ)                chips.push({ label: `Search: "${searchQ}"`,    clear: () => { setSearchQ(""); setSearchInput(""); } });
  if (noMatterF === "exclude")   chips.push({ label: "Excl. no-matter records", clear: () => setNoMatterF("include") });
  if (unassignedF === "exclude") chips.push({ label: "Excl. unassigned lawyer", clear: () => setUnassignedF("include") });

  const onFilterChanged = (setter: (v: string) => void) => (v: string) => { setter(v); setPage("1"); };

  // ── Shared table pieces ────────────────────────────────────────────────────
  const MoneyCell = ({ v }: { v: string | null | undefined }) => (
    <TableCell className="text-right whitespace-nowrap">{sar(v)}</TableCell>
  );

  const QueryState = ({ q, children }: { q: { isLoading: boolean; isError: boolean; error?: any }; children: React.ReactNode }) => {
    if (q.isLoading) return (
      <div className="flex items-center justify-center py-10 text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading report…
      </div>
    );
    if (q.isError) return (
      <div className="flex items-center justify-center py-10 text-red-600 gap-2">
        <AlertTriangle className="h-5 w-5" /> Failed to load report{q.error?.message ? `: ${q.error.message}` : ""}.
      </div>
    );
    return <>{children}</>;
  };

  const Empty = ({ what = "records" }: { what?: string }) => (
    <div className="text-center py-10 text-muted-foreground">No {what} match the current filters.</div>
  );

  // Group-money columns shared by the lawyer/partner/client/matter tables.
  const groupMoneyHeaders = (
    <>
      <TableHead className="text-right">Agreed Fees</TableHead>
      <TableHead className="text-right">Discount</TableHead>
      <TableHead className="text-right">Net Fees</TableHead>
      <TableHead className="text-right">Revenue</TableHead>
      <TableHead className="text-right">Collected</TableHead>
      <TableHead className="text-right">Outstanding</TableHead>
      <TableHead className="text-right">To Be Billed</TableHead>
    </>
  );
  const groupMoneyCells = (r: any) => (
    <>
      <MoneyCell v={r.agreedFees} /><MoneyCell v={r.discount} /><MoneyCell v={r.netFees} />
      <MoneyCell v={r.revenue} /><MoneyCell v={r.collected} /><MoneyCell v={r.outstanding} />
      <MoneyCell v={r.toBeBilled} />
    </>
  );
  const groupTotalsRow = (rows: any[], labelCols: number) => (
    <TableRow className="font-semibold bg-muted/50">
      <TableCell colSpan={labelCols}>Total ({rows.length} groups)</TableCell>
      {["agreedFees", "discount", "netFees", "revenue", "collected", "outstanding", "toBeBilled"].map(k => (
        <TableCell key={k} className="text-right whitespace-nowrap">
          {sarFromCents(sumCents(rows.map(r => r[k])))}
        </TableCell>
      ))}
    </TableRow>
  );

  const detailRows = detailsQ.data?.rows ?? [];
  const totalRows = detailsQ.data?.totalRows ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / 25));

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <BarChart3 className="h-6 w-6" /> Financial Reporting
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Attributed Revenue reports — every figure is calculated from the currently filtered
              financial records. Amounts in SAR.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { summaryQ.refetch(); detailsQ.refetch(); }}>
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh
            </Button>
            {TAB_EXPORT[tab] && (
              <Button variant="outline" size="sm" disabled={exportMut.isPending}
                onClick={() => exportCsv(TAB_EXPORT[tab]!)}>
                <Download className="h-4 w-4 mr-1" /> Export report CSV
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={exportMut.isPending}
              onClick={() => exportCsv("details")}>
              <Download className="h-4 w-4 mr-1" /> Export details CSV
            </Button>
          </div>
        </div>

        {/* ── Filter bar ─────────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="pt-6 space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Date From</label>
                <Input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage("1"); }} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Date To</label>
                <Input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage("1"); }} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Client</label>
                <Select value={clientF} onValueChange={onFilterChanged(setClientF)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All clients</SelectItem>
                    {clients.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.clientName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Matter</label>
                <Select value={matterF} onValueChange={onFilterChanged(setMatterF)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All matters</SelectItem>
                    <SelectItem value="none">Client-level (no matter)</SelectItem>
                    {matters.map(m => (
                      <SelectItem key={m.id} value={String(m.id)}>
                        {m.matterReference ?? m.originalSerial ?? `Matter #${m.id}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Lawyer (Responsible)</label>
                <Select value={lawyerF} onValueChange={onFilterChanged(setLawyerF)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All lawyers</SelectItem>
                    {lawyers.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.fullName ?? l.email}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Lead Partner</label>
                <Select value={partnerF} onValueChange={onFilterChanged(setPartnerF)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All partners</SelectItem>
                    {partners.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.fullName ?? p.email}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Fee Type</label>
                <Select value={feeTypeF} onValueChange={onFilterChanged(setFeeTypeF)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All fee types</SelectItem>
                    {FEE_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Invoice Status</label>
                <Select value={statusF} onValueChange={onFilterChanged(setStatusF)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {INVOICE_STATUSES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Billing Type (Matter)</label>
                <Select value={billingTypeF} onValueChange={onFilterChanged(setBillingTypeF)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All billing types</SelectItem>
                    {FEE_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">No-Matter Records</label>
                <Select value={noMatterF} onValueChange={onFilterChanged(setNoMatterF)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="include">Include</SelectItem>
                    <SelectItem value="exclude">Exclude</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Unassigned Lawyer</label>
                <Select value={unassignedF} onValueChange={onFilterChanged(setUnassignedF)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="include">Include</SelectItem>
                    <SelectItem value="exclude">Exclude</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Search</label>
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input className="pl-8" placeholder="Client / matter ref / invoice #"
                    value={searchInput} onChange={e => setSearchInput(e.target.value)} />
                </div>
              </div>
            </div>

            {(chips.length > 0) && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {chips.map((c, i) => (
                  <Badge key={i} variant="secondary" className="gap-1">
                    {c.label}
                    <button onClick={() => { c.clear(); setPage("1"); }} aria-label={`Clear ${c.label}`}>
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
                <Button variant="ghost" size="sm" onClick={resetFilters}>Reset Filters</Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── KPI cards (always reflect the current filters) ─────────────────── */}
        <QueryState q={summaryQ}>
          {summary && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              {[
                ["Total Agreed Fees", sar(summary.totalAgreedFees)],
                ["Total Discount", sar(summary.totalDiscount)],
                ["Total Net Fees", sar(summary.totalNetFees)],
                ["Total Revenue", sar(summary.totalRevenue)],
                ["Total Collected", sar(summary.totalCollected)],
                ["Total Outstanding", sar(summary.totalOutstanding)],
                ["Total To Be Billed", sar(summary.totalToBeBilled)],
                [`Overdue Amount (>${summary.overdueDays}d)`, sar(summary.overdueAmount)],
                ["Financial Records", String(summary.recordCount)],
                ["Overdue Invoices", String(summary.overdueInvoiceCount)],
              ].map(([label, value]) => (
                <Card key={label}>
                  <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle></CardHeader>
                  <CardContent><div className="text-lg font-bold whitespace-nowrap">{value}</div></CardContent>
                </Card>
              ))}
            </div>
          )}
        </QueryState>

        {/* ── Report tabs ────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-1 border-b">
          {TABS.map(t => (
            <button key={t.key}
              className={`px-3 py-2 text-sm rounded-t-md border-b-2 -mb-px transition-colors ${
                tab === t.key ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Grouped report ─────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="pt-6 overflow-x-auto">
            {tab === "overview" && (
              <QueryState q={statusQ}>
                <p className="text-sm text-muted-foreground mb-3">
                  Snapshot by invoice status (existing <code>collection_status</code> values). Pick a tab
                  above for lawyer / partner / client / matter breakdowns. No separate invoice entity
                  exists yet — “Invoice Amount” is the record's Revenue (amount invoiced to date).
                </p>
                {statusQ.data?.length === 0 ? <Empty /> : statusQ.data && (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Invoice Status</TableHead><TableHead className="text-right">Records</TableHead>
                      <TableHead className="text-right">Net Fees</TableHead><TableHead className="text-right">Invoice Amount (Revenue)</TableHead>
                      <TableHead className="text-right">Collected</TableHead><TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="text-right">To Be Billed</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {statusQ.data.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.invoiceStatus ?? "—"}</TableCell>
                          <TableCell className="text-right">{r.recordCount}</TableCell>
                          <MoneyCell v={r.netFees} /><MoneyCell v={r.invoiceAmount} />
                          <MoneyCell v={r.collected} /><MoneyCell v={r.outstanding} /><MoneyCell v={r.toBeBilled} />
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </QueryState>
            )}

            {tab === "lawyer" && (
              <QueryState q={byLawyerQ}>
                <p className="text-sm text-muted-foreground mb-3">
                  Attributed Revenue — 100% of each financial record is attributed to its Responsible
                  Lawyer. Each record is counted exactly once in this report.
                </p>
                {byLawyerQ.data?.length === 0 ? <Empty /> : byLawyerQ.data && (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Lawyer</TableHead>
                      <TableHead className="text-right">Clients</TableHead>
                      <TableHead className="text-right">Matters</TableHead>
                      <TableHead className="text-right">Records</TableHead>
                      {groupMoneyHeaders}
                      <TableHead className="text-right">Collection Rate</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {byLawyerQ.data.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.lawyerName}{r.lawyerId == null && r.lawyerName !== "Unassigned" ? " (legacy name)" : ""}</TableCell>
                          <TableCell className="text-right">{r.clientCount}</TableCell>
                          <TableCell className="text-right">{r.matterCount}</TableCell>
                          <TableCell className="text-right">{r.recordCount}</TableCell>
                          {groupMoneyCells(r)}
                          <TableCell className="text-right">{pct(r.collectionRate)}</TableCell>
                        </TableRow>
                      ))}
                      {groupTotalsRow(byLawyerQ.data, 4)}
                    </TableBody>
                  </Table>
                )}
              </QueryState>
            )}

            {tab === "partner" && (
              <QueryState q={byPartnerQ}>
                <p className="text-sm text-muted-foreground mb-3">
                  Attributed Revenue — 100% of each financial record is attributed to the Lead Partner
                  of its Matter (linked user). This is a separate reporting dimension, not a revenue share.
                </p>
                {byPartnerQ.data?.length === 0 ? <Empty /> : byPartnerQ.data && (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Lead Partner</TableHead>
                      <TableHead className="text-right">Clients</TableHead>
                      <TableHead className="text-right">Matters</TableHead>
                      <TableHead className="text-right">Records</TableHead>
                      {groupMoneyHeaders}
                      <TableHead className="text-right">Collection Rate</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {byPartnerQ.data.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.leadPartnerName}{r.leadPartnerId == null && r.leadPartnerName !== "Unassigned" ? " (legacy name)" : ""}</TableCell>
                          <TableCell className="text-right">{r.clientCount}</TableCell>
                          <TableCell className="text-right">{r.matterCount}</TableCell>
                          <TableCell className="text-right">{r.recordCount}</TableCell>
                          {groupMoneyCells(r)}
                          <TableCell className="text-right">{pct(r.collectionRate)}</TableCell>
                        </TableRow>
                      ))}
                      {groupTotalsRow(byPartnerQ.data, 4)}
                    </TableBody>
                  </Table>
                )}
              </QueryState>
            )}

            {tab === "hop" && (
              <QueryState q={byHopQ}>
                {byHopQ.data && (byHopQ.data.configured === false ? (
                  <div className="text-center py-10 space-y-2">
                    <AlertTriangle className="h-8 w-8 mx-auto text-amber-500" />
                    <p className="font-semibold">Data relationship not configured</p>
                    <p className="text-sm text-muted-foreground max-w-2xl mx-auto">
                      {byHopQ.data.reason}
                    </p>
                  </div>
                ) : byHopQ.data.rows.length === 0 ? <Empty /> : (
                  <>
                    <p className="text-xs text-muted-foreground mb-2 max-w-3xl">
                      Attributed Revenue — each financial record is attributed to the responsible Head of
                      Practice of its (location + matter type). Records with no classified practice roll up
                      under "Unassigned / Unclassified".
                    </p>
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Head of Practice</TableHead>
                        <TableHead className="text-right">Clients</TableHead>
                        <TableHead className="text-right">Matters</TableHead>
                        <TableHead className="text-right">Records</TableHead>
                        {groupMoneyHeaders}
                        <TableHead className="text-right">Collection Rate</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {byHopQ.data.rows.map((r: any, i: number) => (
                          <TableRow key={i}>
                            <TableCell>{r.headOfPracticeName}</TableCell>
                            <TableCell className="text-right">{r.clientCount}</TableCell>
                            <TableCell className="text-right">{r.matterCount}</TableCell>
                            <TableCell className="text-right">{r.recordCount}</TableCell>
                            {groupMoneyCells(r)}
                            <TableCell className="text-right">{pct(r.collectionRate)}</TableCell>
                          </TableRow>
                        ))}
                        {groupTotalsRow(byHopQ.data.rows, 4)}
                      </TableBody>
                    </Table>
                  </>
                ))}
              </QueryState>
            )}

            {tab === "client" && (
              <QueryState q={byClientQ}>
                {byClientQ.data?.length === 0 ? <Empty /> : byClientQ.data && (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Client #</TableHead><TableHead>Client Name</TableHead>
                      <TableHead className="text-right">Matters</TableHead>
                      <TableHead className="text-right">Records</TableHead>
                      {groupMoneyHeaders}
                    </TableRow></TableHeader>
                    <TableBody>
                      {byClientQ.data.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.clientNumber ?? "—"}</TableCell>
                          <TableCell>{r.clientName}</TableCell>
                          <TableCell className="text-right">{r.matterCount}</TableCell>
                          <TableCell className="text-right">{r.recordCount}</TableCell>
                          {groupMoneyCells(r)}
                        </TableRow>
                      ))}
                      {groupTotalsRow(byClientQ.data, 4)}
                    </TableBody>
                  </Table>
                )}
              </QueryState>
            )}

            {tab === "matter" && (
              <QueryState q={byMatterQ}>
                <p className="text-sm text-muted-foreground mb-3">
                  Client-level financial records (no matter) are grouped separately per client and
                  labelled “Client-level / No Matter”.
                </p>
                {byMatterQ.data?.length === 0 ? <Empty /> : byMatterQ.data && (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Matter Reference</TableHead><TableHead>Client</TableHead>
                      <TableHead>Responsible Lawyer(s)</TableHead><TableHead>Lead Partner</TableHead>
                      <TableHead>Billing Type</TableHead>
                      <TableHead className="text-right">Records</TableHead>
                      {groupMoneyHeaders}
                    </TableRow></TableHeader>
                    <TableBody>
                      {byMatterQ.data.map((r, i) => (
                        <TableRow key={i} className={r.isClientLevel ? "bg-amber-50/50" : undefined}>
                          <TableCell>
                            {r.isClientLevel
                              ? <Badge variant="outline">Client-level / No Matter</Badge>
                              : (r.matterReference ?? `Matter #${r.clientMatterId}`)}
                          </TableCell>
                          <TableCell>{r.clientName}</TableCell>
                          <TableCell>{r.responsibleLawyers ?? "—"}</TableCell>
                          <TableCell>{r.leadPartnerName ?? "—"}</TableCell>
                          <TableCell>{r.billingType ?? "—"}</TableCell>
                          <TableCell className="text-right">{r.recordCount}</TableCell>
                          {groupMoneyCells(r)}
                        </TableRow>
                      ))}
                      {groupTotalsRow(byMatterQ.data, 6)}
                    </TableBody>
                  </Table>
                )}
              </QueryState>
            )}

            {tab === "outstanding" && (
              <QueryState q={outstandingQ}>
                <p className="text-sm text-muted-foreground mb-3">
                  Records with Outstanding &gt; 0, grouped by Responsible Lawyer. “Due Date” is derived:
                  billing date + configured overdue threshold (no due-date field exists).
                </p>
                {outstandingQ.data?.length === 0 ? <Empty what="outstanding records" /> : outstandingQ.data && (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Lawyer</TableHead>
                      <TableHead className="text-right">Open Records</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead>Oldest Due Date</TableHead>
                      <TableHead className="text-right">Overdue Outstanding</TableHead>
                      <TableHead className="text-right">Not-Yet-Due Outstanding</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {outstandingQ.data.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.lawyerName}</TableCell>
                          <TableCell className="text-right">{r.openRecordCount}</TableCell>
                          <MoneyCell v={r.revenue} /><MoneyCell v={r.collected} /><MoneyCell v={r.outstanding} />
                          <TableCell>{r.oldestDueDate ?? "—"}</TableCell>
                          <MoneyCell v={r.overdueOutstanding} /><MoneyCell v={r.notYetDueOutstanding} />
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </QueryState>
            )}

            {tab === "tbb" && (
              <QueryState q={tbbQ}>
                <p className="text-sm text-muted-foreground mb-3">
                  Records with To Be Billed &gt; 0 (approved formula: max(0, Net Fees − Revenue)).
                  “Already Billed” is the record's Revenue.
                </p>
                {tbbQ.data?.length === 0 ? <Empty what="unbilled records" /> : tbbQ.data && (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Lawyer</TableHead>
                      <TableHead className="text-right">Records</TableHead>
                      <TableHead className="text-right">Agreed Fees</TableHead>
                      <TableHead className="text-right">Already Billed</TableHead>
                      <TableHead className="text-right">To Be Billed</TableHead>
                      <TableHead>Oldest Unbilled Record Date</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {tbbQ.data.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.lawyerName}</TableCell>
                          <TableCell className="text-right">{r.recordCount}</TableCell>
                          <MoneyCell v={r.agreedFees} /><MoneyCell v={r.alreadyBilled} /><MoneyCell v={r.toBeBilled} />
                          <TableCell>{r.oldestUnbilledRecordDate ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </QueryState>
            )}

            {tab === "collected" && (
              <QueryState q={collectedQ}>
                <p className="text-sm text-muted-foreground mb-3">
                  Collection buckets are amount-based (Collected vs Revenue); the manual Invoice Status
                  field is not used for these counts.
                </p>
                {collectedQ.data?.length === 0 ? <Empty /> : collectedQ.data && (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Lawyer</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="text-right">Collection Rate</TableHead>
                      <TableHead className="text-right">Fully Collected</TableHead>
                      <TableHead className="text-right">Partially Collected</TableHead>
                      <TableHead className="text-right">Uncollected</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {collectedQ.data.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.lawyerName}</TableCell>
                          <MoneyCell v={r.revenue} /><MoneyCell v={r.collected} /><MoneyCell v={r.outstanding} />
                          <TableCell className="text-right">{pct(r.collectionRate)}</TableCell>
                          <TableCell className="text-right">{r.fullyCollectedCount}</TableCell>
                          <TableCell className="text-right">{r.partiallyCollectedCount}</TableCell>
                          <TableCell className="text-right">{r.uncollectedCount}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </QueryState>
            )}

            {tab === "discounts" && (
              <QueryState q={discountQ}>
                {discountQ.data && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {[
                        ["Total Discounts", sar(discountQ.data.summary.totalDiscounts)],
                        ["Average Discount %", discountQ.data.summary.avgDiscountPercentage != null ? `${discountQ.data.summary.avgDiscountPercentage}%` : "—"],
                        ["Discounted Records", String(discountQ.data.summary.discountedRecordCount)],
                        ["Largest Discount", sar(discountQ.data.summary.largestDiscount)],
                      ].map(([label, value]) => (
                        <Card key={label}>
                          <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle></CardHeader>
                          <CardContent><div className="text-lg font-bold">{value}</div></CardContent>
                        </Card>
                      ))}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Discount Type is the approval level (drives the approved % table). The schema has no
                      free-text discount reason; per-field change history is in each record's audit trail.
                    </p>
                    {discountQ.data.rows.length === 0 ? <Empty what="discounted records" /> : (
                      <Table>
                        <TableHeader><TableRow>
                          <TableHead>Client</TableHead><TableHead>Matter</TableHead>
                          <TableHead>Responsible Lawyer</TableHead><TableHead>Lead Partner</TableHead>
                          <TableHead className="text-right">Agreed Fees</TableHead>
                          <TableHead>Discount Type</TableHead>
                          <TableHead className="text-right">Discount %</TableHead>
                          <TableHead className="text-right">Discount Amount</TableHead>
                          <TableHead className="text-right">Net Fees</TableHead>
                          <TableHead>Created By</TableHead><TableHead>Last Updated</TableHead>
                        </TableRow></TableHeader>
                        <TableBody>
                          {discountQ.data.rows.map((r: any, i: number) => (
                            <TableRow key={i}>
                              <TableCell>{r.clientName}</TableCell>
                              <TableCell>{r.matterReference ?? "—"}</TableCell>
                              <TableCell>{r.responsibleLawyerName ?? "—"}</TableCell>
                              <TableCell>{r.leadPartnerName ?? "—"}</TableCell>
                              <MoneyCell v={r.agreedFees} />
                              <TableCell>{r.discountType ?? "—"}</TableCell>
                              <TableCell className="text-right">{r.discountPercentage}%</TableCell>
                              <MoneyCell v={r.discountAmount} />
                              <MoneyCell v={r.netFees} />
                              <TableCell>{r.createdByName ?? "—"}</TableCell>
                              <TableCell className="whitespace-nowrap">{r.lastUpdated ? new Date(r.lastUpdated).toLocaleDateString() : "—"}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                )}
              </QueryState>
            )}

            {tab === "status" && (
              <QueryState q={statusQ}>
                <p className="text-sm text-muted-foreground mb-3">
                  Uses the existing project statuses (<code>collection_status</code>). Invoices are not a
                  separate entity yet — this reports from the financial records' invoice fields.
                </p>
                {statusQ.data?.length === 0 ? <Empty /> : statusQ.data && (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Invoice Status</TableHead><TableHead className="text-right">Records</TableHead>
                      <TableHead className="text-right">Net Fees</TableHead>
                      <TableHead className="text-right">Invoice Amount (Revenue)</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="text-right">To Be Billed</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {statusQ.data.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.invoiceStatus ?? "—"}</TableCell>
                          <TableCell className="text-right">{r.recordCount}</TableCell>
                          <MoneyCell v={r.netFees} /><MoneyCell v={r.invoiceAmount} />
                          <MoneyCell v={r.collected} /><MoneyCell v={r.outstanding} /><MoneyCell v={r.toBeBilled} />
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </QueryState>
            )}

            {tab === "overdue" && (
              <QueryState q={overdueQ}>
                {overdueQ.data && (
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Overdue = due date passed (billing date + {overdueQ.data.overdueDays} days —
                      no due-date field exists), outstanding &gt; 0, and status not Fully Collected.
                    </p>
                    <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                      {(["1-30", "31-60", "61-90", "91-180", "180+"] as const).map(b => (
                        <Card key={b}>
                          <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-muted-foreground">{b} days</CardTitle></CardHeader>
                          <CardContent><div className="text-sm font-bold whitespace-nowrap">{sar(overdueQ.data.aging[b])}</div></CardContent>
                        </Card>
                      ))}
                      <Card>
                        <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-muted-foreground">Total ({overdueQ.data.aging.count})</CardTitle></CardHeader>
                        <CardContent><div className="text-sm font-bold whitespace-nowrap">{sar(overdueQ.data.aging.total)}</div></CardContent>
                      </Card>
                    </div>
                    {overdueQ.data.rows.length === 0 ? <Empty what="overdue invoices" /> : (
                      <Table>
                        <TableHeader><TableRow>
                          <TableHead>Invoice #</TableHead><TableHead>Client</TableHead><TableHead>Matter</TableHead>
                          <TableHead>Responsible Lawyer</TableHead><TableHead>Lead Partner</TableHead>
                          <TableHead>Invoice Date</TableHead><TableHead>Due Date</TableHead>
                          <TableHead className="text-right">Days Overdue</TableHead>
                          <TableHead className="text-right">Invoice Amount</TableHead>
                          <TableHead className="text-right">Collected</TableHead>
                          <TableHead className="text-right">Outstanding</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow></TableHeader>
                        <TableBody>
                          {overdueQ.data.rows.map((r: any, i: number) => (
                            <TableRow key={i}>
                              <TableCell>{r.invoiceNumber ?? "—"}</TableCell>
                              <TableCell>{r.clientName}</TableCell>
                              <TableCell>{r.matterReference ?? "—"}</TableCell>
                              <TableCell>{r.responsibleLawyerName ?? "—"}</TableCell>
                              <TableCell>{r.leadPartnerName ?? "—"}</TableCell>
                              <TableCell>{r.invoiceDate ?? "—"}</TableCell>
                              <TableCell>{r.dueDate}</TableCell>
                              <TableCell className="text-right">{r.daysOverdue}</TableCell>
                              <MoneyCell v={r.invoiceAmount} /><MoneyCell v={r.collected} /><MoneyCell v={r.outstanding} />
                              <TableCell><Badge variant="outline">{r.status ?? "—"}</Badge></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                )}
              </QueryState>
            )}
          </CardContent>
        </Card>

        {/* ── Detailed records (server-side pagination) ──────────────────────── */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4" /> Detailed Financial Records
              <span className="text-sm font-normal text-muted-foreground">
                ({totalRows} record{totalRows === 1 ? "" : "s"} · reporting date = billing date, else created date)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <QueryState q={detailsQ}>
              {detailRows.length === 0 ? <Empty /> : (
                <>
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Client</TableHead><TableHead>Matter</TableHead>
                      <TableHead>Responsible Lawyer</TableHead><TableHead>Lead Partner</TableHead>
                      <TableHead>Fee Type</TableHead><TableHead>Status</TableHead>
                      <TableHead className="text-right">Agreed</TableHead>
                      <TableHead className="text-right">Discount</TableHead>
                      <TableHead className="text-right">Net Fees</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="text-right">To Be Billed</TableHead>
                      <TableHead>Reporting Date</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {detailRows.map((r: any) => (
                        <TableRow key={r.financialRecordId} className={r.isOverdue ? "bg-red-50/50" : undefined}>
                          <TableCell>{r.clientName}</TableCell>
                          <TableCell>{r.matterReference ?? (r.clientMatterId ? `Matter #${r.clientMatterId}` : "Client-level")}</TableCell>
                          <TableCell>{r.responsibleLawyerName ?? "—"}</TableCell>
                          <TableCell>{r.leadPartnerName ?? "—"}</TableCell>
                          <TableCell>{r.feeType ?? "—"}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{r.invoiceStatus ?? "—"}</Badge>
                            {r.isOverdue && <Badge variant="destructive" className="ml-1">Overdue</Badge>}
                          </TableCell>
                          <MoneyCell v={r.agreedFees} /><MoneyCell v={r.discountAmount} />
                          <MoneyCell v={r.netFees} /><MoneyCell v={r.revenue} />
                          <MoneyCell v={r.collected} /><MoneyCell v={r.outstanding} />
                          <MoneyCell v={r.toBeBilled} />
                          <TableCell className="whitespace-nowrap">{r.effectiveDate}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <div className="flex items-center justify-between pt-3">
                    <span className="text-sm text-muted-foreground">
                      Page {page} of {totalPages} · {totalRows} records (totals above are computed over ALL
                      filtered records, not just this page)
                    </span>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" disabled={page <= 1}
                        onClick={() => setPage(String(page - 1))}>Previous</Button>
                      <Button variant="outline" size="sm" disabled={page >= totalPages}
                        onClick={() => setPage(String(page + 1))}>Next</Button>
                    </div>
                  </div>
                </>
              )}
            </QueryState>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
