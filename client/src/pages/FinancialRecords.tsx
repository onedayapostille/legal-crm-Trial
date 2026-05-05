import { useState } from "react";
import { DollarSign, Search, Filter, RefreshCw, TrendingUp, AlertTriangle, Clock } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { hasPermission } from "@shared/const";

const COLLECTION_STATUS_COLORS: Record<string, string> = {
  "Not Billed": "bg-gray-100 text-gray-700",
  "Partially Billed": "bg-yellow-100 text-yellow-800",
  "Billed": "bg-blue-100 text-blue-800",
  "Partially Collected": "bg-orange-100 text-orange-800",
  "Fully Collected": "bg-green-100 text-green-800",
  "Overdue": "bg-red-100 text-red-800",
};

const formatCurrency = (v: string | number | null) => {
  if (!v) return "—";
  return `SAR ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0 })}`;
};

export default function FinancialRecords() {
  const { user } = useAuth();
  const canManage = hasPermission(user?.role, "financial:manage");

  const [collectionStatus, setCollectionStatus] = useState("all");

  const { data: records = [], isLoading, refetch } = trpc.financial.list.useQuery({
    collectionStatus: collectionStatus !== "all" ? collectionStatus : undefined,
  });

  const { data: summary } = trpc.financial.summary.useQuery();

  // Client look-up for display
  const { data: clients = [] } = trpc.clients.list.useQuery({});
  const clientMap = Object.fromEntries(clients.map(c => [c.id, c.clientName]));

  if (!hasPermission(user?.role, "financial:view")) {
    return (
      <DashboardLayout>
        <div className="p-12 text-center">
          <AlertTriangle className="h-12 w-12 mx-auto mb-3 text-destructive opacity-60" />
          <h2 className="text-xl font-semibold">Access Restricted</h2>
          <p className="text-muted-foreground mt-2">
            You don't have permission to view financial records.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Financial Records</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Fee agreements, billing, and collection tracking
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SummaryCard
            label="Total Revenue"
            value={formatCurrency(summary?.totalRevenue ?? 0)}
            icon={TrendingUp}
            color="bg-green-600"
          />
          <SummaryCard
            label="Total Outstanding"
            value={formatCurrency(summary?.totalOutstanding ?? 0)}
            icon={Clock}
            color="bg-orange-500"
          />
          <SummaryCard
            label="Overdue Records"
            value={String(summary?.overdueCount ?? 0)}
            icon={AlertTriangle}
            color="bg-red-600"
          />
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex gap-3">
              <Select value={collectionStatus} onValueChange={setCollectionStatus}>
                <SelectTrigger className="w-52">
                  <Filter className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Collection Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {["Not Billed", "Partially Billed", "Billed", "Partially Collected", "Fully Collected", "Overdue"].map(s => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              {records.length} financial record{records.length !== 1 ? "s" : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading…</div>
            ) : records.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                <DollarSign className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>No financial records found.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client</TableHead>
                      <TableHead>Fee Type</TableHead>
                      <TableHead>Agreed Fees</TableHead>
                      <TableHead>Net Fees</TableHead>
                      <TableHead>Revenue</TableHead>
                      <TableHead>Collected</TableHead>
                      <TableHead>Outstanding</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Responsible</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {records.map(r => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">
                          {clientMap[r.clientId] ?? `Client #${r.clientId}`}
                        </TableCell>
                        <TableCell className="text-sm">{r.feeType ?? "—"}</TableCell>
                        <TableCell className="text-sm">{formatCurrency(r.agreedFees)}</TableCell>
                        <TableCell className="text-sm">{formatCurrency(r.netFees)}</TableCell>
                        <TableCell className="text-sm">{formatCurrency(r.revenue)}</TableCell>
                        <TableCell className="text-sm">{formatCurrency(r.collectedAmount)}</TableCell>
                        <TableCell className="text-sm">{formatCurrency(r.outstandingAmount)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={COLLECTION_STATUS_COLORS[r.collectionStatus ?? ""] ?? ""}>
                            {r.collectionStatus ?? "—"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm font-mono">{r.invoiceNumber ?? "—"}</TableCell>
                        <TableCell className="text-sm">{r.responsibleLawyer ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

function SummaryCard({ label, value, icon: Icon, color }: {
  label: string;
  value: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
          </div>
          <div className={`p-3 rounded-xl ${color}`}>
            <Icon className="h-5 w-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
