import { Link } from "wouter";
import {
  Briefcase, User, UserCircle, CalendarClock, CalendarPlus, Clock,
  Flag, CircleDot, ExternalLink, FileText, Link2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "To Do", in_progress: "In Progress", done: "Done", cancelled: "Cancelled",
};
const PRIORITY_COLORS: Record<string, string> = {
  low:    "bg-gray-100 text-gray-700",
  medium: "bg-blue-100 text-blue-700",
  high:   "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};
const STATUS_COLORS: Record<string, string> = {
  todo:        "bg-gray-100 text-gray-700",
  in_progress: "bg-blue-100 text-blue-700",
  done:        "bg-green-100 text-green-700",
  cancelled:   "bg-zinc-100 text-zinc-500",
};

// Human label for the provenance of a task (Action Log, Call, Meeting, …).
const SOURCE_LABELS: Record<string, string> = {
  action_log:       "Action Log",
  call:             "Call",
  meeting:          "Meeting",
  email:            "Email",
  follow_up:        "Follow-up",
  financial_review: "Financial Review",
};
const sourceLabel = (s?: string | null) =>
  s ? (SOURCE_LABELS[s] ?? s.replace(/_/g, " ")) : null;

const fmtDate = (v: string | Date | null | undefined) =>
  v ? new Date(v).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
const fmtDateTime = (v: string | Date | null | undefined) =>
  v ? new Date(v).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

function Row({ icon: Icon, label, children }: { icon: any; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="text-sm">{children}</div>
      </div>
    </div>
  );
}

/**
 * Read-only Task Details modal. Fetches the fully-joined task via tasks.get
 * (backend enforces role-based visibility — an unauthorized viewer gets a
 * "not available" state, never leaked data). Shows whether the task is a
 * client-level or matter-level task, with clickable links into the related
 * client / matter and back to its source Action Log entry when present.
 */
export function TaskDetailDialog({
  taskId, open, onClose,
}: { taskId: number | null; open: boolean; onClose: () => void }) {
  const { data: task, isLoading, isError } = trpc.tasks.get.useQuery(
    { id: taskId as number },
    { enabled: open && taskId != null },
  );

  const isMatterLevel = !!task?.clientMatterId;
  const hasClient = task?.clientId != null;
  const src = sourceLabel(task?.sourceType);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        {isLoading ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : isError || !task ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <DialogHeader>
              <DialogTitle className="text-base">Task details unavailable</DialogTitle>
              <DialogDescription>
                This task doesn’t exist or you don’t have permission to view it.
              </DialogDescription>
            </DialogHeader>
          </div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={STATUS_COLORS[task.status ?? "todo"]}>
                  {TASK_STATUS_LABELS[task.status ?? "todo"] ?? task.status}
                </Badge>
                <Badge variant="outline" className={`capitalize ${PRIORITY_COLORS[task.priority ?? "medium"]}`}>
                  {task.priority ?? "medium"}
                </Badge>
                {/* Client-level vs matter-level context tag */}
                <Badge variant="secondary" className="font-normal">
                  {isMatterLevel ? "Matter-level task" : "Client-level task"}
                </Badge>
              </div>
              <DialogTitle className="text-lg mt-2">{task.title}</DialogTitle>
            </DialogHeader>

            {/* Description / notes */}
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm whitespace-pre-wrap">
              {task.description?.trim()
                ? task.description
                : <span className="text-muted-foreground">No description provided.</span>}
            </div>

            <Separator />

            {/* Related context: client + (optional) matter */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Related to</p>
              {hasClient ? (
                <div className="space-y-2">
                  <Row icon={UserCircle} label="Client">
                    <Link href={`/clients/${task.clientId}`} className="text-blue-600 hover:underline inline-flex items-center gap-1">
                      {task.clientName ?? `Client #${task.clientId}`}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                    {task.clientStatus === "Rejected" && (
                      <Badge variant="outline" className="ml-2 bg-red-50 text-red-700 border-red-200">Rejected — read only</Badge>
                    )}
                  </Row>
                  {isMatterLevel ? (
                    <>
                      <Row icon={Briefcase} label="Matter">
                        <Link href={`/clients/${task.clientId}?tab=matters`} className="text-blue-600 hover:underline inline-flex items-center gap-1">
                          {task.matterReference ?? `Matter #${task.clientMatterId}`}
                          <ExternalLink className="h-3 w-3" />
                        </Link>
                      </Row>
                      {task.matterType && <Row icon={CircleDot} label="Matter type">{task.matterType}</Row>}
                      {task.matterLeadPartner && <Row icon={User} label="Lead partner">{task.matterLeadPartner}</Row>}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground pl-7">Client-level task — not linked to a specific matter.</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">General task — not linked to a client.</p>
              )}
            </div>

            <Separator />

            {/* People + dates */}
            <div className="grid grid-cols-2 gap-x-4">
              <Row icon={User} label="Assigned to">{task.assigneeName ?? "Unassigned"}</Row>
              <Row icon={UserCircle} label="Created by">{task.creatorName ?? "—"}</Row>
              <Row icon={CalendarClock} label="Due date">{fmtDate(task.dueDate)}</Row>
              <Row icon={Flag} label="Priority"><span className="capitalize">{task.priority ?? "medium"}</span></Row>
              <Row icon={CalendarPlus} label="Created">{fmtDateTime(task.createdAt)}</Row>
              <Row icon={Clock} label="Last updated">{fmtDateTime(task.updatedAt)}</Row>
              {task.completedAt && <Row icon={CircleDot} label="Completed">{fmtDateTime(task.completedAt)}</Row>}
            </div>

            {/* Source / provenance */}
            {(src || task.actionLogId) && (
              <>
                <Separator />
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Source</p>
                  <Row icon={Link2} label="Created from">
                    {src ?? "Action Log"}
                    {task.actionLogType ? ` · ${task.actionLogType}` : ""}
                    {task.actionLogDate ? ` (${fmtDate(task.actionLogDate)})` : ""}
                  </Row>
                  {task.actionLogDetails && (
                    <Row icon={FileText} label="Source details">{task.actionLogDetails}</Row>
                  )}
                  {task.actionLogId && hasClient && (
                    <Link
                      href={`/clients/${task.clientId}?tab=actions`}
                      className="text-blue-600 hover:underline text-sm inline-flex items-center gap-1 pl-7"
                    >
                      Open related Action Log <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
