import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft, Save, Trash2, Plus, Edit2, Check, X, ChevronDown, ChevronUp,
  Users, FileText, DollarSign, Calendar, AlertCircle,
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
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { hasPermission } from "@shared/const";

const STATUS_COLORS: Record<string, string> = {
  "Existing Client": "bg-green-100 text-green-800 border-green-200",
  Leads: "bg-blue-100 text-blue-800 border-blue-200",
  Rejected: "bg-red-100 text-red-800 border-red-200",
};

export default function ClientDetail({ id }: { id: number }) {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const canManage = hasPermission(user?.role, "clients:manage");
  const canViewFinancial = hasPermission(user?.role, "financial:view");
  const utils = trpc.useUtils();

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

  // Edit client status inline
  const [editingStatus, setEditingStatus] = useState(false);
  const [newStatus, setNewStatus] = useState<"Existing Client" | "Leads" | "Rejected">("Leads");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [matterDialogOpen, setMatterDialogOpen] = useState(false);
  const [actionDialogOpen, setActionDialogOpen] = useState(false);

  const updateClient = trpc.clients.update.useMutation({
    onSuccess: () => {
      toast.success("Client updated");
      utils.clients.get.invalidate({ id });
      utils.clients.statusCounts.invalidate();
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
            <Button variant="ghost" size="sm" onClick={() => navigate("/clients")}>
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

        {/* Tabs */}
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="matters">Matters ({matters.length})</TabsTrigger>
            <TabsTrigger value="actions">Actions ({actions.length})</TabsTrigger>
            {canViewFinancial && (
              <TabsTrigger value="financial">Financial ({financialRecords.length})</TabsTrigger>
            )}
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview" className="space-y-4 mt-4">
            <ClientInfoCard client={client} canManage={canManage} onUpdated={() => utils.clients.get.invalidate({ id })} />

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
              {canManage && (
                <Button size="sm" onClick={() => setMatterDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Matter
                </Button>
              )}
            </div>
            <MattersTable matters={matters} clientId={id} canManage={canManage} />
            <MatterDialog
              open={matterDialogOpen}
              onClose={() => setMatterDialogOpen(false)}
              clientId={id}
            />
          </TabsContent>

          {/* Action Log */}
          <TabsContent value="actions" className="mt-4">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-semibold">Client Action Log</h3>
              {canManage && (
                <Button size="sm" onClick={() => setActionDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Log Action
                </Button>
              )}
            </div>
            <ActionsTable actions={actions} canManage={canManage} />
            <ActionDialog
              open={actionDialogOpen}
              onClose={() => setActionDialogOpen(false)}
              clientId={id}
              matters={matters}
            />
          </TabsContent>

          {/* Financial */}
          {canViewFinancial && (
            <TabsContent value="financial" className="mt-4">
              <FinancialSection clientId={id} records={financialRecords} matters={matters} />
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
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    clientSource: detail?.clientSource ?? "",
    nextActionDate: detail?.nextActionDate ?? "",
    nextActionDate2: detail?.nextActionDate2 ?? "",
    nextActionOwner: detail?.nextActionOwner ?? "",
    nextAction: detail?.nextAction ?? "",
    priority: detail?.priority ?? "medium",
    leadStatus: detail?.leadStatus ?? "",
  });
  const upsert = trpc.clients.upsertLeadDetail.useMutation({
    onSuccess: () => { toast.success("Lead details saved"); setEditing(false); utils.clients.getLeadDetail.invalidate({ clientId }); },
    onError: (e) => toast.error(e.message),
  });

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
              <Button size="sm" onClick={() => upsert.mutate({ clientId, ...form as any })} disabled={upsert.isPending}>
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

function MattersTable({ matters, clientId, canManage }: { matters: any[]; clientId: number; canManage: boolean }) {
  const utils = trpc.useUtils();
  const deleteMatter = trpc.clientMatters.delete.useMutation({
    onSuccess: () => {
      toast.success("Matter deleted");
      utils.clientMatters.list.invalidate({ clientId });
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
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Lead Partner</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Achievement</TableHead>
              <TableHead>Priority</TableHead>
              {canManage && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {matters.map(m => (
              <TableRow key={m.id}>
                <TableCell className="font-mono text-sm">{m.matterReference ?? m.originalSerial ?? "—"}</TableCell>
                <TableCell>{m.matterType ?? "—"}</TableCell>
                <TableCell>{m.leadPartnerFullName ?? m.leadPartner ?? "—"}</TableCell>
                <TableCell>{m.matterStatus ?? "—"}</TableCell>
                <TableCell>{m.achievementPercentage ? `${m.achievementPercentage}%` : "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">{m.priority ?? "medium"}</Badge>
                </TableCell>
                {canManage && (
                  <TableCell>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => deleteMatter.mutate({ id: m.id })}>
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

function MatterDialog({ open, onClose, clientId }: { open: boolean; onClose: () => void; clientId: number }) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState({
    originalSerial: "", matterReference: "", matterType: "", leadPartner: "",
    leadPartnerFullName: "", supportLead: "", attorneyHead: "", attorney1: "",
    attorney2: "", attorney3: "", attorneyFullName: "",
    matterDescription: "", matterStatus: "",
    balanceWorkLeft: "", achievementPercentage: "", achievementStatus: "",
    priority: "medium" as "low" | "medium" | "high" | "urgent",
  });
  const create = trpc.clientMatters.create.useMutation({
    onSuccess: () => {
      toast.success("Matter added");
      utils.clientMatters.list.invalidate({ clientId });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Matter</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">
          {[
            ["originalSerial", "Original Serial"],
            ["matterReference", "Matter Reference"],
            ["matterType", "Matter Type"],
            ["leadPartner", "Lead Partner (Code)"],
            ["leadPartnerFullName", "Lead Partner (Full Name)"],
            ["supportLead", "Support Lead"],
            ["attorneyHead", "Attorney Head"],
            ["attorney1", "Attorney 1"],
            ["attorney2", "Attorney 2"],
            ["attorney3", "Attorney 3"],
            ["attorneyFullName", "Attorney Full Name"],
            ["matterStatus", "Matter Status (short, e.g. Active)"],
            ["balanceWorkLeft", "Balance Work Left (%)"],
            ["achievementPercentage", "Achievement %"],
            ["achievementStatus", "Achievement Status"],
          ].map(([key, label]) => (
            <div key={key}>
              <Label className="text-xs">{label}</Label>
              <Input
                value={(form as any)[key]}
                onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                className="h-8 text-sm"
              />
            </div>
          ))}
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => {
              const payload: Record<string, unknown> = { clientId, priority: form.priority };
              for (const [k, v] of Object.entries(form)) {
                if (k === "priority") continue;
                if (typeof v === "string" && v.trim() !== "") payload[k] = v.trim();
              }
              create.mutate(payload as any);
            }}
            disabled={create.isPending}
          >
            Add Matter
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
}: {
  clientId: number;
  records: any[];
  matters: any[];
}) {
  const utils = trpc.useUtils();
  const { user } = useAuth();                                        // BUG-4: hook at top level
  const [createOpen, setCreateOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<any | null>(null);
  const [matterFilter, setMatterFilter] = useState("all");
  const canManage = hasPermission(user?.role, "financial:manage");

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
                    {canManage && <TableHead className="w-20" />}
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
                          const agreed  = Number(r.agreedFees)  || 0;
                          const billed  = Number(r.billedAmount) || 0;
                          const tbb     = Math.max(0, agreed - billed);
                          const over    = agreed > 0 && billed > agreed;
                          if (over) return <span className="text-red-600 font-medium text-xs">Overbilled</span>;
                          if (tbb === 0) return <span className="text-green-700 text-xs font-medium">Fully billed</span>;
                          return <span className="text-amber-700 font-medium">{fmtSAR(tbb)}</span>;
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
                      {canManage && (
                        <TableCell>
                          <div className="flex items-center gap-1">
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
                          </div>
                        </TableCell>
                      )}
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
    </div>
  );
}

