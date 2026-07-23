import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { USER_STATUSES, type UserStatus } from "@shared/const";
import {
  ACCOUNT_ROLES,
  ACCOUNT_ROLE_LABELS,
  ACCOUNT_ROLE_DESCRIPTIONS,
  LAWYER_GRADE_ROLES,
  roleLabel,
  type AccountRole,
} from "@shared/permissions";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { Edit, KeyRound, Loader2, Plus, Settings, ShieldAlert, ShieldCheck, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type UserRow = RouterOutputs["users"]["list"][number];

type UserFormState = {
  name: string;
  email: string;
  password: string;
  // Only the 11 canonical account roles are assignable. "" = legacy role that
  // the admin must re-map before saving (partner/lawyer/staff/viewer rows).
  role: AccountRole | "";
  status: UserStatus;
  reportsToId: number | null; // supervising Head of Practice (lawyer grades)
};

const emptyForm: UserFormState = {
  name: "",
  email: "",
  password: "",
  role: "trainee", // least-privilege default
  status: "active",
  reportsToId: null,
};

// Lawyer grades below Head of Practice can report to a Head of Practice.
const REPORTS_TO_ROLES: readonly string[] = LAWYER_GRADE_ROLES.filter(
  r => r !== "head_of_practice",
);

const statusLabels: Record<UserStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  suspended: "Suspended",
};

function validatePassword(password: string) {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must include at least one letter and one number.";
  }
  return null;
}

function validateEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const utils = trpc.useUtils();
  const [formOpen, setFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [form, setForm] = useState<UserFormState>(emptyForm);
  const [resetUser, setResetUser] = useState<UserRow | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [deleteUser, setDeleteUser] = useState<UserRow | null>(null);

  const { data: users, isLoading, error } = trpc.users.list.useQuery();

  const refreshUsers = () => {
    utils.users.list.invalidate();
    // Lawyer-assignment dropdowns feed off these queries — refetch so a user
    // created/deactivated/reactivated here appears/disappears immediately.
    utils.users.eligibleLawyers.invalidate();
    utils.users.assignableLawyers.invalidate();
    utils.users.leadLawyers.invalidate();
  };

  const createMutation = trpc.users.create.useMutation({
    onSuccess: () => {
      toast.success("User created");
      setFormOpen(false);
      refreshUsers();
    },
    onError: error => toast.error(error.message),
  });

  const updateMutation = trpc.users.update.useMutation({
    onSuccess: () => {
      toast.success("User updated");
      setFormOpen(false);
      refreshUsers();
    },
    onError: error => toast.error(error.message),
  });

  const resetMutation = trpc.users.resetPassword.useMutation({
    onSuccess: () => {
      toast.success("Password reset");
      setResetUser(null);
      setResetPassword("");
      refreshUsers();
    },
    onError: error => toast.error(error.message),
  });

  const deleteMutation = trpc.users.delete.useMutation({
    onSuccess: () => {
      toast.success("User deleted");
      setDeleteUser(null);
      refreshUsers();
    },
    onError: error => toast.error(error.message),
  });

  const stats = useMemo(() => {
    const list = users ?? [];
    return {
      total: list.length,
      active: list.filter(user => user.status === "active").length,
      admins: list.filter(user => user.role === "admin").length,
    };
  }, [users]);

  const openCreate = () => {
    setEditingUser(null);
    setForm(emptyForm);
    setFormOpen(true);
  };

  const openEdit = (user: UserRow) => {
    setEditingUser(user);
    setForm({
      name: user.name ?? "",
      email: user.email,
      password: "",
      // Legacy roles (partner/lawyer/staff/viewer) are not assignable anymore:
      // the admin must pick a canonical role before saving.
      role: (ACCOUNT_ROLES as readonly string[]).includes(user.role)
        ? (user.role as AccountRole)
        : "",
      status: user.status as UserStatus,
      reportsToId: (user as any).reportsToId ?? null,
    });
    setFormOpen(true);
  };

  const submitForm = () => {
    const email = form.email.trim().toLowerCase();
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!validateEmail(email)) {
      toast.error("Enter a valid email address");
      return;
    }
    if (!form.role) {
      toast.error(
        editingUser
          ? `"${roleLabel(editingUser.role)}" is a legacy role — select one of the new account roles.`
          : "Select a role",
      );
      return;
    }
    const role = form.role;
    const reportsToId = REPORTS_TO_ROLES.includes(role) ? form.reportsToId : null;
    if (!editingUser) {
      const passwordError = validatePassword(form.password);
      if (passwordError) {
        toast.error(passwordError);
        return;
      }
      createMutation.mutate({
        email, name: form.name.trim(), password: form.password,
        role, status: form.status, reportsToId,
      });
      return;
    }

    updateMutation.mutate({
      userId: editingUser.id,
      name: form.name.trim(),
      email,
      role,
      status: form.status,
      reportsToId,
    });
  };

  const submitReset = () => {
    if (!resetUser) return;
    const passwordError = validatePassword(resetPassword);
    if (passwordError) {
      toast.error(passwordError);
      return;
    }
    resetMutation.mutate({ userId: resetUser.id, password: resetPassword });
  };

  const formatDate = (date: Date | string | null | undefined) => {
    if (!date) return "-";
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getStatusBadge = (status: string) => {
    if (status === "active") return <Badge className="bg-green-600">Active</Badge>;
    if (status === "suspended") return <Badge variant="destructive">Suspended</Badge>;
    return <Badge variant="secondary">Inactive</Badge>;
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex h-96 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  if (error) {
    return (
      <DashboardLayout>
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error.message}
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold">User Management</h1>
            <p className="mt-2 text-muted-foreground">
              Manage team accounts, roles, status, and password resets.
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            Add User
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
              <p className="text-xs text-muted-foreground">Registered accounts</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Users</CardTitle>
              <ShieldCheck className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.active}</div>
              <p className="text-xs text-muted-foreground">Can currently sign in</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Administrators</CardTitle>
              <ShieldAlert className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.admins}</div>
              <p className="text-xs text-muted-foreground">Full access accounts</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Team Members</CardTitle>
            <CardDescription>Admin actions are validated server-side.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Login</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(users ?? []).map(user => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">
                      {user.name || "-"}
                      {user.id === currentUser?.id ? (
                        <Badge variant="outline" className="ml-2 text-xs">You</Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>{roleLabel(user.role)}</TableCell>
                    <TableCell>{getStatusBadge(user.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(user.lastLoginAt)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(user.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="icon" onClick={() => openEdit(user)} title="Edit user">
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button variant="outline" size="icon" onClick={() => setResetUser(user)} title="Reset password">
                          <KeyRound className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => setDeleteUser(user)}
                          disabled={user.id === currentUser?.id}
                          title="Delete user"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {users?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      No users found
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* System Settings — admin only */}
      {currentUser?.role === "admin" && <SystemSettings />}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingUser ? "Edit User" : "Add User"}</DialogTitle>
            <DialogDescription>
              Users can sign in with any valid email domain.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} />
            </div>
            {!editingUser ? (
              <div className="grid gap-2">
                <Label htmlFor="password">Temporary password</Label>
                <Input id="password" type="password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} />
              </div>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Role</Label>
                {/* Only the 11 persistent account roles. Lead Lawyer is a
                    per-matter designation set on the matter, never a role. */}
                <Select value={form.role || undefined} onValueChange={value => setForm({ ...form, role: value as AccountRole })}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        editingUser && !form.role
                          ? `${roleLabel(editingUser.role)} — select new role`
                          : "Select a role"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_ROLES.map(role => (
                      <SelectItem key={role} value={role} textValue={ACCOUNT_ROLE_LABELS[role]}>
                        <div className="flex flex-col items-start">
                          <span>{ACCOUNT_ROLE_LABELS[role]}</span>
                          <span className="max-w-[340px] whitespace-normal text-xs text-muted-foreground">
                            {ACCOUNT_ROLE_DESCRIPTIONS[role]}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {editingUser && !form.role ? (
                  <p className="text-xs text-amber-600">
                    This account still has the legacy “{roleLabel(editingUser.role)}” role.
                    Pick its new account role to save.
                  </p>
                ) : null}
              </div>
              <div className="grid gap-2">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={value => setForm({ ...form, status: value as UserStatus })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {USER_STATUSES.map(status => (
                      <SelectItem key={status} value={status}>{statusLabels[status]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {/* Supervising Head of Practice — lawyer grades below HoP */}
            {form.role && REPORTS_TO_ROLES.includes(form.role) && (
              <div className="grid gap-2">
                <Label>Reports To (Head of Practice)</Label>
                <Select
                  value={form.reportsToId ? String(form.reportsToId) : "none"}
                  onValueChange={value => setForm({ ...form, reportsToId: value === "none" ? null : Number(value) })}
                >
                  <SelectTrigger><SelectValue placeholder="— None —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {(users ?? [])
                      .filter(u => (u.role === "head_of_practice" || u.role === "partner") && u.status === "active")
                      .map(u => (
                        <SelectItem key={u.id} value={String(u.id)}>{u.name ?? u.email}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The Head of Practice who supervises this lawyer.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button onClick={submitForm} disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {editingUser ? "Save Changes" : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(resetUser)} onOpenChange={open => !open && setResetUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>Set a temporary password for {resetUser?.email}.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor="reset-password">New password</Label>
            <Input id="reset-password" type="password" value={resetPassword} onChange={event => setResetPassword(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetUser(null)}>Cancel</Button>
            <Button onClick={submitReset} disabled={resetMutation.isPending}>
              {resetMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Reset Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteUser)} onOpenChange={open => !open && setDeleteUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              This removes {deleteUser?.email} from the CRM. Existing records stay in place.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteUser(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteUser && deleteMutation.mutate({ userId: deleteUser.id })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Delete User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

// ─── SystemSettings ───────────────────────────────────────────────────────────
// Admin-only card for configuring system-wide parameters.
// Currently exposes the overdue_invoice_days threshold.

function SystemSettings() {
  const utils = trpc.useUtils();
  const { data: currentDays, isLoading } = trpc.settings.getOverdueDays.useQuery();
  const [daysInput, setDaysInput] = useState<string>("");
  const [dirty, setDirty] = useState(false);

  // Initialise the input once the setting has loaded from the server.
  useEffect(() => {
    if (currentDays !== undefined && !dirty) {
      setDaysInput(String(currentDays));
    }
  }, [currentDays]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateMutation = trpc.settings.update.useMutation({
    onSuccess: () => {
      toast.success("Setting saved");
      // Refresh the threshold value and everything that depends on it.
      utils.settings.getOverdueDays.invalidate();
      utils.financial.summary.invalidate();
      utils.financial.list.invalidate();   // re-computes isComputedOverdue for all records
      setDirty(false);
    },
    onError: err => toast.error(err.message),
  });

  function handleSave() {
    const n = Number(daysInput);
    if (!Number.isFinite(n) || n < 1 || n > 3650) {
      toast.error("Overdue days must be a whole number between 1 and 3650.");
      return;
    }
    updateMutation.mutate({ key: "overdue_invoice_days", value: String(Math.floor(n)) });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings className="h-4 w-4 text-muted-foreground" />
          System Settings
        </CardTitle>
        <CardDescription>
          Configure system-wide behaviour. Changes take effect immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ── Overdue Invoice Days ────────────────────────────────────────── */}
        <div className="rounded-lg border p-4 space-y-3 max-w-lg">
          <div>
            <p className="font-medium text-sm">Overdue Invoice Days</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              An unpaid billed invoice is flagged as overdue when today&apos;s date is this many
              days or more past the billing date. Affects the Overdue tab in Financial Records
              and the dashboard overdue count.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={3650}
                step={1}
                value={daysInput}
                onChange={e => { setDaysInput(e.target.value); setDirty(true); }}
                className="w-24 h-9"
                disabled={isLoading}
              />
              <span className="text-sm text-muted-foreground whitespace-nowrap">days after billing date</span>
            </div>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty || updateMutation.isPending || isLoading}
            >
              {updateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
          {currentDays !== undefined && !dirty && (
            <p className="text-xs text-muted-foreground">
              Current value: <span className="font-semibold">{currentDays} day{currentDays !== 1 ? "s" : ""}</span>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
