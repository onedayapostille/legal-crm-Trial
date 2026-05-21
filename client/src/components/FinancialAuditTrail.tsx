/**
 * FinancialAuditTrail
 *
 * Read-only dialog that shows the complete change history for a single
 * financial record. Each field-level edit is shown as one row:
 *   Date/Time | User | Field | Previous Value | New Value
 *
 * "Created" entries are shown at the top as a special row with no field detail.
 *
 * Security: this component is entirely read-only — it exposes no mutations.
 */

import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { History, ArrowRight } from "lucide-react";
import { trpc } from "@/lib/trpc";

// ─── Field label map (field name → human-readable label) ─────────────────────

const FIELD_LABELS: Record<string, string> = {
  clientMatterId:    "Linked Matter",
  feeType:           "Fee Type",
  agreedFees:        "Agreed Fees",
  discountApproval:  "Discount Approval",
  netFees:           "Net Fees",
  billedAmount:      "Amount Billed",
  revenue:           "Revenue",
  collectedAmount:   "Collected Amount",
  outstandingAmount: "Outstanding Amount",
  collectionStatus:  "Invoice Status",
  billingDate:       "Billing Date",
  paymentDate:       "Payment Date",
  invoiceNumber:     "Invoice Number",
  responsibleLawyer: "Responsible Lawyer",
  financeNotes:      "Finance Notes",
};

const MONETARY_FIELDS = new Set([
  "agreedFees", "netFees", "billedAmount",
  "revenue", "collectedAmount", "outstandingAmount",
]);

// ─── Value formatting ─────────────────────────────────────────────────────────

function formatValue(field: string | null | undefined, raw: string | null | undefined): string {
  if (!raw || raw === "(empty)") return "—";
  if (field && MONETARY_FIELDS.has(field)) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return `SAR ${n.toLocaleString("en-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
  }
  if (field === "clientMatterId") return `Matter #${raw}`;
  return raw;
}

// ─── Date formatting ──────────────────────────────────────────────────────────

function formatDateTime(d: Date | string | null): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleString("en-SA", {
    year:   "numeric",
    month:  "short",
    day:    "2-digit",
    hour:   "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ─── User display ─────────────────────────────────────────────────────────────

function userDisplay(name: string | null, email: string | null): string {
  if (name) return name;
  if (email) return email;
  return "Unknown User";
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface FinancialAuditTrailProps {
  open: boolean;
  onClose: () => void;
  record: {
    id: number;
    invoiceNumber?: string | null;
    clientId?: number;
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function FinancialAuditTrail({ open, onClose, record }: FinancialAuditTrailProps) {
  const { data: logs = [], isLoading } = trpc.financial.auditLog.useQuery(
    { id: record.id },
    { enabled: open },
  );

  const title = record.invoiceNumber
    ? `Change History — Invoice ${record.invoiceNumber}`
    : `Change History — Record #${record.id}`;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-muted-foreground" />
            {title}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Audit trail — read-only. All changes are recorded automatically.
          </p>
        </DialogHeader>

        {isLoading ? (
          <div className="py-10 text-center text-muted-foreground text-sm">
            Loading history…
          </div>
        ) : logs.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <History className="h-10 w-10 mx-auto mb-3 opacity-25" />
            <p className="text-sm">No changes recorded yet for this record.</p>
            <p className="text-xs mt-1 opacity-70">
              History is captured automatically from the first edit onwards.
            </p>
          </div>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="w-44">Date / Time</TableHead>
                  <TableHead className="w-36">Changed By</TableHead>
                  <TableHead className="w-40">Field</TableHead>
                  <TableHead>Previous Value</TableHead>
                  <TableHead className="w-6" />
                  <TableHead>New Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map(entry => {
                  const isCreated = entry.action === "created";
                  const isNoChange = !entry.fieldName && entry.action === "updated";
                  const fieldLabel = entry.fieldName
                    ? (FIELD_LABELS[entry.fieldName] ?? entry.fieldName)
                    : null;

                  return (
                    <TableRow
                      key={entry.id}
                      className={isCreated ? "bg-green-50/60" : undefined}
                    >
                      {/* Date */}
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDateTime(entry.createdAt)}
                      </TableCell>

                      {/* User */}
                      <TableCell className="text-sm font-medium">
                        {userDisplay(entry.changedByName, entry.changedByEmail)}
                      </TableCell>

                      {/* Field */}
                      <TableCell>
                        {isCreated ? (
                          <Badge variant="outline" className="border-green-300 text-green-700 bg-green-50 text-xs">
                            Record Created
                          </Badge>
                        ) : isNoChange ? (
                          <span className="text-xs text-muted-foreground italic">No tracked changes</span>
                        ) : fieldLabel ? (
                          <span className="text-sm font-medium">{fieldLabel}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">—</span>
                        )}
                      </TableCell>

                      {/* Old value */}
                      <TableCell className="text-sm">
                        {isCreated || isNoChange ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-xs font-mono">
                            {formatValue(entry.fieldName, entry.oldValue)}
                          </span>
                        )}
                      </TableCell>

                      {/* Arrow */}
                      <TableCell className="px-0">
                        {!isCreated && !isNoChange && (
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        )}
                      </TableCell>

                      {/* New value */}
                      <TableCell className="text-sm">
                        {isCreated ? (
                          <span className="text-muted-foreground text-xs">
                            {entry.description ?? "—"}
                          </span>
                        ) : isNoChange ? (
                          <span className="text-muted-foreground text-xs italic">
                            {entry.description}
                          </span>
                        ) : (
                          <span className="text-green-700 bg-green-50 px-1.5 py-0.5 rounded text-xs font-mono">
                            {formatValue(entry.fieldName, entry.newValue)}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <p className="text-xs text-muted-foreground text-right pt-1">
          {logs.length} entr{logs.length === 1 ? "y" : "ies"}
        </p>
      </DialogContent>
    </Dialog>
  );
}
