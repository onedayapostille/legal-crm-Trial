import { useState } from "react";
import { useLocation } from "wouter";
import {
  Users, Plus, Search, Filter, Building2, FileText, RefreshCw,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
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

const STATUS_COLORS: Record<string, string> = {
  "Existing Client": "bg-green-100 text-green-800 border-green-200",
  Leads: "bg-blue-100 text-blue-800 border-blue-200",
  Rejected: "bg-red-100 text-red-800 border-red-200",
};

export default function ClientList({ statusFilter }: { statusFilter?: string }) {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [city, setCity] = useState("all");
  const [matterType, setMatterType] = useState("all");
  const [status, setStatus] = useState(statusFilter ?? "all");

  const { data: clients = [], isLoading, refetch } = trpc.clients.list.useQuery({
    clientStatus: status !== "all" ? status : undefined,
    city: city !== "all" ? city : undefined,
    matterType: matterType !== "all" ? matterType : undefined,
    search: search.trim() || undefined,
  });

  const { data: stats } = trpc.clients.statusCounts.useQuery();

  const handleRowClick = (id: number) => navigate(`/clients/${id}`);

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
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client #</TableHead>
                    <TableHead>File #</TableHead>
                    <TableHead>Client Name</TableHead>
                    <TableHead>Status</TableHead>
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
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={STATUS_COLORS[client.clientStatus]}
                        >
                          {client.clientStatus}
                        </Badge>
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
            )}
          </CardContent>
        </Card>
      </div>
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
