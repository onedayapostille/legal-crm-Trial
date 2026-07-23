import { useState } from "react";
import { Link } from "wouter";
import { Plus, CheckCircle2, Clock, AlertCircle, Circle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TaskDetailDialog } from "@/components/TaskDetailDialog";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { hasPermission } from "@shared/const";

const STATUS_OPTIONS = ["all", "todo", "in_progress", "done", "cancelled"];
const PRIORITY_LABELS: Record<string, { label: string; color: string }> = {
  low:    { label: "Low",    color: "bg-gray-100 text-gray-600" },
  medium: { label: "Medium", color: "bg-blue-100 text-blue-700" },
  high:   { label: "High",   color: "bg-orange-100 text-orange-700" },
  urgent: { label: "Urgent", color: "bg-red-100 text-red-700" },
};
const STATUS_LABELS: Record<string, string> = {
  todo: "To Do", in_progress: "In Progress", done: "Done", cancelled: "Cancelled",
};
const STATUS_BADGE: Record<string, string> = {
  todo: "bg-gray-100 text-gray-700",
  in_progress: "bg-blue-100 text-blue-700",
  done: "bg-green-100 text-green-700",
  cancelled: "bg-zinc-100 text-zinc-500",
};
// Friendly label for a task's source/provenance (action_log, Call, Meeting, …).
const SOURCE_LABELS: Record<string, string> = {
  action_log: "Action Log", call: "Call", meeting: "Meeting",
  email: "Email", document: "Document", follow_up: "Follow-up",
  financial_review: "Financial Review",
};
const sourceLabel = (s?: string | null) =>
  s ? (SOURCE_LABELS[s.toLowerCase()] ?? s.replace(/_/g, " ")) : "";

function StatusIcon({ status }: { status: string }) {
  if (status === "done") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === "in_progress") return <Clock className="h-4 w-4 text-blue-500" />;
  if (status === "cancelled") return <Circle className="h-4 w-4 text-gray-400" />;
  return <Circle className="h-4 w-4 text-muted-foreground" />;
}

export default function TaskList() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const utils = trpc.useUtils();
  const { user } = useAuth();
  // tasks:view grants read-only visibility (e.g. Manager); mutations need tasks:manage.
  const canManageTasks = hasPermission(user?.role, "tasks:manage");

  const { data: tasks = [], isLoading } = trpc.tasks.list.useQuery(
    statusFilter !== "all" ? { status: statusFilter } : {}
  );

  const updateTask = trpc.tasks.update.useMutation({
    onSuccess: () => utils.tasks.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const deleteTask = trpc.tasks.delete.useMutation({
    onSuccess: () => { utils.tasks.list.invalidate(); toast.success("Task deleted"); },
    onError: (e) => toast.error(e.message),
  });

  const markDone = (id: number) => updateTask.mutate({ id, status: "done" });

  const overdue = tasks.filter(t => t.status !== "done" && t.dueDate && new Date(t.dueDate) < new Date());

  return (
    <DashboardLayout>
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Tasks</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {tasks.length} task{tasks.length !== 1 ? "s" : ""}
              {overdue.length > 0 && <span className="text-orange-500 ml-2">· {overdue.length} overdue</span>}
            </p>
          </div>
          {canManageTasks && (
            <Link href="/tasks/new">
              <Button size="sm"><Plus className="h-4 w-4 mr-1" /> New Task</Button>
            </Link>
          )}
        </div>

        <div className="flex gap-3 items-center">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map(s => (
                <SelectItem key={s} value={s}>{s === "all" ? "All statuses" : s.replace("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}><CardContent className="py-4"><div className="h-8 animate-pulse bg-muted rounded" /></CardContent></Card>
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              No tasks found.
              {canManageTasks && (
                <>
                  {" "}
                  <Link href="/tasks/new" className="text-blue-600 hover:underline">Create one</Link>
                </>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {tasks.map(task => {
              const isOverdue = task.status !== "done" && task.dueDate && new Date(task.dueDate) < new Date();
              const pri = PRIORITY_LABELS[task.priority ?? "medium"];
              return (
                <Card key={task.id} className={`hover:shadow-sm transition-shadow ${task.status === "done" ? "opacity-60" : ""}`}>
                  <CardContent className="py-3 px-4">
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => canManageTasks && task.status !== "done" && markDone(task.id)}
                        className="mt-0.5 flex-shrink-0"
                        disabled={!canManageTasks || task.status === "done"}
                      >
                        <StatusIcon status={task.status ?? "todo"} />
                      </button>

                      <button
                        type="button"
                        onClick={() => setDetailTaskId(task.id)}
                        className="flex-1 min-w-0 text-left"
                        title="View task details"
                      >
                        <p className={`font-medium text-sm ${task.status === "done" ? "line-through text-muted-foreground" : ""}`}>
                          {task.title}
                        </p>
                        {task.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{task.description}</p>
                        )}
                        {/* Client / matter context — same record shown on the client tab */}
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap text-xs">
                          {(task as any).clientName ? (
                            <Badge variant="secondary" className="font-normal">
                              {(task as any).clientName}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="font-normal text-muted-foreground">No client</Badge>
                          )}
                          {(task as any).clientMatterId ? (
                            <Badge variant="outline" className="font-normal">
                              {(task as any).matterReference ?? "Matter"}
                              {(task as any).matterType ? ` · ${(task as any).matterType}` : ""}
                            </Badge>
                          ) : (
                            (task as any).clientName && <span className="text-muted-foreground">Client-level</span>
                          )}
                          {task.sourceType && (
                            <Badge variant="outline" className="font-normal capitalize bg-amber-50 text-amber-700 border-amber-200">
                              {sourceLabel(task.sourceType)}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[task.status ?? "todo"]}`}>
                            {STATUS_LABELS[task.status ?? "todo"] ?? task.status}
                          </span>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${pri?.color}`}>
                            {pri?.label}
                          </span>
                          {(task as any).assigneeName && (
                            <span className="text-xs text-muted-foreground">· {(task as any).assigneeName}</span>
                          )}
                          {task.dueDate && (
                            <span className={`text-xs flex items-center gap-1 ${isOverdue ? "text-orange-500" : "text-muted-foreground"}`}>
                              {isOverdue && <AlertCircle className="h-3 w-3" />}
                              {new Date(task.dueDate).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </button>

                      {canManageTasks && (
                        <button
                          onClick={() => deleteTask.mutate({ id: task.id })}
                          className="text-xs text-muted-foreground hover:text-red-500 flex-shrink-0"
                          title="Delete task"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <TaskDetailDialog
        taskId={detailTaskId}
        open={detailTaskId != null}
        onClose={() => setDetailTaskId(null)}
      />
    </DashboardLayout>
  );
}
