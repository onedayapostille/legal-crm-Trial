import { useState, useRef } from "react";
import { useLocation } from "wouter";
import {
  ShieldCheck, ShieldAlert, Search, Loader2, ChevronDown, ChevronUp,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

const STATUS_COLORS: Record<string, string> = {
  "Existing Client": "bg-green-100 text-green-800 border-green-200",
  Leads: "bg-blue-100 text-blue-800 border-blue-200",
  Rejected: "bg-red-100 text-red-800 border-red-200",
};

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "bg-red-100 text-red-700",
  high: "bg-orange-100 text-orange-700",
  medium: "bg-yellow-100 text-yellow-700",
  low: "bg-gray-100 text-gray-600",
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ConflictCheckDialog({ open, onClose }: Props) {
  const [, navigate] = useLocation();
  const [inputValue, setInputValue] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [expandedClientId, setExpandedClientId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: results, isLoading, isError, error } = trpc.clients.conflictCheck.useQuery(
    { query: submittedQuery },
    { enabled: submittedQuery.length > 0, retry: false }
  );

  const hasSearched = submittedQuery.length > 0;
  const hasConflict = hasSearched && !isLoading && !isError && results && results.length > 0;
  const noConflict = hasSearched && !isLoading && !isError && results && results.length === 0;

  function handleCheck() {
    const q = inputValue.trim();
    if (!q) return;
    setExpandedClientId(null);
    setSubmittedQuery(q);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleCheck();
  }

  function handleClose() {
    setInputValue("");
    setSubmittedQuery("");
    setExpandedClientId(null);
    onClose();
  }

  function toggleExpanded(id: number) {
    setExpandedClientId(prev => (prev === id ? null : id));
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Conflict Check
          </DialogTitle>
        </DialogHeader>

        {/* Search bar */}
        <div className="flex gap-2 mt-1">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Client name, client #, file #…"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="pl-9"
              autoFocus
            />
          </div>
          <Button onClick={handleCheck} disabled={!inputValue.trim() || isLoading}>
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <ShieldCheck className="h-4 w-4 mr-1" />
            )}
            Check
          </Button>
        </div>

        <p className="text-xs text-muted-foreground -mt-1">
          Searches across client name, client number, and file number (case-insensitive partial match).
        </p>

        {/* Result states */}
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Searching client records…</span>
          </div>
        )}

        {isError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Search failed: {error?.message ?? "Unknown error"}. Please try again.
          </div>
        )}

        {noConflict && (
          <div className="rounded-lg border border-green-300 bg-green-50 px-4 py-4 flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-green-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold text-green-800">No Conflict Found</p>
              <p className="text-sm text-green-700 mt-0.5">
                No existing client records match <strong>"{submittedQuery}"</strong>.
              </p>
            </div>
          </div>
        )}

        {hasConflict && results && (
          <>
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-4 flex items-start gap-3">
              <ShieldAlert className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold text-amber-800">Potential Conflict Found</p>
                <p className="text-sm text-amber-700 mt-0.5">
                  {results.length} existing client record{results.length !== 1 ? "s" : ""} match{results.length === 1 ? "es" : ""}{" "}
                  <strong>"{submittedQuery}"</strong>. Review before proceeding.
                </p>
              </div>
            </div>

            <div className="space-y-3 mt-1">
              {results.map(client => (
                <div
                  key={client.id}
                  className="rounded-lg border bg-card shadow-sm overflow-hidden"
                >
                  {/* Client header row */}
                  <div className="px-4 py-3 flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          className="font-semibold text-sm hover:underline text-primary text-left"
                          onClick={() => { handleClose(); navigate(`/clients/${client.id}`); }}
                        >
                          {client.clientName}
                        </button>
                        <Badge
                          variant="outline"
                          className={`text-xs ${STATUS_COLORS[client.clientStatus]}`}
                        >
                          {client.clientStatus}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                        {client.clientNumber && (
                          <span className="font-mono">Client # {client.clientNumber}</span>
                        )}
                        {client.fileNumber && (
                          <span className="font-mono">File # {client.fileNumber}</span>
                        )}
                        {client.city && <span>{client.city}</span>}
                        {client.matterType && <span>{client.matterType}</span>}
                        <span>
                          Added {new Date(client.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>

                    {client.matters.length > 0 && (
                      <button
                        className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => toggleExpanded(client.id)}
                      >
                        {client.matters.length} matter{client.matters.length !== 1 ? "s" : ""}
                        {expandedClientId === client.id
                          ? <ChevronUp className="h-3.5 w-3.5" />
                          : <ChevronDown className="h-3.5 w-3.5" />
                        }
                      </button>
                    )}
                    {client.matters.length === 0 && (
                      <span className="text-xs text-muted-foreground shrink-0">No matters</span>
                    )}
                  </div>

                  {/* Expanded matters table */}
                  {expandedClientId === client.id && client.matters.length > 0 && (
                    <div className="border-t">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/40">
                            <TableHead className="text-xs h-8">Reference</TableHead>
                            <TableHead className="text-xs h-8">Type</TableHead>
                            <TableHead className="text-xs h-8">Status</TableHead>
                            <TableHead className="text-xs h-8">Lead Partner</TableHead>
                            <TableHead className="text-xs h-8">Priority</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {client.matters.map(m => (
                            <TableRow key={m.id} className="text-xs">
                              <TableCell className="font-mono py-2">
                                {m.matterReference ?? "—"}
                              </TableCell>
                              <TableCell className="py-2">{m.matterType ?? "—"}</TableCell>
                              <TableCell className="py-2">
                                {m.matterStatus ? (
                                  <Badge variant="outline" className="text-xs">
                                    {m.matterStatus}
                                  </Badge>
                                ) : "—"}
                              </TableCell>
                              <TableCell className="py-2">
                                {m.leadPartnerFullName ?? "—"}
                              </TableCell>
                              <TableCell className="py-2">
                                {m.priority ? (
                                  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${PRIORITY_COLORS[m.priority] ?? ""}`}>
                                    {m.priority}
                                  </span>
                                ) : "—"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="flex justify-end pt-2 border-t mt-2">
          <Button variant="outline" size="sm" onClick={handleClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
