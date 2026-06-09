/**
 * LawyerRatesDialog — Hourly Rate section for a Billable Hours matter.
 *
 *  - Primary Lawyer: read-only, populated from the matter's assigned lead lawyer
 *    (a real user). Reassignment is a controlled action restricted to Admin/Partner.
 *  - Co-Lawyers: populated from assigned users (never free text). Each shows name,
 *    role, and hourly rate (when set). Add/edit/remove per-lawyer rates.
 *
 * All lawyer identities come from the users table; names cannot be typed freely.
 */

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Pencil, Trash2, Plus, Clock, Check, X, UserCog, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";

interface LawyerRatesDialogProps {
  open: boolean;
  onClose: () => void;
  matter: { id: number; matterReference?: string | null; billingType?: string | null };
}

interface RateFormState {
  role: string;
  hourlyRate: string;
  currency: string;
  isActive: boolean;
  effectiveDate: string;
  notes: string;
}

const DEFAULT_RATE_FORM: RateFormState = {
  role: "", hourlyRate: "", currency: "SAR", isActive: true, effectiveDate: "", notes: "",
};

function fmtRate(v: string | null | undefined, currency: string | null | undefined) {
  if (v == null) return "—";
  return `${Number(v).toLocaleString("en-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`;
}

export function LawyerRatesDialog({ open, onClose, matter }: LawyerRatesDialogProps) {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const canAssignLead = user?.role === "admin" || user?.role === "partner";

  // ── Data ─────────────────────────────────────────────────────────────────
  const { data: billable, isLoading } = trpc.clientMatters.billableLawyers.useQuery(
    { clientMatterId: matter.id },
    { enabled: open },
  );
  const { data: assignable = [] } = trpc.users.assignableLawyers.useQuery(undefined, { enabled: open });

  const lead = billable?.lead ?? null;
  const coLawyers = billable?.coLawyers ?? [];

  // Users not already assigned (exclude lead + existing co-lawyers) for the picker.
  const assignedIds = new Set<number>(
    [lead?.userId, ...coLawyers.map(c => c.userId)].filter((v): v is number => v != null),
  );
  const addableUsers = assignable.filter(u => !assignedIds.has(u.id));

  // ── Local UI state ───────────────────────────────────────────────────────
  const [reassigning, setReassigning] = useState(false);
  const [reassignUserId, setReassignUserId] = useState<string>("");

  const [addingNew, setAddingNew] = useState(false);
  const [addUserId, setAddUserId] = useState<string>("");
  const [addForm, setAddForm] = useState<RateFormState>(DEFAULT_RATE_FORM);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<RateFormState>(DEFAULT_RATE_FORM);

  const invalidate = () => {
    utils.clientMatters.billableLawyers.invalidate({ clientMatterId: matter.id });
    utils.matterLawyerRates.list.invalidate({ clientMatterId: matter.id });
    utils.clientMatters.list.invalidate();
    utils.clientMatters.listAll.invalidate();
  };

  // ── Mutations ────────────────────────────────────────────────────────────
  const reassign = trpc.clientMatters.reassignLeadLawyer.useMutation({
    onSuccess: () => { toast.success("Lead lawyer reassigned"); setReassigning(false); setReassignUserId(""); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const createRate = trpc.matterLawyerRates.create.useMutation({
    onSuccess: () => { toast.success("Co-lawyer added"); setAddingNew(false); setAddUserId(""); setAddForm(DEFAULT_RATE_FORM); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const updateRate = trpc.matterLawyerRates.update.useMutation({
    onSuccess: () => { toast.success("Rate updated"); setEditingId(null); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const deleteRate = trpc.matterLawyerRates.delete.useMutation({
    onSuccess: () => { toast.success("Co-lawyer removed"); invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  // ── Handlers ─────────────────────────────────────────────────────────────
  function handleReassign() {
    if (!reassignUserId) { toast.error("Select a lawyer"); return; }
    reassign.mutate({ clientMatterId: matter.id, userId: Number(reassignUserId) });
  }

  function handleAdd() {
    if (!addUserId) { toast.error("Select a lawyer"); return; }
    const n = Number(addForm.hourlyRate);
    if (addForm.hourlyRate.trim() === "" || !Number.isFinite(n) || n < 0) {
      toast.error("Hourly rate must be a valid number ≥ 0."); return;
    }
    createRate.mutate({
      clientMatterId: matter.id,
      userId: Number(addUserId),
      role: addForm.role.trim() || undefined,
      hourlyRate: addForm.hourlyRate.trim(),
      currency: addForm.currency.trim() || "SAR",
      isActive: addForm.isActive,
      effectiveDate: addForm.effectiveDate || undefined,
      notes: addForm.notes.trim() || undefined,
    });
  }

  function startEdit(co: typeof coLawyers[number]) {
    setEditingId(co.rateId);
    setAddingNew(false);
    setEditForm({
      role: co.role ?? "",
      hourlyRate: co.hourlyRate ?? "",
      currency: co.currency ?? "SAR",
      isActive: co.isActive,
      effectiveDate: "",
      notes: "",
    });
  }

  function handleUpdate() {
    if (editingId === null) return;
    const n = Number(editForm.hourlyRate);
    if (editForm.hourlyRate.trim() === "" || !Number.isFinite(n) || n < 0) {
      toast.error("Hourly rate must be a valid number ≥ 0."); return;
    }
    updateRate.mutate({
      id: editingId,
      role: editForm.role.trim() || undefined,
      hourlyRate: editForm.hourlyRate.trim(),
      currency: editForm.currency.trim() || "SAR",
      isActive: editForm.isActive,
      effectiveDate: editForm.effectiveDate || null,
      notes: editForm.notes.trim() || undefined,
    });
  }

  const matterLabel = matter.matterReference ?? `Matter #${matter.id}`;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-blue-500" />
            Hourly Lawyer Rates — {matterLabel}
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Lawyers are linked to user accounts — names cannot be typed freely.
          </p>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-muted-foreground text-sm">Loading…</div>
        ) : (
          <div className="space-y-6">
            {/* ── Primary Lawyer ───────────────────────────────────────── */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-primary" /> Primary (Lead) Lawyer
                </h3>
                {canAssignLead && !reassigning && (
                  <Button variant="outline" size="sm" onClick={() => setReassigning(true)}>
                    <UserCog className="h-4 w-4 mr-1" /> Reassign Lead Lawyer
                  </Button>
                )}
              </div>

              <div className="rounded-lg border p-3 bg-muted/20">
                {lead ? (
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <p className="font-medium text-sm">
                        {lead.name}
                        {lead.userId == null && (
                          <span className="ml-2 text-xs text-amber-600">(legacy — not linked to a user)</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground capitalize">{lead.role ?? "—"}</p>
                    </div>
                    <Badge variant="outline" className="font-mono">{fmtRate(lead.hourlyRate, lead.currency)}/hr</Badge>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No lead lawyer assigned.</p>
                )}

                {reassigning && (
                  <div className="mt-3 flex items-end gap-2 border-t pt-3">
                    <div className="flex-1">
                      <Label className="text-xs">New Lead Lawyer</Label>
                      <Select value={reassignUserId} onValueChange={setReassignUserId}>
                        <SelectTrigger className="h-8 text-sm mt-1"><SelectValue placeholder="Select a lawyer…" /></SelectTrigger>
                        <SelectContent>
                          {assignable.map(u => (
                            <SelectItem key={u.id} value={String(u.id)}>
                              {u.name ?? `User #${u.id}`} · <span className="capitalize">{u.role}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button size="sm" onClick={handleReassign} disabled={reassign.isPending}>
                      <Check className="h-3 w-3 mr-1" /> Save
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => { setReassigning(false); setReassignUserId(""); }} disabled={reassign.isPending}>
                      <X className="h-3 w-3 mr-1" /> Cancel
                    </Button>
                  </div>
                )}
              </div>
              {!canAssignLead && (
                <p className="text-xs text-muted-foreground">Only an Admin or Partner can reassign the lead lawyer.</p>
              )}
            </section>

            {/* ── Co-Lawyers ───────────────────────────────────────────── */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Co-Lawyers</h3>

              {coLawyers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No co-lawyers assigned to this matter.</p>
              ) : (
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Lawyer</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead className="text-right">Hourly Rate</TableHead>
                        <TableHead>Active</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {coLawyers.map(co => (
                        editingId === co.rateId ? (
                          <TableRow key={co.rateId}>
                            <TableCell colSpan={5} className="p-3 bg-muted/30">
                              <div className="space-y-2">
                                <p className="text-sm font-medium">{co.name}</p>
                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <Label className="text-xs">Role</Label>
                                    <Input value={editForm.role} onChange={e => setEditForm({ ...editForm, role: e.target.value })} className="h-8 text-sm mt-1" />
                                  </div>
                                  <div>
                                    <Label className="text-xs">Hourly Rate *</Label>
                                    <Input value={editForm.hourlyRate} onChange={e => setEditForm({ ...editForm, hourlyRate: e.target.value })} inputMode="decimal" className="h-8 text-sm mt-1" />
                                  </div>
                                  <div>
                                    <Label className="text-xs">Currency</Label>
                                    <Input value={editForm.currency} onChange={e => setEditForm({ ...editForm, currency: e.target.value })} maxLength={10} className="h-8 text-sm mt-1" />
                                  </div>
                                  <div className="flex items-end gap-2 pb-1">
                                    <Label className="text-xs mb-1">Active</Label>
                                    <Switch checked={editForm.isActive} onCheckedChange={v => setEditForm({ ...editForm, isActive: v })} />
                                  </div>
                                </div>
                                <div className="flex justify-end gap-2">
                                  <Button size="sm" variant="outline" onClick={() => setEditingId(null)} disabled={updateRate.isPending}><X className="h-3 w-3 mr-1" />Cancel</Button>
                                  <Button size="sm" onClick={handleUpdate} disabled={updateRate.isPending}><Check className="h-3 w-3 mr-1" />Save</Button>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : (
                          <TableRow key={co.rateId} className={!co.isActive ? "opacity-50" : undefined}>
                            <TableCell className="font-medium">{co.name}</TableCell>
                            <TableCell className="text-muted-foreground capitalize">{co.role ?? "—"}</TableCell>
                            <TableCell className="text-right font-mono">{fmtRate(co.hourlyRate, co.currency)}</TableCell>
                            <TableCell>
                              <Badge variant={co.isActive ? "default" : "secondary"}>{co.isActive ? "Active" : "Inactive"}</Badge>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Button variant="ghost" size="sm" onClick={() => startEdit(co)} disabled={deleteRate.isPending}><Pencil className="h-4 w-4" /></Button>
                                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => co.rateId != null && deleteRate.mutate({ id: co.rateId })} disabled={deleteRate.isPending}><Trash2 className="h-4 w-4" /></Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Add co-lawyer form */}
              {addingNew ? (
                <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Lawyer (assigned user) *</Label>
                      <Select value={addUserId} onValueChange={setAddUserId}>
                        <SelectTrigger className="h-8 text-sm mt-1">
                          <SelectValue placeholder={addableUsers.length ? "Select a lawyer…" : "No more users available"} />
                        </SelectTrigger>
                        <SelectContent>
                          {addableUsers.map(u => (
                            <SelectItem key={u.id} value={String(u.id)}>
                              {u.name ?? `User #${u.id}`} · <span className="capitalize">{u.role}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Role (optional)</Label>
                      <Input value={addForm.role} onChange={e => setAddForm({ ...addForm, role: e.target.value })} placeholder="defaults to user role" className="h-8 text-sm mt-1" />
                    </div>
                    <div>
                      <Label className="text-xs">Hourly Rate *</Label>
                      <Input value={addForm.hourlyRate} onChange={e => setAddForm({ ...addForm, hourlyRate: e.target.value })} placeholder="e.g. 500" inputMode="decimal" className="h-8 text-sm mt-1" />
                    </div>
                    <div>
                      <Label className="text-xs">Currency</Label>
                      <Input value={addForm.currency} onChange={e => setAddForm({ ...addForm, currency: e.target.value })} maxLength={10} className="h-8 text-sm mt-1" />
                    </div>
                    <div>
                      <Label className="text-xs">Effective Date</Label>
                      <Input type="date" value={addForm.effectiveDate} onChange={e => setAddForm({ ...addForm, effectiveDate: e.target.value })} className="h-8 text-sm mt-1" />
                    </div>
                    <div className="flex items-end gap-2 pb-1">
                      <Label className="text-xs mb-1">Active</Label>
                      <Switch checked={addForm.isActive} onCheckedChange={v => setAddForm({ ...addForm, isActive: v })} />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => { setAddingNew(false); setAddUserId(""); setAddForm(DEFAULT_RATE_FORM); }} disabled={createRate.isPending}><X className="h-3 w-3 mr-1" />Cancel</Button>
                    <Button size="sm" onClick={handleAdd} disabled={createRate.isPending || !addUserId}><Check className="h-3 w-3 mr-1" />Add Co-Lawyer</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => { setAddingNew(true); setEditingId(null); }} disabled={addableUsers.length === 0}>
                  <Plus className="h-4 w-4 mr-1" /> Add Co-Lawyer
                </Button>
              )}
            </section>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
