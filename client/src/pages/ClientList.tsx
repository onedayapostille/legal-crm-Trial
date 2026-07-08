import { useState } from "react";
import { useLocation } from "wouter";
import {
  Users, Plus, Search, Filter, Building2, FileText, RefreshCw, ShieldCheck,
  Download, Calendar, UserCog,
} from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { hasPermission, CHANNEL_TYPES } from "@shared/const";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import DashboardLayout from "@/components/DashboardLayout";
import ConflictCheckDialog from "@/components/ConflictCheckDialog";
import { useQueryParam } from "@/hooks/useQueryParam";

const STATUS_COLORS: Record<string, string> = {
  "Existing Client": "bg-green-100 text-green-800 border-green-200",
  Leads: "bg-blue-100 text-blue-800 border-blue-200",
  Rejected: "bg-red-100 text-red-800 border-red-200",
};

export default function ClientList({ statusFilter }: { statusFilter?: string }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const canManage = hasPermission(user?.role, "clients:manage");

  // Filters live in the URL so they survive List → Detail → Back navigation.
  const [search, setSearch] = useQueryParam("search", "");
  const [city, setCity] = useQueryParam("city", "all");
  const [matterType, setMatterType] = useQueryParam("matterType", "all");
  const [status, setStatus] = useQueryParam("status", statusFilter ?? "all");
  // Unified intake filters (Enquiry Log controls)
  const [source, setSource] = useQueryParam("source", "all");      // origin: Lead/Enquiry/Direct
  const [assignedLawyer, setAssignedLawyer] = useQueryParam("lawyer", "all");
  const [dateFrom, setDateFrom] = useQueryParam("from", "");
  const [dateTo, setDateTo] = useQueryParam("to", "");
  const [channelType, setChannelType] = useQueryParam("channelType", "all");
  const [channelMedium, setChannelMedium] = useQueryParam("channelMedium", "");
  const [conflictCheckOpen, setConflictCheckOpen] = useState(false);

  const { data: clients = [], isLoading, refetch } = trpc.clients.list.useQuery({
    clientStatus: status !== "all" ? status : undefined,
    city: city !== "all" ? city : undefined,
    matterType: matterType !== "all" ? matterType : undefined,
    search: search.trim() || undefined,
    convertedFrom: source !== "all" ? (source as any) : undefined,
    assignedLawyerId: assignedLawyer !== "all" ? Number(assignedLawyer) : undefined,
    createdFrom: dateFrom || undefined,
    createdTo: dateTo || undefined,
    channelType: channelType !== "all" ? channelType : undefined,
    channelMedium: channelMedium.trim() || undefined,
  });

  const { data: stats } = trpc.clients.statusCounts.useQuery();
  const { data: lawyers = [] } = trpc.users.assignableLawyers.useQuery();

  // Inline status/action update (Enquiry Log "action" control).
  const updateStatus = trpc.clients.update.useMutation({
    onSuccess: () => {
      toast.success("Status updated");
      utils.dashboard.stats.invalidate();
      utils.clients.list.invalidate();
      utils.clients.statusCounts.invalidate();
      utils.clients.recentLeads.invalidate();
      utils.clients.dashboardStats.invalidate();
      utils.clients.conversionMetrics.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleRowClick = (id: number) => navigate(`/clients/${id}`);

  function handleExport() {
    const rows = clients.map(c => ({
      "Client #":        c.clientNumber ?? "",
      "File #":          c.fileNumber ?? "",
      "Client Name":     c.clientName,
      "Status":          c.clientStatus,
      "Source":          (c as any).convertedFrom ?? "",
      "Channel Type":    (c as any).channelType ?? "",
      "Channel Medium":  (c as any).channelMedium ?? "",
      "City":            c.city ?? "",
      "Matter Type":     c.matterType ?? "",
      "Assigned Lawyer": (c as any).assignedLawyerName ?? "",
      "Created":         new Date(c.createdAt).toLocaleDateString(),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Intake");
    const today = new Date().toISOString().split("T")[0];
    XLSX.writeFile(wb, `intake_export_${today}.xlsx`);
  }

  const pageTitle = statusFilter
    ? statusFilter === "Existing Client"
      ? "Existing Clients"
      : statusFilter === "Leads"
      ? "Leads Pipeline"
      : "Rejected Clients"
    : "All Clients";

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{pageTitle}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              AlGhazzawi & Partners Client Registry
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={clients.length === 0}>
              <Download className="h-4 w-4 mr-1" />
              Export
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConflictCheckOpen(true)}>
              <ShieldCheck className="h-4 w-4 mr-1" />
              Conflict Check
            </Button>
            <Button size="sm" onClick={() => navigate("/clients/new")}>
              <Plus className="h-4 w-4 mr-1" />
              Add Client
            </Button>
          </div>
        </div>

        {/* Status summary cards — only on the "All Clients" view */}
        {!statusFilter && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SummaryCard
              label="Total Clients"
              value={stats?.total ?? 0}
              color="bg-slate-600"
              onClick={() => setStatus("all")}
              active={status === "all"}
            />
            <SummaryCard
              label="Existing Clients"
              value={stats?.existing ?? 0}
              color="bg-green-600"
              onClick={() => setStatus("Existing Client")}
              active={status === "Existing Client"}
            />
            <SummaryCard
              label="Leads"
              value={stats?.leads ?? 0}
              color="bg-blue-600"
              onClick={() => setStatus("Leads")}
              active={status === "Leads"}
            />
            <SummaryCard
              label="Rejected"
              value={stats?.rejected ?? 0}
              color="bg-red-600"
              onClick={() => setStatus("Rejected")}
              active={status === "Rejected"}
            />
          </div>
        )}

        {/* Filters */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name, client #, file #…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              {!statusFilter && (
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="w-44">
                    <Filter className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="Existing Client">Existing Client</SelectItem>
                    <SelectItem value="Leads">Leads</SelectItem>
                    <SelectItem value="Rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <Select value={city} onValueChange={setCity}>
                <SelectTrigger className="w-36">
                  <Building2 className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="City" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Cities</SelectItem>
                  <SelectItem value="Riyadh">Riyadh</SelectItem>
                  <SelectItem value="Dammam">Dammam</SelectItem>
                  <SelectItem value="Jeddah">Jeddah</SelectItem>
                </SelectContent>
              </Select>
              <Select value={matterType} onValueChange={setMatterType}>
                <SelectTrigger className="w-36">
                  <FileText className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Matter Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="Corporate">Corporate</SelectItem>
                  <SelectItem value="Litigation">Litigation</SelectItem>
                </SelectContent>
              </Select>
              {/* Source (origin): Enquiry vs Direct lead creation */}
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="Lead">Lead</SelectItem>
                  <SelectItem value="Enquiry">Enquiry</SelectItem>
                  <SelectItem value="Direct">Direct</SelectItem>
                </SelectContent>
              </Select>
              {/* Assigned lawyer */}
              <Select value={assignedLawyer} onValueChange={setAssignedLawyer}>
                <SelectTrigger className="w-44">
                  <UserCog className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Assigned Lawyer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Lawyers</SelectItem>
                  {lawyers.map(l => (
                    <SelectItem key={l.id} value={String(l.id)}>{l.name ?? `User #${l.id}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Date range (created_at) */}
              <div className="flex items-center gap-1">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  className="w-36"
                  aria-label="Created from"
                />
                <span className="text-muted-foreground text-sm">–</span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={e => setDateTo(e.target.value)}
                  className="w-36"
                  aria-label="Created to"
                />
              </div>
              {/* Communication channel */}
              <Select value={channelType} onValueChange={setChannelType}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Channel Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Channels</SelectItem>
                  {CHANNEL_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input
                placeholder="Channel medium…"
                value={channelMedium}
                onChange={e => setChannelMedium(e.target.value)}
                className="w-40"
                aria-label="Channel medium"
              />
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              {clients.length} client{clients.length !== 1 ? "s" : ""} found
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading clients…</div>
            ) : clients.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p className="font-medium">No clients found</p>
                <p className="text-sm mt-1">
                  {search || status !== "all" || city !== "all" || matterType !== "all"
                    ? "Try adjusting your filters."
                    : "Add your first client to get started."}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client #</TableHead>
                    <TableHead>File #</TableHead>
                    <TableHead>Client Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Assigned Lawyer</TableHead>
                    <TableHead>City</TableHead>
                    <TableHead>Matter Type</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clients.map(client => (
                    <TableRow
                      key={client.id}
                      className="cursor-pointer hover:bg-accent/50"
                      onClick={() => handleRowClick(client.id)}
                    >
                      <TableCell className="font-mono text-sm">
                        {client.clientNumber ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {client.fileNumber ?? "—"}
                      </TableCell>
                      <TableCell className="font-semibold">{client.clientName}</TableCell>
                      {/* Status with inline action/update (stop row navigation) */}
                      <TableCell onClick={e => e.stopPropagation()}>
                        {canManage ? (
                          <Select
                            value={client.clientStatus}
                            onValueChange={v => updateStatus.mutate({ id: client.id, clientStatus: v as any })}
                          >
                            <SelectTrigger className="h-7 w-36 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="Existing Client">Existing Client</SelectItem>
                              <SelectItem value="Leads">Leads</SelectItem>
                              <SelectItem value="Rejected">Rejected</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant="outline" className={STATUS_COLORS[client.clientStatus]}>
                            {client.clientStatus}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {(client as any).convertedFrom ?? "—"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {(client as any).assignedLawyerName ?? "—"}
                      </TableCell>
                      <TableCell>{client.city ?? "—"}</TableCell>
                      <TableCell>{client.matterType ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(client.createdAt).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <ConflictCheckDialog
        open={conflictCheckOpen}
        onClose={() => setConflictCheckOpen(false)}
      />
    </DashboardLayout>
  );
}

function SummaryCard({
  label, value, color, onClick, active,
}: {
  label: string;
  value: number;
  color: string;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border p-4 text-left transition-all hover:shadow-md ${
        active ? "ring-2 ring-primary" : ""
      }`}
    >
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
      <div className={`h-1 w-10 rounded mt-3 ${color}`} />
    </button>
  );
}
