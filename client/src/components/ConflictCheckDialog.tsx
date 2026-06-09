import { useState, useRef } from "react";
import {
  ShieldCheck, ShieldAlert, Search, Loader2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import ConflictMatchTable from "@/components/ConflictMatchTable";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ConflictCheckDialog({ open, onClose }: Props) {
  const [inputValue, setInputValue] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: results, isLoading, isError, error } = trpc.clients.conflictCheck.useQuery(
    { query: submittedQuery },
    { enabled: submittedQuery.length > 0, retry: false },
  );

  const hasSearched = submittedQuery.length > 0;
  const ready = hasSearched && !isLoading && !isError && results;
  const hasConflict = ready && results.length > 0;
  const noConflict = ready && results.length === 0;

  function handleCheck() {
    const q = inputValue.trim();
    if (!q) return;
    setSubmittedQuery(q);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleCheck();
  }

  function handleClose() {
    setInputValue("");
    setSubmittedQuery("");
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
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
              placeholder="Client name, matter name, or opposing party…"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="pl-9"
              autoFocus
            />
          </div>
          <Button onClick={handleCheck} disabled={!inputValue.trim() || isLoading}>
            {isLoading
              ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
              : <ShieldCheck className="h-4 w-4 mr-1" />}
            Check
          </Button>
        </div>

        <p className="text-xs text-muted-foreground -mt-1">
          Searches client names, matter names/references, and opposing-party fields
          (case-insensitive partial match).
        </p>

        {/* Result states */}
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Searching records…</span>
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
                No records match <strong>"{submittedQuery}"</strong>.
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
                  {results.length} record{results.length !== 1 ? "s" : ""} match
                  {results.length === 1 ? "es" : ""} <strong>"{submittedQuery}"</strong>.
                  Review before proceeding.
                </p>
              </div>
            </div>
            <ConflictMatchTable matches={results} onNavigate={handleClose} />
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
