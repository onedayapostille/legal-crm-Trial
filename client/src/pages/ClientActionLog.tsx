import { useState } from "react";
import { useLocation } from "wouter";
import { Calendar, Search, RefreshCw, ExternalLink } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import DashboardLayout from "@/components/DashboardLayout";
import { PageHeader } from "@/components/PageHeader";

export default function ClientActionLog() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");

  const { data: actions = [], isLoading, refetch } = trpc.clientActions.list.useQuery({});
  const { data: clients = [] } = trpc.clients.list.useQuery({});
  const clientMap = Object.fromEntries(clients.map(c => [c.id, c.clientName]));

  const today = new Date().toISOString().split("T")[0];
  const weekEnd = new Date();
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = weekEnd.toISOString().split("T")[0];

  const filtered = actions.filter(a => {
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    return (
      (clientMap[a.clientId] ?? "").toLowerCase().includes(term) ||
      (a.actionOwner ?? "").toLowerCase().includes(term) ||
      (a.actionType ?? "").toLowerCase().includes(term) ||
      (a.actionDetails ?? "").toLowerCase().includes(term)
    );
  });

  const overdue = actions.filter(a => a.actionDate && a.actionDate < today);
  const thisWeek = actions.filter(
    a => a.actionDate && a.actionDate >= today && a.actionDate <= weekEndStr
  );

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Client Action Log"
          description="All client activity and follow-up timeline"
          actions={
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
          }
        />

        {/* Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Actions</p>
              <p className="text-3xl font-bold mt-1">{actions.length}</p>
            </CardContent>
          </Card>
          <Card className="border-yellow-200">
            <CardContent className="pt-5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Due This Week</p>
              <p className="text-3xl font-bold mt-1 text-yellow-700">{thisWeek.length}</p>
            </CardContent>
          </Card>
          <Card className="border-red-200">
            <CardContent className="pt-5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Overdue</p>
              <p className="text-3xl font-bold mt-1 text-red-700">{overdue.length}</p>
            </CardContent>
          </Card>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by client, owner, type, or details…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              {filtered.length} action{filtered.length !== 1 ? "s" : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                <Calendar className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>No actions found.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead>Next Step</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(a => {
                    const isPast = a.actionDate && a.actionDate < today;
                    return (
                      <TableRow key={a.id} className={isPast ? "bg-red-50/40" : ""}>
                        <TableCell className={`text-sm font-mono ${isPast ? "text-red-700 font-semibold" : ""}`}>
                          {a.actionDate ?? "—"}
                        </TableCell>
                        <TableCell className="font-medium">
                          {clientMap[a.clientId] ?? `Client #${a.clientId}`}
                        </TableCell>
                        <TableCell>{a.actionType ?? "—"}</TableCell>
                        <TableCell>{a.actionOwner ?? "—"}</TableCell>
                        <TableCell className="max-w-xs truncate text-sm">{a.actionDetails ?? "—"}</TableCell>
                        <TableCell className="max-w-xs truncate text-sm">{a.nextStep ?? "—"}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/clients/${a.clientId}`)}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
