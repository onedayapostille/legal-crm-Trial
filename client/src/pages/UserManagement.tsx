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
import { ROLE_LABELS, USER_ROLES, USER_STATUSES, type UserRole, type UserStatus } from "@shared/const";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { Edit, KeyRound, Loader2, Plus, ShieldAlert, ShieldCheck, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type UserRow = RouterOutputs["users"]["list"][number];

type UserFormState = {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  status: UserStatus;
};

const emptyForm: UserFormState = {
  name: "",
  email: "",
  password: "",
  role: "staff",
  status: "active",
};

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

  const refreshUsers = () => utils.users.list.invalidate();

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
      role: user.role as UserRole,
      status: user.status as UserStatus,
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
    if (!editingUser) {
      const passwordError = validatePassword(form.password);
      if (passwordError) {
        toast.error(passwordError);
        return;
      }
      createMutation.mutate({ ...form, email, name: form.name.trim() });
      return;
    }

    updateMutation.mutate({
      userId: editingUser.id,
      name: form.name.trim(),
      email,
      role: form.role,
      status: form.status,
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
            <CardDescription>Admin actions are validated again on the server.</CardDescription>
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
                    <TableCell>{ROLE_LABELS[user.role as UserRole] ?? user.role}</TableCell>
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
                <Select value={form.role} onValueChange={value => setForm({ ...form, role: value as UserRole })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {USER_ROLES.map(role => (
                      <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
