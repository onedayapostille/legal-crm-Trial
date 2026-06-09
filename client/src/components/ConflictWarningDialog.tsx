import { useState, useEffect } from "react";
import { ShieldAlert, Loader2 } from "lucide-react";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import ConflictMatchTable, { type ConflictMatch } from "@/components/ConflictMatchTable";

/**
 * Shown when a matter being created has potential conflicts. Creation is NOT
 * blocked — the user must explicitly acknowledge the conflict before proceeding.
 */
export default function ConflictWarningDialog({
  open,
  conflicts,
  isCreating,
  onCancel,
  onAcknowledge,
}: {
  open: boolean;
  conflicts: ConflictMatch[];
  isCreating: boolean;
  onCancel: () => void;
  onAcknowledge: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);

  // Reset the checkbox whenever the dialog re-opens.
  useEffect(() => {
    if (open) setAcknowledged(false);
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={v => { if (!v) onCancel(); }}>
      <AlertDialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-amber-700">
            <ShieldAlert className="h-5 w-5" />
            Potential Conflict Detected
          </AlertDialogTitle>
          <AlertDialogDescription>
            {conflicts.length} existing record{conflicts.length !== 1 ? "s" : ""} may
            conflict with this matter's name or opposing party. Creation is not blocked,
            but you must acknowledge this conflict to proceed.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ConflictMatchTable matches={conflicts} />

        <label className="flex items-center gap-2 text-sm mt-1 cursor-pointer">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={v => setAcknowledged(v === true)}
          />
          I have reviewed the potential conflicts and want to create this matter anyway.
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isCreating}>Cancel</AlertDialogCancel>
          <Button
            className="bg-amber-600 text-white hover:bg-amber-700"
            disabled={!acknowledged || isCreating}
            onClick={onAcknowledge}
          >
            {isCreating
              ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
              : null}
            Acknowledge & Create
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
