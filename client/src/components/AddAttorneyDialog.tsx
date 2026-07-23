import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ACCOUNT_ROLE_LABELS,
  LAWYER_GRADE_ROLES,
  type AccountRole,
} from "@shared/permissions";
import { ASSIGNMENT_FIELDS, type AssignmentField } from "@shared/assignmentEligibility";

/**
 * Shared "Add New Attorney" dialog used by every lawyer-assignment field's `+`
 * button (via LawyerSelect). Creates the user through the EXISTING secured
 * User Management endpoint (`users.create`, admin-only server-side) — no
 * second user-creation path. On success it invalidates the eligible-lawyers
 * cache so the new user appears in every lawyer dropdown immediately, and
 * reports the created user back so the caller can auto-select them.
 *
 * Role options are limited to the lawyer-grade account roles eligible for the
 * field the `+` was clicked on (shared/assignmentEligibility.ts) —
 * admins/managers are created from User Management, not from a matter form.
 */
const CREATABLE_ROLES: readonly AccountRole[] = LAWYER_GRADE_ROLES;

export default function AddAttorneyDialog({
  open,
  onClose,
  field,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** The assignment field whose `+` button opened the dialog. */
  field: AssignmentField;
  /** Called with the new user when creation succeeds (active users only get auto-selected by the caller). */
  onCreated: (user: { id: number; name: string | null; status: string }) => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AccountRole>("associate");
  const [status, setStatus] = useState<"active" | "inactive">("active");

  const eligibleRoles = CREATABLE_ROLES.filter(r =>
    (ASSIGNMENT_FIELDS[field].roles as readonly string[]).includes(r),
  );

  const reset = () => {
    setName(""); setEmail(""); setPassword("");
    setRole("associate"); setStatus("active");
  };

  const create = trpc.users.create.useMutation({
    onSuccess: (user) => {
      // New user must appear immediately in ALL lawyer dropdowns (every field).
      utils.users.eligibleLawyers.invalidate();
      toast.success(
        user.status === "active"
          ? `${user.name ?? "Attorney"} created and selected`
          : `${user.name ?? "Attorney"} created (inactive — cannot be assigned until activated)`,
      );
      onCreated({ id: user.id, name: user.name, status: user.status });
      reset();
      onClose();
    },
    // Dialog stays open on failure; the matter form underneath keeps its state.
    onError: (e) => toast.error(e.message),
  });

  const submit = () => {
    if (!name.trim()) { toast.error("Full name is required"); return; }
    if (!email.trim()) { toast.error("Email is required"); return; }
    if (!password) { toast.error("Temporary password is required"); return; }
    create.mutate({
      name: name.trim(),
      email: email.trim(),
      password,
      role,
      status,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="max-w-md"
        // Keep interactions inside this dialog from bubbling into the matter
        // form / LawyerSelect popover that opened it.
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Add New Attorney</DialogTitle>
          <DialogDescription>
            Creates a user via User Management (admin only). They will be selectable
            as {ASSIGNMENT_FIELDS[field].label} immediately if active.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div>
            <Label className="text-xs">Full Name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Ahmed Hassan" className="h-8 text-sm" autoFocus />
          </div>
          <div>
            <Label className="text-xs">Email *</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="name@firm.com" className="h-8 text-sm" />
          </div>
          <div>
            <Label className="text-xs">Temporary Password *</Label>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Min 8 chars, at least one letter and one number" className="h-8 text-sm" />
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Same policy as User Management: at least 8 characters with a letter and a number.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Role</Label>
              <Select value={role} onValueChange={v => setRole(v as AccountRole)}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {eligibleRoles.map(r => (
                    <SelectItem key={r} value={r}>{ACCOUNT_ROLE_LABELS[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Status</Label>
              <Select value={status} onValueChange={v => setStatus(v as "active" | "inactive")}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => { reset(); onClose(); }}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={create.isPending}>
            {create.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Create Attorney
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
