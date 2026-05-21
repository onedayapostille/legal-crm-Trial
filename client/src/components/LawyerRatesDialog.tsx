/**
 * LawyerRatesDialog
 *
 * Displays and manages hourly billing rates for a specific matter.
 * Only rendered when `matter.billingType === "Billable Hours"`.
 *
 * Features:
 *  - Table of existing lawyer rates (name, role, rate, currency, effective date, active)
 *  - Add new rate inline form
 *  - Edit existing rate (row turns into inline form)
 *  - Delete with confirmation
 *  - Validation: hourly rate must be numeric ≥ 0, lawyer name required
 */

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Pencil, Trash2, Plus, Clock, Check, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RateRow {
  id: number;
  lawyerName: string;
  role: string | null;
  hourlyRate: string;
  currency: string;
  isActive: boolean;
  effectiveDate: string | null;
  notes: string | null;
}

interface RateFormState {
  lawyerName: string;
  role: string;
  hourlyRate: string;
  currency: string;
  isActive: boolean;
  effectiveDate: string;
  notes: string;
}

const DEFAULT_FORM: RateFormState = {
  lawyerName: "",
  role: "",
  hourlyRate: "",
  currency: "SAR",
  isActive: true,
  effectiveDate: "",
  notes: "",
};

// ─── Validation ───────────────────────────────────────────────────────────────

function validateForm(form: RateFormState): string | null {
  if (!form.lawyerName.trim()) return "Lawyer name is required.";
  if (form.hourlyRate.trim() === "") return "Hourly rate is required.";
  const n = Number(form.hourlyRate);
  if (!Number.isFinite(n) || n < 0) return "Hourly rate must be a valid number ≥ 0.";
  return null;
}

// ─── Inline form (shared for add & edit) ────────────────────────────────────

function RateForm({
  form,
  setForm,
  onSave,
  onCancel,
  isSaving,
  saveLabel,
}: {
  form: RateFormState;
  setForm: (f: RateFormState) => void;
  onSave: () => void;
  onCancel: () => void;
  isSaving: boolean;
  saveLabel: string;
}) {
  return (
    <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Lawyer Name *</Label>
          <Input
            value={form.lawyerName}
            onChange={e => setForm({ ...form, lawyerName: e.target.value })}
            placeholder="e.g. Ahmed Al-Rashid"
            className="h-8 text-sm mt-1"
          />
        </div>
        <div>
          <Label className="text-xs">Role</Label>
          <Input
            value={form.role}
            onChange={e => setForm({ ...form, role: e.target.value })}
            placeholder="e.g. Senior Associate"
            className="h-8 text-sm mt-1"
          />
        </div>
        <div>
          <Label className="text-xs">Hourly Rate *</Label>
          <Input
            value={form.hourlyRate}
            onChange={e => setForm({ ...form, hourlyRate: e.target.value })}
            placeholder="e.g. 500"
            className="h-8 text-sm mt-1"
            inputMode="decimal"
          />
        </div>
        <div>
          <Label className="text-xs">Currency</Label>
          <Input
            value={form.currency}
            onChange={e => setForm({ ...form, currency: e.target.value })}
            placeholder="SAR"
            className="h-8 text-sm mt-1"
            maxLength={10}
          />
        </div>
        <div>
          <Label className="text-xs">Effective Date</Label>
          <Input
            type="date"
            value={form.effectiveDate}
            onChange={e => setForm({ ...form, effectiveDate: e.target.value })}
            className="h-8 text-sm mt-1"
          />
        </div>
        <div className="flex items-end gap-3 pb-1">
          <Label className="text-xs mb-1">Active</Label>
          <Switch
            checked={form.isActive}
            onCheckedChange={v => setForm({ ...form, isActive: v })}
          />
          <span className="text-xs text-muted-foreground">{form.isActive ? "Yes" : "No"}</span>
        </div>
      </div>
      <div>
        <Label className="text-xs">Notes</Label>
        <Input
          value={form.notes}
          onChange={e => setForm({ ...form, notes: e.target.value })}
          placeholder="Optional notes"
          className="h-8 text-sm mt-1"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
          <X className="h-3 w-3 mr-1" />Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={isSaving}>
          <Check className="h-3 w-3 mr-1" />{saveLabel}
        </Button>
      </div>
    </div>
  );
}

// ─── Main Dialog ─────────────────────────────────────────────────────────────

interface LawyerRatesDialogProps {
  open: boolean;
  onClose: () => void;
  matter: { id: number; matterReference?: string | null; billingType?: string | null };
}

export function LawyerRatesDialog({ open, onClose, matter }: LawyerRatesDialogProps) {
  const utils = trpc.useUtils();

  // ── State ──────────────────────────────────────────────────────────────────
  const [addingNew, setAddingNew] = useState(false);
  const [addForm, setAddForm] = useState<RateFormState>(DEFAULT_FORM);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<RateFormState>(DEFAULT_FORM);

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: rates = [], isLoading } = trpc.matterLawyerRates.list.useQuery(
    { clientMatterId: matter.id },
    { enabled: open },
  );

  // ── Mutations ──────────────────────────────────────────────────────────────
  const invalidate = () => utils.matterLawyerRates.list.invalidate({ clientMatterId: matter.id });

  const createRate = trpc.matterLawyerRates.create.useMutation({
    onSuccess: () => {
      toast.success("Lawyer rate added");
      setAddingNew(false);
      setAddForm(DEFAULT_FORM);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const updateRate = trpc.matterLawyerRates.update.useMutation({
    onSuccess: () => {
      toast.success("Lawyer rate updated");
      setEditingId(null);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteRate = trpc.matterLawyerRates.delete.useMutation({
    onSuccess: () => {
      toast.success("Lawyer rate deleted");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // ── Handlers ───────────────────────────────────────────────────────────────
  function handleAdd() {
    const err = validateForm(addForm);
    if (err) { toast.error(err); return; }
    createRate.mutate({
      clientMatterId: matter.id,
      lawyerName: addForm.lawyerName.trim(),
      role: addForm.role.trim() || undefined,
      hourlyRate: addForm.hourlyRate.trim(),
      currency: addForm.currency.trim() || "SAR",
      isActive: addForm.isActive,
      effectiveDate: addForm.effectiveDate || undefined,
      notes: addForm.notes.trim() || undefined,
    });
  }

  function startEdit(rate: RateRow) {
    setEditingId(rate.id);
    setAddingNew(false);
    setEditForm({
      lawyerName: rate.lawyerName,
      role: rate.role ?? "",
      hourlyRate: rate.hourlyRate,
      currency: rate.currency,
      isActive: rate.isActive,
      effectiveDate: rate.effectiveDate ?? "",
      notes: rate.notes ?? "",
    });
  }

  function handleUpdate() {
    if (editingId === null) return;
    const err = validateForm(editForm);
    if (err) { toast.error(err); return; }
    updateRate.mutate({
      id: editingId,
      lawyerName: editForm.lawyerName.trim(),
      role: editForm.role.trim() || undefined,
      hourlyRate: editForm.hourlyRate.trim(),
      currency: editForm.currency.trim() || "SAR",
      isActive: editForm.isActive,
      effectiveDate: editForm.effectiveDate || null,
      notes: editForm.notes.trim() || undefined,
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────
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
            Billable Hours matter. Define individual hourly rates for each lawyer assigned to this matter.
          </p>
        </DialogHeader>

        {/* Existing rates table */}
        {isLoading ? (
          <div className="py-8 text-center text-muted-foreground text-sm">Loading rates…</div>
        ) : rates.length === 0 && !addingNew ? (
          <div className="py-10 text-center text-muted-foreground">
            <Clock className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No lawyer rates defined yet.</p>
            <p className="text-xs mt-1">Click "Add Lawyer Rate" below to get started.</p>
          </div>
        ) : rates.length > 0 && (
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lawyer</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>Eff. Date</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(rates as RateRow[]).map(rate => (
                  editingId === rate.id ? (
                    <TableRow key={rate.id}>
                      <TableCell colSpan={7} className="p-2">
                        <RateForm
                          form={editForm}
                          setForm={setEditForm}
                          onSave={handleUpdate}
                          onCancel={() => setEditingId(null)}
                          isSaving={updateRate.isPending}
                          saveLabel="Save Changes"
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={rate.id} className={!rate.isActive ? "opacity-50" : undefined}>
                      <TableCell className="font-medium">{rate.lawyerName}</TableCell>
                      <TableCell className="text-muted-foreground">{rate.role ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono">
                        {Number(rate.hourlyRate).toLocaleString("en-SA", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </TableCell>
                      <TableCell>{rate.currency}</TableCell>
                      <TableCell className="text-sm">{rate.effectiveDate ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={rate.isActive ? "default" : "secondary"}>
                          {rate.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => startEdit(rate)}
                            disabled={deleteRate.isPending}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => deleteRate.mutate({ id: rate.id })}
                            disabled={deleteRate.isPending}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Add new rate form */}
        {addingNew && (
          <RateForm
            form={addForm}
            setForm={setAddForm}
            onSave={handleAdd}
            onCancel={() => { setAddingNew(false); setAddForm(DEFAULT_FORM); }}
            isSaving={createRate.isPending}
            saveLabel="Add Rate"
          />
        )}

        <DialogFooter className="flex justify-between items-center">
          {!addingNew && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setAddingNew(true); setEditingId(null); }}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Lawyer Rate
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
