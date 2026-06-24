import { useState, useMemo, useEffect } from "react";
import { Plus, Trash2, Eye } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { TaskDetailDialog } from "@/components/TaskDetailDialog";

export const TASK_STATUSES = ["todo", "in_progress", "done", "cancelled"] as const;
export const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "To Do", in_progress: "In Progress", done: "Done", cancelled: "Cancelled",
};
const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const NO_MATTER = "none";

function isOpenMatter(m: any): boolean {
  const s = (m.matterStatus ?? "").toLowerCase();
  return s !== "closed" && s !== "archived";
}

/** Tasks tab inside the client profile: filterable, client-scoped task list. */
export function ClientTasksSection({
  clientId, clientName, matters, canManage, initialTaskId,
}: {
  clientId: number; clientName: string; matters: any[]; canManage: boolean;
  /** When provided (e.g. from ?taskId= in the URL), auto-opens that task's details. */
  initialTaskId?: number | null;
}) {
  const utils = trpc.useUtils();
  const { data: tasks = [] } = trpc.tasks.list.useQuery({ clientId });
  const { data: lawyers = [] } = trpc.users.assignableLawyers.useQuery();

  const [matterFilter, setMatterFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detailTaskId, setDetailTaskId] = useState<number | null>(initialTaskId ?? null);

  // Open the requested task's details when arriving via ?tab=tasks&taskId=…
  useEffect(() => {
    if (initialTaskId != null) setDetailTaskId(initialTaskId);
  }, [initialTaskId]);

  const invalidate = () => utils.tasks.list.invalidate();
  const updateTask = trpc.tasks.update.useMutation({
    onSuccess: () => { toast.success("Task updated"); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const deleteTask = trpc.tasks.delete.useMutation({
    onSuccess: () => { toast.success("Task deleted"); invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const filtered = useMemo(() => (tasks as any[]).filter(t => {
    if (matterFilter === NO_MATTER && t.clientMatterId) return false;
    if (matterFilter !== "all" && matterFilter !== NO_MATTER && String(t.clientMatterId) !== matterFilter) return false;
    if (statusFilter !== "all" && t.status !== statusFilter) return false;
    if (assigneeFilter !== "all" && String(t.assignedTo) !== assigneeFilter) return false;
    return true;
  }), [tasks, matterFilter, statusFilter, assigneeFilter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Client Tasks</h3>
        {canManage && (
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add Task
          </Button>
        )}
      </div>

      {/* Filters: matter / status / assignee */}
      <div className="flex flex-wrap gap-2">
        <Select value={matterFilter} onValueChange={setMatterFilter}>
          <SelectTrigger className="w-48 h-8 text-sm"><SelectValue placeholder="Matter" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Matters</SelectItem>
            <SelectItem value={NO_MATTER}>N/A — No matter yet</SelectItem>
            {matters.map(m => (
              <SelectItem key={m.id} value={String(m.id)}>
                {m.matterReference ?? m.originalSerial ?? `Matter #${m.id}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40 h-8 text-sm"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {TASK_STATUSES.map(s => <SelectItem key={s} value={s}>{TASK_STATUS_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
          <SelectTrigger className="w-44 h-8 text-sm"><SelectValue placeholder="Assignee" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Assignees</SelectItem>
            {lawyers.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name ?? `User #${l.id}`}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No tasks match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Task</TableHead>
                    <TableHead>Matter</TableHead>
                    <TableHead>Assignee</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((t: any) => (
                    <TableRow key={t.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setDetailTaskId(t.id)}>
                      <TableCell className="font-medium">
                        <span className="hover:underline">{t.title}</span>
                        <span className="ml-2 align-middle text-[11px] text-muted-foreground">
                          {t.clientMatterId ? "Matter-level" : "Client-level"}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{t.matterReference ?? "—"}</TableCell>
                      <TableCell className="text-sm">{t.assigneeName ?? "—"}</TableCell>
                      <TableCell onClick={e => e.stopPropagation()}>
                        {canManage ? (
                          <Select value={t.status} onValueChange={v => updateTask.mutate({ id: t.id, status: v })}>
                            <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {TASK_STATUSES.map(s => <SelectItem key={s} value={s}>{TASK_STATUS_LABELS[s]}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant="outline">{TASK_STATUS_LABELS[t.status] ?? t.status}</Badge>
                        )}
                      </TableCell>
                      <TableCell><Badge variant="outline" className="capitalize">{t.priority ?? "medium"}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {t.dueDate ? new Date(t.dueDate).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" title="View details"
                            onClick={() => setDetailTaskId(t.id)}>
                            <Eye className="h-4 w-4" />
                          </Button>
                          {/* Delete only with manage permission (and disabled for Rejected
                              clients, where canManage is already false → read-only history). */}
                          {canManage && (
                            <Button variant="ghost" size="sm" className="text-destructive"
                              onClick={() => deleteTask.mutate({ id: t.id })} disabled={deleteTask.isPending}>
                              <Trash2 className="h-4 w-4" />
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

      <ClientTaskDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        clientId={clientId}
        clientName={clientName}
        matters={matters}
      />

      <TaskDetailDialog
        taskId={detailTaskId}
        open={detailTaskId != null}
        onClose={() => setDetailTaskId(null)}
      />
    </div>
  );
}

function ClientTaskDialog({
  open, onClose, clientId, clientName, matters, defaultMatterId,
}: {
  open: boolean; onClose: () => void; clientId: number; clientName: string;
  matters: any[]; defaultMatterId?: number;
}) {
  const utils = trpc.useUtils();
  const { data: lawyers = [] } = trpc.users.assignableLawyers.useQuery();
  const blank = {
    title: "", description: "", status: "todo", priority: "medium",
    clientMatterId: defaultMatterId ? String(defaultMatterId) : NO_MATTER,
    assignedTo: "", dueDate: "",
  };
  const [form, setForm] = useState(blank);

  const create = trpc.tasks.create.useMutation({
    onSuccess: () => {
      toast.success("Task created");
      utils.tasks.list.invalidate();
      setForm(blank);
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const openMatters = matters.filter(isOpenMatter);

  function submit() {
    if (!form.title.trim()) { toast.error("Task title is required"); return; }
    create.mutate({
      clientId, // client is fixed from context (read-only in the form)
      title: form.title.trim(),
      description: form.description.trim() || undefined,
      status: form.status,
      priority: form.priority,
      clientMatterId: form.clientMatterId !== NO_MATTER ? Number(form.clientMatterId) : undefined,
      assignedTo: form.assignedTo ? Number(form.assignedTo) : undefined,
      dueDate: form.dueDate || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New Task</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {/* Client — read-only when creating from the client page */}
          <div>
            <Label className="text-xs">Client</Label>
            <Input value={clientName} readOnly disabled className="bg-muted" />
          </div>
          <div>
            <Label className="text-xs">Title *</Label>
            <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          </div>
          <div>
            <Label className="text-xs">Description</Label>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Matter</Label>
              <Select value={form.clientMatterId} onValueChange={v => setForm(f => ({ ...f, clientMatterId: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MATTER}>N/A — No matter yet</SelectItem>
                  {openMatters.map(m => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.matterReference ?? m.originalSerial ?? `Matter #${m.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Assignee</Label>
              <Select value={form.assignedTo || "none"} onValueChange={v => setForm(f => ({ ...f, assignedTo: v === "none" ? "" : v }))}>
                <SelectTrigger><SelectValue placeholder="— Unassigned —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Unassigned —</SelectItem>
                  {lawyers.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name ?? `User #${l.id}`}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Priority</Label>
              <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TASK_PRIORITIES.map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Due Date</Label>
              <Input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={create.isPending}>Create Task</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Related tasks for a single matter (used on the matter detail/edit dialog). */
export function RelatedTasks({ clientMatterId }: { clientMatterId: number }) {
  const { data: tasks = [] } = trpc.tasks.list.useQuery({ clientMatterId });
  if (tasks.length === 0) {
    return <p className="text-xs text-muted-foreground">No related tasks.</p>;
  }
  return (
    <div className="space-y-1.5">
      {(tasks as any[]).map(t => (
        <div key={t.id} className="flex items-center justify-between text-sm border rounded px-2 py-1.5">
          <span className="truncate">{t.title}</span>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className="text-xs">{TASK_STATUS_LABELS[t.status] ?? t.status}</Badge>
            {t.assigneeName && <span className="text-xs text-muted-foreground">{t.assigneeName}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
