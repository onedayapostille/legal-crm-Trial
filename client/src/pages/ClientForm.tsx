import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Save, Trash2, AlertCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import DashboardLayout from "@/components/DashboardLayout";
import { toast } from "sonner";
import ClientDetail from "./ClientDetail";

type Props = { id?: number };

export default function ClientForm({ id }: Props) {
  if (id) return <ClientDetail id={id} />;
  return <NewClientForm />;
}

function NewClientForm() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [form, setForm] = useState({
    clientName: "",
    clientStatus: "Leads" as "Existing Client" | "Leads" | "Rejected",
    clientNumber: "",
    fileNumber: "",
    city: "" as "" | "Riyadh" | "Dammam" | "Jeddah",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const createClient = trpc.clients.create.useMutation({
    onSuccess: (client) => {
      toast.success("Client created successfully");
      // Refresh every cache that reflects the new client so the Leads Pipeline,
      // the Recent Leads widget, and the client list update without a manual
      // refresh. Refetch (not optimistic merge) → no duplicate rows.
      utils.dashboard.stats.invalidate();
      utils.clients.list.invalidate();
      utils.clients.recentLeads.invalidate();
      utils.clients.statusCounts.invalidate();
      utils.clients.dashboardStats.invalidate();
      utils.clients.conversionMetrics.invalidate();
      navigate(`/clients/${client.id}`);
    },
    onError: (err) => toast.error(err.message),
  });

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!form.clientName.trim()) errs.clientName = "Client name is required";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    createClient.mutate({
      clientName: form.clientName,
      clientStatus: form.clientStatus,
      clientNumber: form.clientNumber || undefined,
      fileNumber: form.fileNumber || undefined,
      city: form.city || undefined,
      // Matter Type is intentionally NOT set here: it is authoritative at the
      // matter level (each matter chooses its own type), so the master client
      // record no longer carries a conflicting client-wide type. (CRM-006)
    });
  };

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/clients")}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Add New Client</h1>
            <p className="text-sm text-muted-foreground">Create a client record in the AlGhazzawi registry</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Client Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField label="Client Name *" error={errors.clientName}>
                <Input
                  value={form.clientName}
                  onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))}
                  placeholder="Enter full client name"
                />
              </FormField>

              <div className="grid grid-cols-2 gap-4">
                <FormField label="Client Number">
                  <Input
                    value={form.clientNumber}
                    onChange={e => setForm(f => ({ ...f, clientNumber: e.target.value }))}
                    placeholder="e.g. C-0001"
                  />
                </FormField>
                <FormField label="File Number">
                  <Input
                    value={form.fileNumber}
                    onChange={e => setForm(f => ({ ...f, fileNumber: e.target.value }))}
                    placeholder="e.g. F-2025-001"
                  />
                </FormField>
              </div>

              <FormField label="Client Status *">
                <Select
                  value={form.clientStatus}
                  onValueChange={v => setForm(f => ({ ...f, clientStatus: v as any }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Existing Client">Existing Client</SelectItem>
                    <SelectItem value="Leads">Leads</SelectItem>
                    <SelectItem value="Rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>

              <FormField label="City">
                <Select
                  value={form.city || "none"}
                  onValueChange={v => setForm(f => ({ ...f, city: v === "none" ? "" : v as any }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select city" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not specified</SelectItem>
                    <SelectItem value="Riyadh">Riyadh</SelectItem>
                    <SelectItem value="Dammam">Dammam</SelectItem>
                    <SelectItem value="Jeddah">Jeddah</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              {/* Matter Type is chosen per matter (Matter form), not on the master
                  client — see CRM-006. */}
            </CardContent>
          </Card>

          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => navigate("/clients")}>
              Cancel
            </Button>
            <Button type="submit" disabled={createClient.isPending}>
              <Save className="h-4 w-4 mr-2" />
              {createClient.isPending ? "Saving…" : "Create Client"}
            </Button>
          </div>
        </form>
      </div>
    </DashboardLayout>
  );
}

function FormField({
  label, children, error,
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {error && (
        <p className="text-sm text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}
    </div>
  );
}
