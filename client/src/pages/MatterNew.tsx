import { useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import DashboardLayout from "@/components/DashboardLayout";
import ConflictWarningDialog from "@/components/ConflictWarningDialog";
import type { ConflictMatch } from "@/components/ConflictMatchTable";
import { toast } from "sonner";

type Priority = "low" | "medium" | "high" | "urgent";

export default function MatterNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const { data: clients = [], isLoading: clientsLoading } = trpc.clients.list.useQuery({});

  const [clientId, setClientId] = useState<string>("");
  const [form, setForm] = useState({
    originalSerial: "", matterReference: "", matterType: "", leadPartner: "",
    leadPartnerFullName: "", supportLead: "", attorneyHead: "", attorney1: "",
    attorney2: "", attorney3: "", attorneyFullName: "",
    matterDescription: "", opposingParty: "", matterStatus: "",
    balanceWorkLeft: "", achievementPercentage: "", achievementStatus: "",
    priority: "medium" as Priority,
  });

  // Conflict check state: the matches awaiting acknowledgement, if any.
  const [pendingConflicts, setPendingConflicts] = useState<ConflictMatch[] | null>(null);
  const [checking, setChecking] = useState(false);

  const create = trpc.clientMatters.create.useMutation({
    onSuccess: (matter) => {
      toast.success("Matter created");
      navigate(`/clients/${matter.clientId}`);
    },
    onError: (e) => toast.error(e.message),
  });

  function buildPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      clientId: Number(clientId),
      priority: form.priority,
      ...extra,
    };
    for (const [k, v] of Object.entries(form)) {
      if (k === "priority") continue;
      if (typeof v === "string" && v.trim() !== "") payload[k] = v.trim();
    }
    return payload;
  }

  const submit = async () => {
    if (!clientId) {
      toast.error("Please select a client");
      return;
    }
    // Auto-run conflict check against matter name + opposing party.
    setChecking(true);
    try {
      const conflicts = await utils.clientMatters.checkConflicts.fetch({
        matterName: form.matterReference.trim() || undefined,
        opposingParty: form.opposingParty.trim() || undefined,
      });
      if (conflicts.length > 0) {
        setPendingConflicts(conflicts); // warn + require acknowledgement
        return;
      }
      create.mutate(buildPayload() as any);
    } catch (e: any) {
      toast.error(e?.message ?? "Conflict check failed");
    } finally {
      setChecking(false);
    }
  };

  const createAcknowledged = () => {
    create.mutate(buildPayload({ acknowledgeConflicts: true }) as any);
    setPendingConflicts(null);
  };

  return (
    <DashboardLayout>
      <div className="space-y-4 max-w-4xl">
        <div className="flex items-center gap-2">
          <Link href="/matters">
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" /> Back to Matters</Button>
          </Link>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>New Matter</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Client *</Label>
              <Select value={clientId} onValueChange={setClientId} disabled={clientsLoading}>
                <SelectTrigger>
                  <SelectValue placeholder={clientsLoading ? "Loading clients…" : "Select a client"} />
                </SelectTrigger>
                <SelectContent>
                  {clients.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.clientName}{c.clientNumber ? ` (${c.clientNumber})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Every matter belongs to a client.{" "}
                <Link href="/clients/new" className="text-blue-600 hover:underline">Create a new client</Link>{" "}
                if yours isn't listed.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
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
                ["opposingParty", "Opposing Party (for conflict check)"],
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
              <div>
                <Label className="text-xs">Priority</Label>
                <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v as Priority }))}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label className="text-xs">Description / Notes</Label>
                <Textarea
                  value={form.matterDescription}
                  onChange={e => setForm(f => ({ ...f, matterDescription: e.target.value }))}
                  rows={4}
                  className="text-sm"
                  placeholder="Long-form description, scope, instructions…"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Link href="/matters">
                <Button variant="outline">Cancel</Button>
              </Link>
              <Button onClick={submit} disabled={create.isPending || checking}>
                {checking ? "Checking conflicts…" : create.isPending ? "Creating…" : "Create Matter"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <ConflictWarningDialog
        open={pendingConflicts !== null}
        conflicts={pendingConflicts ?? []}
        isCreating={create.isPending}
        onCancel={() => setPendingConflicts(null)}
        onAcknowledge={createAcknowledged}
      />
    </DashboardLayout>
  );
}
