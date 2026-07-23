import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useForm } from "react-hook-form";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/_core/hooks/useAuth";

type TaskFormData = {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  dueDate?: string;
};

const NO_MATTER = "none";
const NO_ASSIGNEE = "none";

export default function TaskForm() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  // Allow prefilling the client via ?clientId= (e.g. "New Task" from a client).
  const search = useSearch();
  const presetClientId = new URLSearchParams(search).get("clientId") ?? "";

  const [clientId, setClientId] = useState<string>(presetClientId);
  const [clientMatterId, setClientMatterId] = useState<string>(NO_MATTER);
  const [assignedTo, setAssignedTo] = useState<string>(NO_ASSIGNEE);

  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<TaskFormData>({
    defaultValues: { status: "todo", priority: "medium" },
  });

  // A task must belong to a client — pick from active (non-rejected) clients.
  const { data: clients = [] } = trpc.clients.list.useQuery({});
  const selectableClients = clients.filter((c: any) => c.clientStatus !== "Rejected");
  const { data: matters = [] } = trpc.clientMatters.list.useQuery(
    { clientId: Number(clientId) },
    { enabled: !!clientId },
  );
  // Task-assignment authority (BR-10): the server returns the assignee
  // directory only for roles that may assign tasks to others (or lead a
  // matter). Everyone else can only create tasks for themselves.
  const { user } = useAuth();
  const { data: assignees = [] } = trpc.users.assignees.useQuery();
  const canAssignOthers = assignees.length > 0;
  const assigneeOptions = canAssignOthers
    ? assignees
    : user
      ? [{ id: user.id, name: user.name, email: user.email, role: user.role }]
      : [];

  const createTask = trpc.tasks.create.useMutation({
    onSuccess: () => {
      toast.success("Task created successfully");
      // Single source of truth: invalidating tasks.list refreshes the main Tasks
      // page, every client tab, and the dashboard task widget at once.
      utils.tasks.list.invalidate();
      navigate("/tasks");
    },
    onError: (error) => toast.error(`Failed to create task: ${error.message}`),
  });

  const onSubmit = (data: TaskFormData) => {
    if (!clientId) {
      toast.error("Please select a client — tasks must be linked to a client.");
      return;
    }
    createTask.mutate({
      ...data,
      clientId: Number(clientId),
      clientMatterId: clientMatterId !== NO_MATTER ? Number(clientMatterId) : undefined,
      assignedTo: assignedTo !== NO_ASSIGNEE ? Number(assignedTo) : undefined,
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-3xl">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate("/tasks")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Tasks
          </Button>
          <div>
            <h1 className="text-3xl font-bold text-gray-900">New Task</h1>
            <p className="text-gray-600 mt-1">Create a follow-up or internal work item</p>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Task Details</CardTitle>
              <CardDescription>Every task is linked to a client; optionally to one of its matters</CardDescription>
            </CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-4">
              {/* Client — required */}
              <div className="space-y-2">
                <Label>Client *</Label>
                <Select value={clientId} onValueChange={(v) => { setClientId(v); setClientMatterId(NO_MATTER); }}>
                  <SelectTrigger><SelectValue placeholder="Select a client" /></SelectTrigger>
                  <SelectContent>
                    {selectableClients.map((c: any) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.clientName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!clientId && <p className="text-xs text-muted-foreground">A task must be linked to a client.</p>}
              </div>

              {/* Matter — optional, scoped to the selected client */}
              <div className="space-y-2">
                <Label>Matter (optional)</Label>
                <Select value={clientMatterId} onValueChange={setClientMatterId} disabled={!clientId}>
                  <SelectTrigger><SelectValue placeholder="Client-level task" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_MATTER}>Client-level task (no matter)</SelectItem>
                    {matters.map((m: any) => (
                      <SelectItem key={m.id} value={String(m.id)}>
                        {m.matterReference ?? m.originalSerial ?? `Matter #${m.id}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="title">Title *</Label>
                <Input id="title" {...register("title", { required: true })} />
                {errors.title && <p className="text-sm text-red-600">Title is required</p>}
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="description">Description</Label>
                <Textarea id="description" rows={4} {...register("description")} />
              </div>

              <div className="space-y-2">
                <Label>Assignee (optional)</Label>
                <Select value={assignedTo} onValueChange={setAssignedTo}>
                  <SelectTrigger><SelectValue placeholder="— Unassigned —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_ASSIGNEE}>— Unassigned —</SelectItem>
                    {assigneeOptions.map((l: any) => (
                      <SelectItem key={l.id} value={String(l.id)}>{l.name ?? `User #${l.id}`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!canAssignOthers && (
                  <p className="text-xs text-muted-foreground">
                    Your role can only assign tasks to yourself.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={watch("status")} onValueChange={(value) => setValue("status", value)}>
                  <SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todo">To do</SelectItem>
                    <SelectItem value="in_progress">In progress</SelectItem>
                    <SelectItem value="done">Done</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={watch("priority")} onValueChange={(value) => setValue("priority", value)}>
                  <SelectTrigger><SelectValue placeholder="Select priority" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="dueDate">Due Date</Label>
                <Input id="dueDate" type="date" {...register("dueDate")} />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" onClick={() => navigate("/tasks")}>
              Cancel
            </Button>
            <Button type="submit" disabled={createTask.isPending || !clientId}>
              {createTask.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <Save className="h-4 w-4 mr-2" />
              Create Task
            </Button>
          </div>
        </form>
      </div>
    </DashboardLayout>
  );
}
