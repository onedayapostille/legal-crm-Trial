import { useLocation } from "wouter";
import { Search, Plus, FileText } from "lucide-react";
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
import { useQueryParam } from "@/hooks/useQueryParam";
import { useAuth } from "@/_core/hooks/useAuth";
import { CHANNEL_TYPES } from "@shared/const";
import { userCan } from "@/lib/permissions";

const LEAD_STATUSES = ["New", "Contacted", "Meeting Scheduled", "Proposal Sent", "Converted", "Lost", "On Hold"];

/**
 * Enquiries Log — filterable list of intake enquiries (legacy leads table) with
 * marketing-source (channel) reporting. Reached at /enquiries/log.
 */
export default function EnquiriesLog() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  // leads:view (e.g. Manager) can read the log; creating/editing needs leads:manage.
  const canCreateLeads = userCan(user, "leads:create");
  const [search, setSearch] = useQueryParam("search", "");
  const [channelType, setChannelType] = useQueryParam("channelType", "all");
  const [channelMedium, setChannelMedium] = useQueryParam("channelMedium", "all");
  const [status, setStatus] = useQueryParam("status", "all");
  const [assignedTo, setAssignedTo] = useQueryParam("assignedTo", "all");

  const { data: leads = [], isLoading } = trpc.leads.list.useQuery({
    channelType: channelType !== "all" ? channelType : undefined,
    channelMedium: channelMedium !== "all" ? channelMedium : undefined,
    status: status !== "all" ? status : undefined,
    search: search.trim() || undefined,
    assignedTo: assignedTo !== "all" ? Number(assignedTo) : undefined,
  });
  const { data: channelOptions } = trpc.leads.channelOptions.useQuery();
  const { data: leadLawyers = [] } = trpc.users.leadLawyers.useQuery();

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Enquiries Log</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Intake enquiries by communication channel — for marketing-source reporting.
            </p>
          </div>
          {canCreateLeads && (
            <Button size="sm" onClick={() => navigate("/enquiries/new")}>
              <Plus className="h-4 w-4 mr-1" /> New Enquiry
            </Button>
          )}
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search name, lead code, email…" value={search}
                  onChange={e => setSearch(e.target.value)} className="pl-9" />
              </div>
              <Select value={channelType} onValueChange={v => { setChannelType(v); setChannelMedium("all"); }}>
                <SelectTrigger className="w-44"><SelectValue placeholder="Channel Type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Channel Types</SelectItem>
                  {CHANNEL_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={channelMedium} onValueChange={setChannelMedium}>
                <SelectTrigger className="w-44"><SelectValue placeholder="Channel Medium" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Mediums</SelectItem>
                  {(channelOptions?.mediums ?? []).map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {LEAD_STATUSES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={assignedTo} onValueChange={setAssignedTo}>
                <SelectTrigger className="w-44"><SelectValue placeholder="Assigned To" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Assignees</SelectItem>
                  {leadLawyers.map(l => (
                    <SelectItem key={l.id} value={String(l.id)}>{l.name ?? `User #${l.id}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" />
              {leads.length} enquir{leads.length !== 1 ? "ies" : "y"}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading…</div>
            ) : leads.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">No enquiries match these filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Lead Code</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Client Name</TableHead>
                      <TableHead>Channel Type</TableHead>
                      <TableHead>Channel Medium</TableHead>
                      <TableHead>Assigned To</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {leads.map((l: any) => (
                      <TableRow key={l.id} className="cursor-pointer hover:bg-accent/50"
                        onClick={() => navigate(`/enquiries/${l.id}`)}>
                        <TableCell className="font-mono text-sm">{l.leadCode}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {l.enquiryAt ? new Date(l.enquiryAt).toLocaleString() : new Date(l.dateOfEnquiry).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="font-semibold">{l.clientName}</TableCell>
                        <TableCell>{l.channelType ? <Badge variant="outline">{l.channelType}</Badge> : "—"}</TableCell>
                        <TableCell className="text-sm">{l.channelMedium ?? "—"}</TableCell>
                        <TableCell className="text-sm">{l.assignedToName ?? "—"}</TableCell>
                        <TableCell><Badge variant="outline">{l.currentStatus ?? "New"}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
