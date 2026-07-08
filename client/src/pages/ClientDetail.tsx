import { useState, useMemo, useEffect, type Dispatch, type SetStateAction } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft, Save, Trash2, Plus, Edit2, Check, X, ChevronDown, ChevronUp,
  Users, FileText, DollarSign, Calendar, AlertCircle, Clock, Pencil, History, Ban,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DashboardLayout from "@/components/DashboardLayout";
import FinancialDialog from "@/components/FinancialDialog";
import { LawyerRatesDialog } from "@/components/LawyerRatesDialog";
import { FinancialAuditTrail } from "@/components/FinancialAuditTrail";
import ConflictWarningDialog from "@/components/ConflictWarningDialog";
import type { ConflictMatch } from "@/components/ConflictMatchTable";
import { useGoBack } from "@/hooks/useGoBack";
import { useQueryParam } from "@/hooks/useQueryParam";
import { ClientTasksSection, RelatedTasks } from "@/components/ClientTasks";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { hasPermission, CHANNEL_TYPES, DIGITAL_MEDIUMS, channelMediumLabel } from "@shared/const";

const STATUS_COLORS: Record<string, string> = {
  "Existing Client": "bg-green-100 text-green-800 border-green-200",
  Leads: "bg-blue-100 text-blue-800 border-blue-200",
  Rejected: "bg-red-100 text-red-800 border-red-200",
};

export default function ClientDetail({ id }: { id: number }) {
  const [, navigate] = useLocation();
  const goBack = useGoBack("/clients");
  const { user } = useAuth();
  const canManage = hasPermission(user?.role, "clients:manage");
  const canViewFinancial = hasPermission(user?.role, "financial:view");
  const canViewTasks = hasPermission(user?.role, "tasks:manage");
  const utils = trpc.useUtils();

  // Deep-link support: /clients/:id?tab=tasks&taskId=NN opens the Tasks tab and
  // auto-opens that task's details (used when navigating from a task list).
  const [activeTab, setActiveTab] = useQueryParam("tab", "overview");
  const [taskIdParam] = useQueryParam("taskId", "");
  const initialTaskId = taskIdParam ? Number(taskIdParam) : null;

  const { data: client, isLoading } = trpc.clients.get.useQuery({ id });
  const { data: matters = [] } = trpc.clientMatters.list.useQuery({ clientId: id });
  const { data: actions = [] } = trpc.clientActions.list.useQuery({ clientId: id });
  const { data: leadDetail } = trpc.clients.getLeadDetail.useQuery(
    { clientId: id },
    { enabled: client?.clientStatus === "Leads" }
  );
  const { data: rejectedDetail } = trpc.clients.getRejectedDetail.useQuery(
    { clientId: id },
    { enabled: client?.clientStatus === "Rejected" }
  );
  const { data: financialRecords = [] } = trpc.financial.list.useQuery(
    { clientId: id },
    { enabled: canViewFinancial }
  );
  const { data: clientTasks = [] } = trpc.tasks.list.useQuery(
    { clientId: id },
    { enabled: canViewTasks }
  );

  // Rejected clients are locked: read-only, no new matters/financials/actions/edits.
  // The status control itself stays available (gated by canManage) so an admin can
  // reactivate the client.
  const isRejected = client?.clientStatus === "Rejected";
  const canManageActive = canManage && !isRejected;

  // Edit client status inline
  const [editingStatus, setEditingStatus] = useState(false);
  const [newStatus, setNewStatus] = useState<"Existing Client" | "Leads" | "Rejected">("Leads");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [matterDialogOpen, setMatterDialogOpen] = useState(false);
  const [actionDialogOpen, setActionDialogOpen] = useState(false);

  // Original Serial a new matter inherits from this client (client number, then
  // file number, then a stable CL-<id> fallback) — mirrors the server default.
  const inheritedSerial =
    (client?.clientNumber ?? "").trim() || (client?.fileNumber ?? "").trim() || `CL-${id}`;

  const updateClient = trpc.clients.update.useMutation({
    onSuccess: () => {
      toast.success("Client updated");
      utils.clients.get.invalidate({ id });
      utils.dashboard.stats.invalidate();
      utils.clients.statusCounts.invalidate();
      // Keep the Leads Pipeline, Recent Leads widget and client list in sync when
      // a status change moves a client in/out of the Leads pipeline.
      utils.clients.list.invalidate();
      utils.clients.recentLeads.invalidate();
      utils.clients.dashboardStats.invalidate();
      utils.clients.conversionMetrics.invalidate();
      setEditingStatus(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteClient = trpc.clients.delete.useMutation({
    onSuccess: () => {
      toast.success("Client deleted");
      navigate("/clients");
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="p-8 text-center text-muted-foreground">Loading client…</div>
      </DashboardLayout>
    );
  }

  if (!client) {
    return (
      <DashboardLayout>
        <div className="p-8 text-center text-muted-foreground">Client not found.</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-start gap-3">
            <Button variant="ghost" size="sm" onClick={goBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold">{client.clientName}</h1>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {client.clientNumber && (
                  <span className="text-xs text-muted-foreground font-mono">
                    #{client.clientNumber}
                  </span>
                )}
                {client.fileNumber && (
                  <span className="text-xs text-muted-foreground font-mono">
                    File: {client.fileNumber}
                  </span>
                )}
                {client.city && (
                  <Badge variant="secondary">{client.city}</Badge>
                )}
                {client.matterType && (
                  <Badge variant="secondary">{client.matterType}</Badge>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Status chip + inline edit */}
            {editingStatus ? (
              <div className="flex items-center gap-2">
                <Select
                  value={newStatus}
                  onValueChange={v => setNewStatus(v as any)}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Existing Client">Existing Client</SelectItem>
                    <SelectItem value="Leads">Leads</SelectItem>
                    <SelectItem value="Rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={() => updateClient.mutate({ id, clientStatus: newStatus })}
                  disabled={updateClient.isPending}
                >
                  <Check className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingStatus(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={`text-sm px-3 py-1 ${STATUS_COLORS[client.clientStatus]}`}
                >
                  {client.clientStatus}
                </Badge>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setNewStatus(client.clientStatus);
                      setEditingStatus(true);
                    }}
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            )}

            {canManage && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Rejected lock banner */}
        {isRejected && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 flex items-start gap-3">
            <Ban className="h-5 w-5 text-red-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold text-red-800">This client is marked as Rejected</p>
              <p className="text-sm text-red-700 mt-0.5">
                The record is locked and read-only. No new matters, financial records, tasks, or
                edits can be created. Existing history remains visible. To reactivate, change the
                status above.
              </p>
            </div>
          </div>
        )}

        {/* Tabs (controlled by ?tab= so task deep-links land on the right tab) */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="matters">Matters ({matters.length})</TabsTrigger>
            <TabsTrigger value="actions">Actions ({actions.length})</TabsTrigger>
            {canViewTasks && (
              <TabsTrigger value="tasks">Tasks ({clientTasks.length})</TabsTrigger>
            )}
            {canViewFinancial && (
              <TabsTrigger value="financial">Financial ({financialRecords.length})</TabsTrigger>
            )}
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview" className="space-y-4 mt-4">
            <ClientInfoCard client={client} canManage={canManageActive} onUpdated={() => utils.clients.get.invalidate({ id })} />

            {client.clientStatus === "Leads" && (
              <LeadDetailCard
                clientId={id}
                detail={leadDetail ?? null}
                canManage={canManage}
              />
            )}
            {client.clientStatus === "Rejected" && (
              <RejectedDetailCard
                clientId={id}
                detail={rejectedDetail ?? null}
                canManage={canManage}
              />
            )}

            {/* Audit trail */}
            <AuditTrailCard entityType="client" entityId={id} />
          </TabsContent>

          {/* Matters */}
          <TabsContent value="matters" className="mt-4">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-semibold">Client Matters</h3>
              {canManageActive && (
                <Button size="sm" onClick={() => setMatterDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Matter
                </Button>
              )}
            </div>
            <MattersTable matters={matters} clientId={id} canManage={canManageActive} inheritedSerial={inheritedSerial} />
            <MatterDialog
              open={matterDialogOpen}
              onClose={() => setMatterDialogOpen(false)}
              clientId={id}
              inheritedSerial={inheritedSerial}
            />
          </TabsContent>

          {/* Action Log */}
          <TabsContent value="actions" className="mt-4">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-semibold">Client Action Log</h3>
              {canManageActive && (
                <Button size="sm" onClick={() => setActionDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Log Action
                </Button>
              )}
            </div>
            <ActionsTable actions={actions} canManage={canManageActive} />
            <ActionDialog
              open={actionDialogOpen}
              onClose={() => setActionDialogOpen(false)}
              clientId={id}
              matters={matters}
            />
          </TabsContent>

          {/* Tasks */}
          {canViewTasks && (
            <TabsContent value="tasks" className="mt-4">
              <ClientTasksSection
                clientId={id}
                clientName={client.clientName}
                matters={matters}
                canManage={canManageActive}
                initialTaskId={initialTaskId}
              />
            </TabsContent>
          )}

          {/* Financial */}
          {canViewFinancial && (
            <TabsContent value="financial" className="mt-4">
              <FinancialSection clientId={id} records={financialRecords} matters={matters} locked={isRejected} />
            </TabsContent>
          )}
        </Tabs>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Client</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{client.clientName}</strong> and all associated
              matters, actions, and financial records. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteClient.mutate({ id })}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ClientInfoCard({ client, canManage, onUpdated }: {
  client: any;
  canManage: boolean;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    clientName: client.clientName,
    clientNumber: client.clientNumber ?? "",
    fileNumber: client.fileNumber ?? "",
    city: client.city ?? "",
    matterType: client.matterType ?? "",
  });
  const update = trpc.clients.update.useMutation({
    onSuccess: () => { toast.success("Saved"); setEditing(false); onUpdated(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Client Information</CardTitle>
        {canManage && !editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Edit2 className="h-4 w-4" />
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Client Name</Label>
                <Input value={form.clientName} onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))} />
              </div>
              <div>
                <Label>Client Number</Label>
                <Input value={form.clientNumber} onChange={e => setForm(f => ({ ...f, clientNumber: e.target.value }))} />
              </div>
              <div>
                <Label>File Number</Label>
                <Input value={form.fileNumber} onChange={e => setForm(f => ({ ...f, fileNumber: e.target.value }))} />
              </div>
              <div>
                <Label>City</Label>
                <Select value={form.city || "none"} onValueChange={v => setForm(f => ({ ...f, city: v === "none" ? "" : v }))}>
                  <SelectTrigger><SelectValue placeholder="Select city" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not specified</SelectItem>
                    <SelectItem value="Riyadh">Riyadh</SelectItem>
                    <SelectItem value="Dammam">Dammam</SelectItem>
                    <SelectItem value="Jeddah">Jeddah</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Matter Type</Label>
                <Select value={form.matterType || "none"} onValueChange={v => setForm(f => ({ ...f, matterType: v === "none" ? "" : v }))}>
                  <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not specified</SelectItem>
                    <SelectItem value="Corporate">Corporate</SelectItem>
                    <SelectItem value="Litigation">Litigation</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => update.mutate({ id: client.id, ...form as any })} disabled={update.isPending}>
                <Save className="h-4 w-4 mr-1" />Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
            <DataItem label="Client Number" value={client.clientNumber ?? "—"} />
            <DataItem label="File Number" value={client.fileNumber ?? "—"} />
            <DataItem label="City" value={client.city ?? "—"} />
            <DataItem label="Matter Type" value={client.matterType ?? "—"} />
            <DataItem label="Created" value={new Date(client.createdAt).toLocaleDateString()} />
            <DataItem label="Updated" value={new Date(client.updatedAt).toLocaleDateString()} />
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function DataItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground uppercase tracking-wide">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

function LeadDetailCard({ clientId, detail, canManage }: { clientId: number; detail: any; canManage: boolean }) {
  const utils = trpc.useUtils();
  const { data: lawyers = [] } = trpc.users.assignableLawyers.useQuery();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    clientSource: detail?.clientSource ?? "",
    nextActionDate: detail?.nextActionDate ?? "",
    nextActionDate2: detail?.nextActionDate2 ?? "",
    nextActionOwner: detail?.nextActionOwner ?? "",
    assignedLawyerId: detail?.assignedLawyerId ? String(detail.assignedLawyerId) : "",
    channelType: detail?.channelType ?? "",
    channelMedium: detail?.channelMedium ?? "",
    nextAction: detail?.nextAction ?? "",
    priority: detail?.priority ?? "medium",
    leadStatus: detail?.leadStatus ?? "",
  });
  const assignedLawyerName =
    lawyers.find(l => l.id === detail?.assignedLawyerId)?.name ?? null;
  const upsert = trpc.clients.upsertLeadDetail.useMutation({
    onSuccess: () => {
      toast.success("Lead details saved");
      setEditing(false);
      utils.clients.getLeadDetail.invalidate({ clientId });
      utils.clients.list.invalidate(); // refresh the intake page's assigned-lawyer column/filter
    },
    onError: (e) => toast.error(e.message),
  });

  function save() {
    const { assignedLawyerId, ...rest } = form;
    upsert.mutate({
      clientId,
      ...(rest as any),
      assignedLawyerId: assignedLawyerId ? Number(assignedLawyerId) : null,
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Lead Pipeline Details</CardTitle>
        {canManage && !editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Edit2 className="h-4 w-4" />
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><Label>Client Source</Label><Input value={form.clientSource} onChange={e => setForm(f => ({ ...f, clientSource: e.target.value }))} /></div>
              <div><Label>Lead Status</Label><Input value={form.leadStatus} onChange={e => setForm(f => ({ ...f, leadStatus: e.target.value }))} /></div>
              <div><Label>Next Action Date</Label><Input type="date" value={form.nextActionDate} onChange={e => setForm(f => ({ ...f, nextActionDate: e.target.value }))} /></div>
              <div><Label>Next Action Date 2</Label><Input type="date" value={form.nextActionDate2} onChange={e => setForm(f => ({ ...f, nextActionDate2: e.target.value }))} /></div>
              <div><Label>Next Action Owner</Label><Input value={form.nextActionOwner} onChange={e => setForm(f => ({ ...f, nextActionOwner: e.target.value }))} /></div>
              <div>
                <Label>Assigned Lawyer</Label>
                <Select
                  value={form.assignedLawyerId || "none"}
                  onValueChange={v => setForm(f => ({ ...f, assignedLawyerId: v === "none" ? "" : v }))}
                >
                  <SelectTrigger><SelectValue placeholder="— None —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {lawyers.map(l => (
                      <SelectItem key={l.id} value={String(l.id)}>{l.name ?? `User #${l.id}`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Channel Type</Label>
                <Select
                  value={form.channelType || "none"}
                  onValueChange={v => setForm(f => ({ ...f, channelType: v === "none" ? "" : v, channelMedium: "" }))}
                >
                  <SelectTrigger><SelectValue placeholder="— None —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {CHANNEL_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {channelMediumLabel(form.channelType) && (
                <div>
                  <Label>{channelMediumLabel(form.channelType)}{(form.channelType === "Digital Channels" || form.channelType === "Referral") ? " *" : ""}</Label>
                  {form.channelType === "Digital Channels" ? (
                    <Select value={form.channelMedium} onValueChange={v => setForm(f => ({ ...f, channelMedium: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select medium" /></SelectTrigger>
                      <SelectContent>
                        {DIGITAL_MEDIUMS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input value={form.channelMedium} onChange={e => setForm(f => ({ ...f, channelMedium: e.target.value }))} />
                  )}
                </div>
              )}
              <div>
                <Label>Priority</Label>
                <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div><Label>Next Action</Label><Textarea value={form.nextAction} onChange={e => setForm(f => ({ ...f, nextAction: e.target.value }))} rows={2} /></div>
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={upsert.isPending}>
                <Save className="h-4 w-4 mr-1" />Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : detail ? (
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
            <DataItem label="Source" value={detail.clientSource ?? "—"} />
            <DataItem label="Lead Status" value={detail.leadStatus ?? "—"} />
            <DataItem label="Priority" value={detail.priority ?? "—"} />
            <DataItem label="Next Action Date" value={detail.nextActionDate ?? "—"} />
            <DataItem label="Next Action Owner" value={detail.nextActionOwner ?? "—"} />
            <DataItem label="Assigned Lawyer" value={assignedLawyerName ?? "—"} />
            <DataItem label="Channel Type" value={detail.channelType ?? "—"} />
            <DataItem label="Channel Medium" value={detail.channelMedium ?? "—"} />
            <DataItem label="Next Action" value={detail.nextAction ?? "—"} />
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            No lead details yet.{canManage && " Click edit to add."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RejectedDetailCard({ clientId, detail, canManage }: { clientId: number; detail: any; canManage: boolean }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    rejectionReasonSource: detail?.rejectionReasonSource ?? "" as "" | "Client" | "Us",
    rejectionNotes: detail?.rejectionNotes ?? "",
    rejectedBy: detail?.rejectedBy ?? "",
  });
  const upsert = trpc.clients.upsertRejectedDetail.useMutation({
    onSuccess: () => { toast.success("Rejection details saved"); setEditing(false); utils.clients.getRejectedDetail.invalidate({ clientId }); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Rejection Details</CardTitle>
        {canManage && !editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Edit2 className="h-4 w-4" />
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Reason Source</Label>
                <Select value={form.rejectionReasonSource || "none"} onValueChange={v => setForm(f => ({ ...f, rejectionReasonSource: v === "none" ? "" : v as any }))}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not specified</SelectItem>
                    <SelectItem value="Client">Client</SelectItem>
                    <SelectItem value="Us">Us</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><Label>Rejected By</Label><Input value={form.rejectedBy} onChange={e => setForm(f => ({ ...f, rejectedBy: e.target.value }))} /></div>
            </div>
            <div><Label>Rejection Notes</Label><Textarea value={form.rejectionNotes} onChange={e => setForm(f => ({ ...f, rejectionNotes: e.target.value }))} rows={3} /></div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => upsert.mutate({ clientId, ...form as any, rejectionReasonSource: form.rejectionReasonSource || undefined })} disabled={upsert.isPending}>
                <Save className="h-4 w-4 mr-1" />Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : detail ? (
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <DataItem label="Reason Source" value={detail.rejectionReasonSource ?? "—"} />
            <DataItem label="Rejected By" value={detail.rejectedBy ?? "—"} />
            <DataItem label="Notes" value={detail.rejectionNotes ?? "—"} />
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            No rejection details yet.{canManage && " Click edit to add."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function AuditTrailCard({ entityType, entityId }: { entityType: string; entityId: number }) {
  const [show, setShow] = useState(false);
  const { data: logs = [] } = trpc.auditLogs.byEntity.useQuery({ entityType, entityId }, { enabled: show });
  return (
    <Card>
      <CardHeader className="pb-3 cursor-pointer" onClick={() => setShow(s => !s)}>
        <CardTitle className="text-base flex items-center justify-between">
          Audit Trail
          {show ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </CardTitle>
      </CardHeader>
      {show && (
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No audit entries yet.</p>
          ) : (
            <div className="space-y-2">
              {logs.map(log => (
                <div key={log.id} className="text-sm flex items-start gap-3 py-2 border-b last:border-0">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                  <span>{log.description}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function MattersTable({ matters, clientId, canManage, inheritedSerial }: { matters: any[]; clientId: number; canManage: boolean; inheritedSerial: string }) {
  const utils = trpc.useUtils();
  const [editingMatter, setEditingMatter] = useState<any | null>(null);
  const [ratesMatter, setRatesMatter] = useState<any | null>(null);

  const deleteMatter = trpc.clientMatters.delete.useMutation({
    onSuccess: () => {
      toast.success("Matter deleted");
      utils.clientMatters.list.invalidate({ clientId });
      utils.clientMatters.listAll.invalidate();
      utils.financial.list.invalidate({ clientId });               // NC-8: refresh financial view after matter delete
    },
  });

  if (matters.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p>No matters linked to this client yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Original Serial</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Billing</TableHead>
                <TableHead>Lead Partner</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Achievement</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {matters.map(m => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono text-sm">{m.matterReference ?? "—"}</TableCell>
                  <TableCell className="font-mono text-sm">{m.originalSerial ?? "—"}</TableCell>
                  <TableCell>{m.matterType ?? "—"}</TableCell>
                  <TableCell>
                    {m.billingType ? (
                      <Badge
                        variant="outline"
                        className={m.billingType === "Billable Hours" ? "border-blue-300 text-blue-700 bg-blue-50" : ""}
                      >
                        {m.billingType === "Billable Hours" ? (
                          <><Clock className="h-3 w-3 mr-1 inline" />{m.billingType}</>
                        ) : m.billingType}
                      </Badge>
                    ) : "—"}
                  </TableCell>
                  <TableCell>{m.leadPartnerFullName ?? m.leadPartner ?? "—"}</TableCell>
                  <TableCell>{m.matterStatus ?? "—"}</TableCell>
                  <TableCell>{m.achievementPercentage ? `${m.achievementPercentage}%` : "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">{m.priority ?? "medium"}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {m.billingType === "Billable Hours" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Lawyer Hourly Rates"
                          onClick={() => setRatesMatter(m)}
                        >
                          <Clock className="h-4 w-4 text-blue-500" />
                        </Button>
                      )}
                      {canManage && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setEditingMatter(m)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => deleteMatter.mutate({ id: m.id })}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit matter dialog */}
      {editingMatter && (
        <MatterEditDialog
          open={!!editingMatter}
          onClose={() => setEditingMatter(null)}
          clientId={clientId}
          matter={editingMatter}
          inheritedSerial={inheritedSerial}
        />
      )}

      {/* Lawyer rates dialog — only for Billable Hours matters */}
      {ratesMatter && (
        <LawyerRatesDialog
          open={!!ratesMatter}
          onClose={() => setRatesMatter(null)}
          matter={ratesMatter}
        />
      )}
    </>
  );
}

const FEE_TYPE_OPTIONS = [
  "Billable Hours",
  "Fixed / Project-Based Fees",
  "Retainers",
  "Success Fees",
  "Advisory / Special Mandates",
  "Blended",
] as const;

type MatterFormState = {
  originalSerial: string; matterReference: string; matterType: string;
  billingType: string;
  // Lead Partner as a real user (authoritative). leadPartner/leadPartnerFullName
  // remain for legacy/free-text display on records without a linked user.
  leadLawyerId: number | null;
  leadPartner: string; leadPartnerFullName: string; supportLead: string;
  attorneyHead: string; attorney1: string; attorney2: string; attorney3: string;
  attorneyFullName: string; matterDescription: string; opposingParty: string; matterStatus: string;
  balanceWorkLeft: string; achievementPercentage: string; achievementStatus: string;
  priority: "low" | "medium" | "high" | "urgent";
};

const MATTER_FORM_DEFAULT: MatterFormState = {
  originalSerial: "", matterReference: "", matterType: "", billingType: "",
  leadLawyerId: null,
  leadPartner: "", leadPartnerFullName: "", supportLead: "", attorneyHead: "",
  attorney1: "", attorney2: "", attorney3: "", attorneyFullName: "",
  matterDescription: "", opposingParty: "", matterStatus: "",
  balanceWorkLeft: "", achievementPercentage: "", achievementStatus: "",
  priority: "medium",
};

const MATTER_TEXT_FIELDS: [keyof MatterFormState, string][] = [
  ["matterReference",      "Matter Reference * (unique per client)"],
  ["matterType",           "Matter Type *"],
  ["supportLead",          "Support Lead"],
  ["attorneyHead",         "Attorney Head"],
  ["attorney1",            "Attorney 1"],
  ["attorney2",            "Attorney 2"],
  ["attorney3",            "Attorney 3"],
  ["attorneyFullName",     "Attorney Full Name"],
  ["opposingParty",        "Opposing Party (for conflict check)"],
  ["matterStatus",         "Matter Status (e.g. Active)"],
  ["balanceWorkLeft",      "Balance Work Left (%)"],
  ["achievementPercentage","Achievement %"],
  ["achievementStatus",    "Achievement Status"],
];

function buildMatterPayload(
  form: MatterFormState,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = { priority: form.priority, ...extra };
  for (const [k, v] of Object.entries(form)) {
    if (k === "priority") continue;
    if (k === "billingType") {
      // Always include billingType so it can be explicitly cleared (null = no billing type)
      payload[k] = v !== "" ? v : null;
      continue;
    }
    if (k === "leadLawyerId") {
      // Only a real selection is sent here; an explicit unlink (null) is added by
      // the edit caller so the create schema (no null) is not violated.
      if (typeof v === "number") payload[k] = v;
      continue;
    }
    if (typeof v === "string" && v.trim() !== "") payload[k] = v.trim();
  }
  return payload;
}

function MatterFormFields({
  form,
  setForm,
  inheritedSerial,
  onSerialEdited,
}: {
  form: MatterFormState;
  setForm: Dispatch<SetStateAction<MatterFormState>>;
  /** The client's number this matter's Original Serial inherits from. */
  inheritedSerial?: string;
  /** Called when the user types into Original Serial, to stop auto-inheriting. */
  onSerialEdited?: () => void;
}) {
  // Active Partners/Lawyers eligible to lead a matter (Phase 3 dropdown source).
  const { data: leadLawyers = [] } = trpc.users.leadLawyers.useQuery();
  // A matter may have a lead lawyer who is no longer in the active list (e.g.
  // edited later) — keep them selectable so the value is not silently lost.
  const selectedKnown = leadLawyers.some(l => l.id === form.leadLawyerId);
  return (
    <div className="grid grid-cols-2 gap-3 py-2">
      {/* Original Serial — inherited from the client, shown distinctly so it is
          not mistaken for the matter's own identifier. */}
      <div className="col-span-2">
        <Label className="text-xs">Original Serial (inherited from client)</Label>
        <Input
          value={form.originalSerial}
          onChange={e => { onSerialEdited?.(); setForm(f => ({ ...f, originalSerial: e.target.value })); }}
          placeholder={inheritedSerial || "Defaults to the client number"}
          className="h-8 text-sm bg-muted/40 font-mono"
        />
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {inheritedSerial
            ? <>Inherited from client number <span className="font-mono">{inheritedSerial}</span>. Shared by all of this client's matters — not the matter's unique identifier.</>
            : "Shared by all of this client's matters — not the matter's unique identifier."}
        </p>
      </div>
      {/* Lead Partner — chosen from active Partners/Lawyers (Phase 3). Selecting a
          user links the matter to a real user and populates the display name. */}
      <div className="col-span-2">
        <Label className="text-xs">Lead Partner</Label>
        <Select
          value={form.leadLawyerId != null ? String(form.leadLawyerId) : "__none__"}
          onValueChange={v => {
            if (v === "__none__") {
              setForm(f => ({ ...f, leadLawyerId: null }));
              return;
            }
            const id = Number(v);
            const picked = leadLawyers.find(l => l.id === id);
            setForm(f => ({
              ...f,
              leadLawyerId: id,
              leadPartnerFullName: picked?.name ?? f.leadPartnerFullName,
            }));
          }}
        >
          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="— select a lead partner —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">— None —</SelectItem>
            {/* Keep an out-of-list current value selectable */}
            {!selectedKnown && form.leadLawyerId != null && (
              <SelectItem value={String(form.leadLawyerId)}>
                {form.leadPartnerFullName || `User #${form.leadLawyerId}`} (inactive)
              </SelectItem>
            )}
            {leadLawyers.map(l => (
              <SelectItem key={l.id} value={String(l.id)}>
                {l.name}{l.role ? ` — ${l.role}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {form.leadLawyerId == null && form.leadPartnerFullName.trim() !== "" && (
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Legacy value: <span className="font-medium">{form.leadPartnerFullName}</span> (not linked to a user). Select a lead partner to link it.
          </p>
        )}
      </div>
      {MATTER_TEXT_FIELDS.map(([key, label]) => (
        <div key={key}>
          <Label className="text-xs">{label}</Label>
          <Input
            value={form[key] as string}
            onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
            className="h-8 text-sm"
          />
        </div>
      ))}
      {/* Billing Type */}
      <div>
        <Label className="text-xs">Billing Type</Label>
        {/* Radix Select.Item requires a non-empty string value — use sentinel "__none__" */}
        <Select
          value={form.billingType || "__none__"}
          onValueChange={v => setForm(f => ({ ...f, billingType: v === "__none__" ? "" : v }))}
        >
          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="— select —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">— None —</SelectItem>
            {FEE_TYPE_OPTIONS.map(opt => (
              <SelectItem key={opt} value={opt}>{opt}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* Priority */}
      <div>
        <Label className="text-xs">Priority</Label>
        <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v as any }))}>
          <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="urgent">Urgent</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {/* Description full-width */}
      <div className="col-span-2">
        <Label className="text-xs">Description / Notes</Label>
        <Textarea
          value={form.matterDescription}
          onChange={e => setForm(f => ({ ...f, matterDescription: e.target.value }))}
          rows={3}
          className="text-sm"
          placeholder="Long-form description, scope, instructions…"
        />
      </div>
    </div>
  );
}

function MatterDialog({
  open, onClose, clientId, inheritedSerial,
}: {
  open: boolean;
  onClose: () => void;
  clientId: number;
  inheritedSerial: string;
}) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<MatterFormState>(MATTER_FORM_DEFAULT);
  const [serialTouched, setSerialTouched] = useState(false);
  const [pendingConflicts, setPendingConflicts] = useState<ConflictMatch[] | null>(null);
  const [checking, setChecking] = useState(false);

  // Mirror the client's number into Original Serial until the user overrides it.
  useEffect(() => {
    if (open && !serialTouched) {
      setForm(f => ({ ...f, originalSerial: inheritedSerial }));
    }
  }, [open, inheritedSerial, serialTouched]);

  const create = trpc.clientMatters.create.useMutation({
    onSuccess: () => {
      toast.success("Matter added");
      utils.clientMatters.list.invalidate({ clientId });
      utils.clientMatters.listAll.invalidate();
      setForm(MATTER_FORM_DEFAULT);
      setSerialTouched(false);
      setPendingConflicts(null);
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const submit = async () => {
    // Matter Type is authoritative at the matter level (CRM-006) and required.
    if (!form.matterType.trim()) {
      toast.error("Matter Type is required");
      return;
    }
    // Matter Reference is the required matter-level identifier (CRM-007).
    if (!form.matterReference.trim()) {
      toast.error("Matter Reference is required");
      return;
    }
    // Auto-run conflict check against matter name + opposing party.
    setChecking(true);
    try {
      const conflicts = await utils.clientMatters.checkConflicts.fetch({
        matterName: form.matterReference.trim() || undefined,
        opposingParty: form.opposingParty.trim() || undefined,
        clientId,
      });
      if (conflicts.length > 0) {
        setPendingConflicts(conflicts);
        return;
      }
      create.mutate(buildMatterPayload(form, { clientId }) as any);
    } catch (e: any) {
      toast.error(e?.message ?? "Conflict check failed");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Matter</DialogTitle>
          </DialogHeader>
          <MatterFormFields
            form={form}
            setForm={setForm}
            inheritedSerial={inheritedSerial}
            onSerialEdited={() => setSerialTouched(true)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={create.isPending || checking}>
              {checking ? "Checking conflicts…" : "Add Matter"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConflictWarningDialog
        open={pendingConflicts !== null}
        conflicts={pendingConflicts ?? []}
        isCreating={create.isPending}
        onCancel={() => setPendingConflicts(null)}
        onAcknowledge={() => {
          create.mutate(buildMatterPayload(form, { clientId, acknowledgeConflicts: true }) as any);
          setPendingConflicts(null);
        }}
      />
    </>
  );
}

function MatterEditDialog({
  open, onClose, clientId, matter, inheritedSerial,
}: {
  open: boolean;
  onClose: () => void;
  clientId: number;
  matter: any;
  inheritedSerial: string;
}) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<MatterFormState>({
    originalSerial:        matter.originalSerial        ?? "",
    matterReference:       matter.matterReference       ?? "",
    matterType:            matter.matterType            ?? "",
    billingType:           matter.billingType           ?? "",
    leadLawyerId:          matter.leadLawyerId          ?? null,
    leadPartner:           matter.leadPartner           ?? "",
    leadPartnerFullName:   matter.leadPartnerFullName   ?? "",
    supportLead:           matter.supportLead           ?? "",
    attorneyHead:          matter.attorneyHead          ?? "",
    attorney1:             matter.attorney1             ?? "",
    attorney2:             matter.attorney2             ?? "",
    attorney3:             matter.attorney3             ?? "",
    attorneyFullName:      matter.attorneyFullName      ?? "",
    matterDescription:     matter.matterDescription     ?? "",
    opposingParty:         matter.opposingParty         ?? "",
    matterStatus:          matter.matterStatus          ?? "",
    balanceWorkLeft:       matter.balanceWorkLeft       ?? "",
    achievementPercentage: matter.achievementPercentage ?? "",
    achievementStatus:     matter.achievementStatus     ?? "",
    priority:              matter.priority              ?? "medium",
  });

  const update = trpc.clientMatters.update.useMutation({
    onSuccess: () => {
      toast.success("Matter updated");
      utils.clientMatters.list.invalidate({ clientId });
      utils.clientMatters.listAll.invalidate(); // keep global financial page in sync
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Matter — {matter.matterReference ?? matter.originalSerial ?? `#${matter.id}`}</DialogTitle>
        </DialogHeader>
        <MatterFormFields form={form} setForm={setForm} inheritedSerial={inheritedSerial} />

        {/* Related tasks for this matter */}
        <div className="border-t pt-3 mt-2">
          <h4 className="text-sm font-semibold mb-2">Related Tasks</h4>
          <RelatedTasks clientMatterId={matter.id} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => {
              // Matter Type is required at the matter level (CRM-006).
              if (!form.matterType.trim()) {
                toast.error("Matter Type is required");
                return;
              }
              // Matter Reference is required and cannot be cleared (CRM-007).
              if (!form.matterReference.trim()) {
                toast.error("Matter Reference is required");
                return;
              }
              const payload = buildMatterPayload(form);
              // Explicit unlink: the lead lawyer was cleared on a matter that had one.
              if (form.leadLawyerId == null && matter.leadLawyerId != null) {
                payload.leadLawyerId = null;
              }
              update.mutate({ id: matter.id, ...payload } as any);
            }}
            disabled={update.isPending}
          >
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActionsTable({ actions, canManage }: { actions: any[]; canManage: boolean }) {
  const utils = trpc.useUtils();
  const deleteAction = trpc.clientActions.delete.useMutation({
    onSuccess: () => { toast.success("Action deleted"); utils.clientActions.list.invalidate(); },
  });

  if (actions.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          <Calendar className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p>No actions logged yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Next Step</TableHead>
              {canManage && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {actions.map(a => (
              <TableRow key={a.id}>
                <TableCell className="text-sm">{a.actionDate ?? "—"}</TableCell>
                <TableCell>{a.actionType ?? "—"}</TableCell>
                <TableCell>{a.actionOwner ?? "—"}</TableCell>
                <TableCell className="max-w-xs truncate">{a.actionDetails ?? "—"}</TableCell>
                <TableCell className="max-w-xs truncate">{a.nextStep ?? "—"}</TableCell>
                {canManage && (
                  <TableCell>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => deleteAction.mutate({ id: a.id })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ActionDialog({ open, onClose, clientId, matters }: { open: boolean; onClose: () => void; clientId: number; matters: any[] }) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState({
    clientMatterId: "" as string,
    actionOwner: "",
    nextStep: "",
    actionDate: "",
    actionType: "",
    actionDetails: "",
  });
  const create = trpc.clientActions.create.useMutation({
    onSuccess: () => {
      toast.success("Action logged");
      utils.clientActions.list.invalidate({ clientId });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Log Action</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label>Action Date</Label>
            <Input type="date" value={form.actionDate} onChange={e => setForm(f => ({ ...f, actionDate: e.target.value }))} />
          </div>
          <div>
            <Label>Action Type</Label>
            <Input value={form.actionType} onChange={e => setForm(f => ({ ...f, actionType: e.target.value }))} placeholder="e.g. Call, Meeting, Email" />
          </div>
          <div>
            <Label>Action Owner</Label>
            <Input value={form.actionOwner} onChange={e => setForm(f => ({ ...f, actionOwner: e.target.value }))} />
          </div>
          {matters.length > 0 && (
            <div>
              <Label>Linked Matter (optional)</Label>
              <Select value={form.clientMatterId || "none"} onValueChange={v => setForm(f => ({ ...f, clientMatterId: v === "none" ? "" : v }))}>
                <SelectTrigger><SelectValue placeholder="No matter" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No matter</SelectItem>
                  {matters.map(m => (
                    <SelectItem key={m.id} value={String(m.id)}>{m.matterReference ?? m.originalSerial ?? `Matter #${m.id}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label>Action Details</Label>
            <Textarea value={form.actionDetails} onChange={e => setForm(f => ({ ...f, actionDetails: e.target.value }))} rows={3} />
          </div>
          <div>
            <Label>Next Step</Label>
            <Textarea value={form.nextStep} onChange={e => setForm(f => ({ ...f, nextStep: e.target.value }))} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => create.mutate({
              clientId,
              clientMatterId: form.clientMatterId ? Number(form.clientMatterId) : undefined,
              actionOwner: form.actionOwner || undefined,
              nextStep: form.nextStep || undefined,
              actionDate: form.actionDate || undefined,
              actionType: form.actionType || undefined,
              actionDetails: form.actionDetails || undefined,
            })}
            disabled={create.isPending}
          >
            Log Action
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const INVOICE_STATUS_COLORS: Record<string, string> = {
  "Not Billed":          "bg-gray-100 text-gray-700",
  "Partially Billed":    "bg-yellow-100 text-yellow-800",
  "Billed":              "bg-blue-100 text-blue-800",
  "Partially Collected": "bg-orange-100 text-orange-800",
  "Fully Collected":     "bg-green-100 text-green-800",
  "Overdue":             "bg-red-100 text-red-800",
};

const fmtSAR = (v: string | number | null | undefined) =>
  v ? `SAR ${Number(v).toLocaleString()}` : "—";

function FinancialSection({
  clientId,
  records,
  matters,
  locked = false,
}: {
  clientId: number;
  records: any[];
  matters: any[];
  locked?: boolean;
}) {
  const utils = trpc.useUtils();
  const { user } = useAuth();                                        // BUG-4: hook at top level
  const [createOpen, setCreateOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<any | null>(null);
  const [auditRecord, setAuditRecord] = useState<any | null>(null);
  const [matterFilter, setMatterFilter] = useState("all");
  // Rejected clients lock create/edit/delete; viewing + audit stay available.
  const canManage = hasPermission(user?.role, "financial:manage") && !locked;

  const deleteRecord = trpc.financial.delete.useMutation({
    onSuccess: () => {
      toast.success("Record deleted");
      utils.financial.list.invalidate({ clientId });
      utils.financial.summary.invalidate();
      utils.financial.toBeBilledBreakdown.invalidate();             // NC-8: refresh after matter delete
    },
  });

  // Build matter lookup: id → matter object
  const matterMap = useMemo(                                        // NC-2: memoize
    () => Object.fromEntries(matters.map(m => [m.id, m])),
    [matters],
  );

  // Client-side filter by matter (memoized — NC-2)
  const filteredRecords = useMemo(() => {
    if (matterFilter === "all")  return records;
    if (matterFilter === "none") return records.filter(r => !r.clientMatterId);
    return records.filter(r => String(r.clientMatterId) === matterFilter);
  }, [records, matterFilter]);

  // Matter label helper for the table
  function matterDisplay(r: any) {
    if (!r.clientMatterId) {
      return <span className="text-xs text-muted-foreground italic">Client-level</span>;
    }
    const m = matterMap[r.clientMatterId];
    if (!m) return <span className="text-xs font-mono">#{r.clientMatterId}</span>;
    return (
      <span className="text-xs leading-tight">
        <span className="font-medium">
          {m.matterReference ?? m.originalSerial ?? `#${m.id}`}
        </span>
        {m.matterType && (
          <span className="text-muted-foreground"> · {m.matterType}</span>
        )}
      </span>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Matter filter */}
        <div className="flex items-center gap-2">
          <Select value={matterFilter} onValueChange={setMatterFilter}>
            <SelectTrigger className="h-8 w-52 text-xs">
              <SelectValue placeholder="Filter by matter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All records</SelectItem>
              <SelectItem value="none">Client-level only</SelectItem>
              {matters.map(m => (
                <SelectItem key={m.id} value={String(m.id)}>
                  {m.matterReference ?? m.originalSerial ?? `Matter #${m.id}`}
                  {m.matterType ? ` · ${m.matterType}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {matterFilter !== "all" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs text-muted-foreground"
              onClick={() => setMatterFilter("all")}
            >
              Clear filter
            </Button>
          )}
        </div>

        {canManage && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />Add Financial Record
          </Button>
        )}
      </div>

      {records.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <DollarSign className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p>No financial records yet.</p>
          </CardContent>
        </Card>
      ) : filteredRecords.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <p className="text-sm">No records match the selected filter.</p>
            <Button variant="link" size="sm" onClick={() => setMatterFilter("all")}>
              Clear filter
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Matter</TableHead>
                    <TableHead>Fee Type</TableHead>
                    <TableHead>Agreed Fees</TableHead>
                    <TableHead>To Be Billed</TableHead>
                    <TableHead>Net Fees</TableHead>
                    <TableHead>Revenue</TableHead>
                    <TableHead>Outstanding</TableHead>
                    <TableHead>Invoice Status</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRecords.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="min-w-[120px]">{matterDisplay(r)}</TableCell>
                      <TableCell className="text-sm">{r.feeType ?? "—"}</TableCell>
                      <TableCell className="text-sm">{fmtSAR(r.agreedFees)}</TableCell>
                      <TableCell className="text-sm">
                        {(() => {
                          // Revenue is the single active amount field (Billed Amount
                          // is legacy/read-only — CRM-012). To Be Billed = Net Fees − Revenue
                          // (after discount). Net Fees falls back to Agreed Fees on legacy
                          // rows where net_fees was never populated (no discount).
                          const net     = Number(r.netFees) || Number(r.agreedFees) || 0;
                          const revenue = Number(r.revenue) || 0;
                          const tbb     = Math.max(0, net - revenue);
                          const over    = net > 0 && revenue > net;
                          if (over) return <span className="text-red-600 font-medium text-xs">Overbilled</span>;
                          if (tbb === 0 && net > 0) return <span className="text-green-700 text-xs font-medium">Fully billed</span>;
                          return <span className="text-amber-700 font-medium">{net > 0 ? fmtSAR(tbb) : "—"}</span>;
                        })()}
                      </TableCell>
                      <TableCell className="text-sm">{fmtSAR(r.netFees)}</TableCell>
                      <TableCell className="text-sm">{fmtSAR(r.revenue)}</TableCell>
                      <TableCell className="text-sm">{fmtSAR(r.outstandingAmount)}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={INVOICE_STATUS_COLORS[r.collectionStatus ?? ""] ?? ""}
                        >
                          {r.collectionStatus ?? "—"}
                        </Badge>
                      </TableCell>
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
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingRecord(r)}
                                title="Edit record"
                              >
                                <Edit2 className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive"
                                onClick={() => deleteRecord.mutate({ id: r.id })}
                                title="Delete record"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create dialog — passes client's matters for matter selector */}
      <FinancialDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        clientId={clientId}
        matters={matters}
      />

      {/* Edit dialog — passes client's matters so user can change/link matter */}
      <FinancialDialog
        open={editingRecord !== null}
        onClose={() => setEditingRecord(null)}
        clientId={clientId}
        record={editingRecord}
        matters={matters}
      />

      {/* Audit trail dialog — read-only, available to all financial:view users */}
      {auditRecord && (
        <FinancialAuditTrail
          open={auditRecord !== null}
          onClose={() => setAuditRecord(null)}
          record={auditRecord}
        />
      )}
    </div>
  );
}

