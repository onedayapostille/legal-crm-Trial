import { useState, useEffect } from "react";
import { AlertTriangle, FileText, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MatterOption {
  id: number;
  matterReference: string | null;
  originalSerial: string | null;
  matterType: string | null;
  matterStatus: string | null;
  leadPartnerFullName: string | null;
}

export interface ClientOption {
  id: number;
  clientName: string;
}

// ─── Discount calculation (mirrors server/db.ts applyDiscountRules) ────────────

const DISCOUNT_RATES: Record<string, number> = {
  "N/A": 0,
  "P&L Head Lawyers": 5,
  "CEO": 10,
  "Board": 15,
};

function calcFinancials(f: {
  agreedFees: string;
  discountApproval: string;
  revenue: string;
  collectedAmount: string;
}) {
  const agreed    = Number(f.agreedFees)      || 0;
  const pct       = DISCOUNT_RATES[f.discountApproval] ?? 0;
  const discAmt   = Math.round(agreed * pct) / 100;
  const netFees   = Math.max(0, Math.round((agreed - discAmt) * 100) / 100);
  // Revenue is the single amount field (billed amount was removed; it duplicated this).
  const revenue   = Number(f.revenue)         || 0;
  const collected = Number(f.collectedAmount) || 0;
  // To Be Billed is derived from Net Fees (after discount), not Agreed Fees.
  // When there is no discount, netFees === agreedFees so the result is unchanged.
  const toBeBilled = Math.max(0, Math.round((netFees - revenue) * 100) / 100);
  const overbilled = netFees > 0 && revenue > netFees;
  return {
    discountPercentage: String(pct),
    discountAmount:     String(discAmt),
    netFees:            String(netFees),
    outstandingAmount:  String(Math.max(0, Math.round((revenue - collected) * 100) / 100)),
    toBeBilled:         String(toBeBilled),
    overbilled,
  };
}

function formatLegacyAmount(value: unknown) {
  if (value === null || value === undefined || value === "") return "Not set";
  const amount = Number(value);
  return Number.isFinite(amount)
    ? `SAR ${amount.toLocaleString("en-US")}`
    : String(value);
}

// ─── Form state ───────────────────────────────────────────────────────────────

const BLANK_FORM = {
  clientMatterId:    "",
  feeType:           "" as "" | "Billable Hours" | "Fixed / Project-Based Fees" | "Retainers" | "Success Fees" | "Advisory / Special Mandates" | "Blended",
  agreedFees:        "",
  discountApproval:  "N/A" as "N/A" | "P&L Head Lawyers" | "CEO" | "Board",
  revenue:           "",
  collectedAmount:   "",
  collectionStatus:  "Not Billed" as "Not Billed" | "Partially Billed" | "Billed" | "Partially Collected" | "Fully Collected" | "Overdue",
  billingDate:       "",
  paymentDate:       "",
  invoiceNumber:     "",
  responsibleLawyer: "",
  financeNotes:      "",
};

type FormState = typeof BLANK_FORM;

function recordToForm(r: any): FormState {
  return {
    clientMatterId:    r.clientMatterId ? String(r.clientMatterId) : "",
    feeType:           r.feeType           ?? "",
    agreedFees:        r.agreedFees        ?? "",
    discountApproval:  r.discountApproval  ?? "N/A",
    revenue:           r.revenue           ?? "",
    collectedAmount:   r.collectedAmount   ?? "",
    collectionStatus:  r.collectionStatus  ?? "Not Billed",
    billingDate:       r.billingDate       ?? "",
    paymentDate:       r.paymentDate       ?? "",
    invoiceNumber:     r.invoiceNumber     ?? "",
    responsibleLawyer: r.responsibleLawyer ?? "",
    financeNotes:      r.financeNotes      ?? "",
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

interface FinancialDialogProps {
  open: boolean;
  onClose: () => void;

  /**
   * Required when creating from a known client context (ClientDetail page).
   * Omit when using `allClients` for quick-add from the global page.
   */
  clientId?: number;

  /** When provided the dialog is in edit mode */
  record?: any;

  /**
   * Matters belonging to the relevant client.
   * • undefined  → don't show the matter selector (global context without client matters loaded)
   * • []         → client has no matters yet; show helpful empty-state message
   * • MatterOption[] → show the selector
   *
   * Not needed in quick-add mode — matters are loaded dynamically from the
   * selected client via tRPC.
   */
  matters?: MatterOption[];

  /**
   * Full client list for the Quick Add client picker.
   * When provided (and no `clientId`), a client selector appears at the top of
   * the form. The matters dropdown then auto-populates based on the chosen client.
   * Pass `[]` to render the picker in a disabled/empty state.
   */
  allClients?: ClientOption[];
}

export default function FinancialDialog({
  open,
  onClose,
  clientId,
  record,
  matters,
  allClients,
}: FinancialDialogProps) {
  const isEditMode     = !!record;
  const isQuickAddMode = !clientId && allClients !== undefined;
  const utils          = trpc.useUtils();

  const [form, setForm]                   = useState<FormState>(BLANK_FORM);
  const [formError, setFormError]         = useState("");
  // Internal client selection — only used in quick-add mode
  const [internalClientId, setInternalClientId] = useState<number | null>(null);

  // ── Quick-add: load matters dynamically when a client is chosen ─────────────
  const {
    data:      autoLoadedMatters,
    isLoading: isLoadingMatters,
  } = trpc.clientMatters.list.useQuery(
    { clientId: internalClientId! },
    { enabled: isQuickAddMode && internalClientId !== null },
  );

  // ── Derived effective values ─────────────────────────────────────────────────
  // The client ID to use when saving
  const effectiveClientId: number | undefined = clientId ?? (internalClientId ?? undefined);

  // The matters list to show in the matter selector
  const effectiveMatters: MatterOption[] | undefined = isQuickAddMode
    ? (internalClientId !== null && !isLoadingMatters
        ? ((autoLoadedMatters as MatterOption[] | undefined) ?? [])
        : undefined)
    : matters;

  // Whether to show the loading spinner in place of the matter selector
  const isMatterLoading = isQuickAddMode && internalClientId !== null && isLoadingMatters;

  // ── Reset form & internal state on open/close ───────────────────────────────
  useEffect(() => {
    if (open) {
      setFormError("");
      setForm(record ? recordToForm(record) : BLANK_FORM);
      if (isQuickAddMode) setInternalClientId(null);
    }
  }, [open, record?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const derived = calcFinancials(form);

  function setField(key: keyof FormState, value: string) {
    setForm(f => ({ ...f, [key]: value }));
  }

  // ── Invalidate all financial caches after save ───────────────────────────────
  function invalidateAll() {
    utils.financial.list.invalidate();
    utils.financial.summary.invalidate();
    utils.financial.toBeBilledBreakdown.invalidate();
    utils.financial.auditLog.invalidate();
  }

  const create = trpc.financial.create.useMutation({
    onSuccess: () => {
      toast.success("Financial record added");
      invalidateAll();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const update = trpc.financial.update.useMutation({
    onSuccess: () => {
      toast.success("Financial record updated");
      invalidateAll();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const isPending = isEditMode ? update.isPending : create.isPending;

  // ── Validation + save ────────────────────────────────────────────────────────
  function handleSave() {
    setFormError("");

    // Quick-add mode: must select a client first
    if (isQuickAddMode && !internalClientId) {
      setFormError("Please select a client.");
      return;
    }

    if (!form.feeType) {
      setFormError("Fee Type is required.");
      return;
    }

    if (!isEditMode && !effectiveClientId) {
      setFormError("No client selected.");
      return;
    }

    // Validate numeric monetary fields
    const numericFields: Array<[keyof FormState, string]> = [
      ["agreedFees",     "Agreed Fees"],
      ["revenue",        "Revenue"],
      ["collectedAmount","Collected Amount"],
    ];
    for (const [key, label] of numericFields) {
      const v = form[key] as string;
      if (v !== "" && (isNaN(Number(v)) || !isFinite(Number(v)))) {
        setFormError(`${label} must be a valid number (e.g. 10000).`);
        return;
      }
    }

    // clientMatterId: number to link, null to unlink (edit), omit on create with no matter
    const matterIdValue = form.clientMatterId ? Number(form.clientMatterId) : null;

    const payload = {
      ...(form.feeType           ? { feeType:           form.feeType }           : {}),
      ...(form.agreedFees        ? { agreedFees:        form.agreedFees }        : {}),
      discountApproval:  form.discountApproval,
      ...(form.revenue           ? { revenue:           form.revenue }           : {}),
      ...(form.collectedAmount   ? { collectedAmount:   form.collectedAmount }   : {}),
      collectionStatus:  form.collectionStatus,
      ...(form.billingDate       ? { billingDate:       form.billingDate }       : {}),
      ...(form.paymentDate       ? { paymentDate:       form.paymentDate }       : {}),
      ...(form.invoiceNumber     ? { invoiceNumber:     form.invoiceNumber }     : {}),
      ...(form.responsibleLawyer ? { responsibleLawyer: form.responsibleLawyer } : {}),
      ...(form.financeNotes      ? { financeNotes:      form.financeNotes }      : {}),
    };

    if (isEditMode) {
      update.mutate({
        id: record.id,
        ...payload,
        ...(effectiveMatters !== undefined ? { clientMatterId: matterIdValue } : {}),
      });
    } else {
      create.mutate({
        clientId: effectiveClientId!,
        ...payload,
        ...(effectiveMatters !== undefined && matterIdValue !== null
          ? { clientMatterId: matterIdValue }
          : {}),
      });
    }
  }

  // ── Matter selector helpers ──────────────────────────────────────────────────
  const showMatterSelector = effectiveMatters !== undefined;
  const hasMatterOptions   = effectiveMatters && effectiveMatters.length > 0;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? "Edit Financial Record" : "Add Financial Record"}
          </DialogTitle>
          {isEditMode && record?.invoiceNumber && (
            <p className="text-xs text-muted-foreground">
              Invoice {record.invoiceNumber}
            </p>
          )}
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 py-2">

          {/* ── Client Selector (Quick Add mode only) ────────────────────── */}
          {isQuickAddMode && (
            <div className="col-span-2">
              <Label className="text-xs">
                Client <span className="text-destructive">*</span>
              </Label>
              {allClients!.length === 0 ? (
                <div className="mt-1 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <span className="text-amber-800">
                    No clients are available. You may not have permission to view clients,
                    or no clients have been created yet.
                  </span>
                </div>
              ) : (
                <Select
                  value={internalClientId ? String(internalClientId) : "__none__"}
                  onValueChange={v => {
                    const newId = v === "__none__" ? null : Number(v);
                    setInternalClientId(newId);
                    setField("clientMatterId", ""); // reset matter when client changes
                  }}
                >
                  <SelectTrigger
                    className={`mt-1 ${!internalClientId ? "border-destructive/40" : ""}`}
                  >
                    <SelectValue placeholder="Select client…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Select client…</SelectItem>
                    {[...allClients!]
                      .sort((a, b) => a.clientName.localeCompare(b.clientName))
                      .map(c => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.clientName}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* ── Client banner (non-quick-add edit mode — show which client) ─ */}
          {isEditMode && record?.clientId && !isQuickAddMode && (
            <div className="col-span-2 rounded-md bg-muted/60 border px-3 py-2 text-xs text-muted-foreground">
              Editing record for <span className="font-medium text-foreground">Client #{record.clientId}</span>
              {record.invoiceNumber ? ` · Invoice ${record.invoiceNumber}` : ""}
            </div>
          )}

          {/* ── Matter Selector ───────────────────────────────────────────── */}

          {/* Loading state while matters are fetched for quick-add client */}
          {isMatterLoading && (
            <div className="col-span-2">
              <Label className="text-xs">Linked Matter (optional)</Label>
              <div className="mt-1 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                Loading matters for this client…
              </div>
            </div>
          )}

          {/* Matter selector — shown once matters are available */}
          {showMatterSelector && (
            <div className="col-span-2">
              <Label className="text-xs">Linked Matter (optional)</Label>

              {hasMatterOptions ? (
                <Select
                  value={form.clientMatterId || "none"}
                  onValueChange={v => setField("clientMatterId", v === "none" ? "" : v)}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="No matter — client-level record" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      No matter — client-level record
                    </SelectItem>
                    {effectiveMatters!.map(m => (
                      <SelectItem key={m.id} value={String(m.id)}>
                        <span className="flex flex-col leading-tight">
                          <span className="font-medium">
                            {m.matterReference ?? m.originalSerial ?? `Matter #${m.id}`}
                          </span>
                          {(m.matterType || m.matterStatus || m.leadPartnerFullName) && (
                            <span className="text-xs text-muted-foreground">
                              {[
                                m.matterType,
                                m.matterStatus,
                                m.leadPartnerFullName ? `Lead Partner: ${m.leadPartnerFullName}` : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                /* Client has no matters yet */
                <div className="mt-1 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm">
                  <FileText className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <span className="text-amber-800">
                    No matters found for this client. This record will be saved at
                    client level. Create a matter first to link it here.
                  </span>
                </div>
              )}

              {/* Inline matter info chip */}
              {form.clientMatterId && hasMatterOptions && (() => {
                const m = effectiveMatters!.find(x => String(x.id) === form.clientMatterId);
                if (!m) return null;
                return (
                  <div className="mt-1.5 rounded-md bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs text-blue-800 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span className="font-medium">
                      {m.matterReference ?? m.originalSerial ?? `Matter #${m.id}`}
                    </span>
                    {m.matterType    && <span>{m.matterType}</span>}
                    {m.matterStatus  && <span>Status: {m.matterStatus}</span>}
                    {m.leadPartnerFullName && <span>Partner: {m.leadPartnerFullName}</span>}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ── Fee Type ─────────────────────────────────────────────────── */}
          <div className="col-span-2">
            <Label className="text-xs">
              Fee Type <span className="text-destructive">*</span>
            </Label>
            <Select
              value={form.feeType || "none"}
              onValueChange={v => setField("feeType", v === "none" ? "" : v as any)}
            >
              <SelectTrigger className={!form.feeType ? "border-destructive/50" : ""}>
                <SelectValue placeholder="Select fee type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Select fee type…</SelectItem>
                {(["Billable Hours", "Fixed / Project-Based Fees", "Retainers",
                   "Success Fees", "Advisory / Special Mandates", "Blended"] as const).map(t => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ── Agreed Fees ──────────────────────────────────────────────── */}
          <div>
            <Label className="text-xs">Agreed Fees (SAR)</Label>
            <Input
              value={form.agreedFees}
              onChange={e => setField("agreedFees", e.target.value)}
              className="h-8 text-sm"
              placeholder="0"
            />
          </div>

          {/* ── Discount Approval ────────────────────────────────────────── */}
          <div>
            <Label className="text-xs">Discount Approval</Label>
            <Select
              value={form.discountApproval}
              onValueChange={v => setField("discountApproval", v as any)}
            >
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["N/A", "P&L Head Lawyers", "CEO", "Board"] as const).map(v => (
                  <SelectItem key={v} value={v}>
                    {v}{v !== "N/A" ? ` (${DISCOUNT_RATES[v]}%)` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ── Derived: Discount % ──────────────────────────────────────── */}
          <div>
            <Label className="text-xs text-muted-foreground">Discount % (auto)</Label>
            <Input
              value={`${derived.discountPercentage}%`}
              readOnly
              className="h-8 text-sm bg-muted"
            />
          </div>

          {/* ── Derived: Discount Amount ─────────────────────────────────── */}
          <div>
            <Label className="text-xs text-muted-foreground">Discount Amount (auto)</Label>
            <Input
              value={derived.discountAmount}
              readOnly
              className="h-8 text-sm bg-muted"
            />
          </div>

          {/* ── Derived: Net Fees ────────────────────────────────────────── */}
          <div className="col-span-2">
            <Label className="text-xs text-muted-foreground">Net Fees (auto)</Label>
            <Input
              value={derived.netFees}
              readOnly
              className="h-8 text-sm bg-muted font-medium"
            />
          </div>

          {/* ── Billing inputs (Revenue is the single amount field) ───────── */}
          {(["revenue", "collectedAmount"] as const).map(key => (
            <div key={key}>
              <Label className="text-xs">
                {key === "revenue" ? "Revenue" : "Collected Amount"}
              </Label>
              <Input
                value={form[key]}
                onChange={e => setField(key, e.target.value)}
                className="h-8 text-sm"
                placeholder="0"
              />
            </div>
          ))}

          {/* Legacy accounting fields: display only, never recalculated. */}
          <div className="col-span-2 rounded-md border bg-muted/30 px-3 py-2">
            <p className="text-xs font-medium">Legacy read-only fields</p>
            <div className="mt-1 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
              <span>Billed Amount: {formatLegacyAmount(record?.billedAmount)}</span>
              <span>Remaining Advanced: {formatLegacyAmount(record?.remainingAdvanced)}</span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Historical values are preserved when this record is edited. New records leave both fields blank.
            </p>
          </div>

          {/* ── Derived: Outstanding Amount ──────────────────────────────── */}
          <div>
            <Label className="text-xs text-muted-foreground">Outstanding Amount (auto)</Label>
            <Input value={derived.outstandingAmount} readOnly className="h-8 text-sm bg-muted" />
            <p className="text-xs text-muted-foreground mt-0.5">
              = MAX(0, Revenue - Collected Amount)
            </p>
          </div>

          {/* ── Derived: To Be Billed ─────────────────────────────────────── */}
          <div className="col-span-2">
            <Label className="text-xs text-amber-700 font-medium">To Be Billed (auto)</Label>
            <Input
              value={derived.toBeBilled ? `SAR ${Number(derived.toBeBilled).toLocaleString("en-US")}` : "SAR 0"}
              readOnly
              className="h-8 text-sm bg-amber-50 border-amber-200 font-semibold text-amber-900"
            />
            <p className="text-xs text-muted-foreground mt-0.5">
              = MAX(0, Net Fees − Revenue)
            </p>
          </div>

          {/* ── Overbilling warning ───────────────────────────────────────── */}
          {derived.overbilled && (
            <div className="col-span-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
              <span className="text-red-700">
                <strong>Over-recognition warning:</strong> Revenue (SAR {Number(form.revenue || 0).toLocaleString("en-US")}) exceeds Agreed Fees (SAR {Number(form.agreedFees || 0).toLocaleString("en-US")}). Please review.
              </span>
            </div>
          )}

          {/* ── Invoice Number ───────────────────────────────────────────── */}
          <div>
            <Label className="text-xs">Invoice Number</Label>
            <Input
              value={form.invoiceNumber}
              onChange={e => setField("invoiceNumber", e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {/* ── Responsible Lawyer ───────────────────────────────────────── */}
          <div>
            <Label className="text-xs">Responsible Lawyer</Label>
            <Input
              value={form.responsibleLawyer}
              onChange={e => setField("responsibleLawyer", e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {/* ── Billing Date ─────────────────────────────────────────────── */}
          <div>
            <Label className="text-xs">Billing Date</Label>
            <Input
              type="date"
              value={form.billingDate}
              onChange={e => setField("billingDate", e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {/* ── Payment Date ─────────────────────────────────────────────── */}
          <div>
            <Label className="text-xs">Payment Date</Label>
            <Input
              type="date"
              value={form.paymentDate}
              onChange={e => setField("paymentDate", e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {/* ── Invoice Status ────────────────────────────────────────────── */}
          <div>
            <Label className="text-xs">Invoice Status</Label>
            <Select
              value={form.collectionStatus}
              onValueChange={v => setField("collectionStatus", v as any)}
            >
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["Not Billed", "Partially Billed", "Billed",
                   "Partially Collected", "Fully Collected", "Overdue"] as const).map(v => (
                  <SelectItem key={v} value={v}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Invoice Status is a manual field; warn (don't block) on a contradictory
                "Fully Collected" while Outstanding > 0 so it is set only by design. */}
            {form.collectionStatus === "Fully Collected" && Number(derived.outstandingAmount) > 0 && (
              <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-700">
                <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                <span>
                  Marked “Fully Collected” but Outstanding is SAR {Number(derived.outstandingAmount).toLocaleString("en-US")} (Revenue − Collected). Confirm this is intended.
                </span>
              </p>
            )}
          </div>

          {/* ── Finance Notes ─────────────────────────────────────────────── */}
          <div className="col-span-2">
            <Label className="text-xs">Finance Notes</Label>
            <Textarea
              value={form.financeNotes}
              onChange={e => setField("financeNotes", e.target.value)}
              rows={2}
              className="text-sm"
            />
          </div>
        </div>

        {/* Inline validation error */}
        {formError && (
          <p className="text-sm text-destructive -mt-1 px-1">{formError}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending
              ? (isEditMode ? "Saving…" : "Adding…")
              : (isEditMode ? "Save Changes" : "Add Record")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
