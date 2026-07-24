import { Link, useSearch } from "wouter";
import { Plus, Briefcase, Calendar, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/_core/hooks/useAuth";
import { userCan } from "@/lib/permissions";

const PRIORITY_COLORS: Record<string, string> = {
  low:    "bg-gray-100 text-gray-600",
  medium: "bg-blue-100 text-blue-700",
  high:   "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};

export default function MatterList() {
  // Read the status filter straight from the URL (?status=Active) so the page is
  // deep-linkable from the dashboard KPI. The filter is applied by the backend
  // query — there is no client-side filtering of the result set.
  const search = useSearch();
  const statusFilter = new URLSearchParams(search).get("status")?.trim() || undefined;
  const { user } = useAuth();
  // Matter creation is clients:manage (same gate as the /matters/new route).
  const canCreateMatter = userCan(user, "matters:create");

  const { data: matters = [], isLoading } = trpc.clientMatters.listAll.useQuery(
    statusFilter ? { status: statusFilter } : undefined,
  );

  return (
    <DashboardLayout>
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">
              {statusFilter ? `${statusFilter} Matters` : "Matters"}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {matters.length} matter{matters.length !== 1 ? "s" : ""}
              {statusFilter && (
                <>
                  {" "}· filtered by status{" "}
                  <span className="font-medium">{statusFilter}</span>
                  <Link
                    href="/matters"
                    className="inline-flex items-center gap-0.5 ml-2 text-blue-600 hover:underline"
                  >
                    <X className="h-3 w-3" /> clear
                  </Link>
                </>
              )}
            </p>
          </div>
          {canCreateMatter && (
            <Link href="/matters/new">
              <Button size="sm"><Plus className="h-4 w-4 mr-1" /> New Matter</Button>
            </Link>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}><CardContent className="py-4"><div className="h-12 animate-pulse bg-muted rounded" /></CardContent></Card>
            ))}
          </div>
        ) : matters.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              No matters yet.
              {canCreateMatter && (
                <>
                  {" "}
                  <Link href="/matters/new" className="text-blue-600 hover:underline">Open the first matter</Link>
                </>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {matters.map(m => (
              <Link key={m.id} href={`/clients/${m.clientId}`}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer">
                  <CardContent className="py-4 px-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="p-2 rounded-lg bg-indigo-50 flex-shrink-0">
                          <Briefcase className="h-5 w-5 text-indigo-600" />
                        </div>
                        <div className="min-w-0">
                          {/* Matter Reference is the matter-level identifier; Original
                              Serial (inherited from the client) is shown separately so the
                              two are never confused. */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-sm font-medium">
                              {m.matterReference ?? `Matter #${m.id}`}
                            </span>
                            {m.matterStatus && (
                              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-700">
                                {m.matterStatus}
                              </span>
                            )}
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${PRIORITY_COLORS[m.priority ?? "medium"]}`}
                            >
                              {m.priority ?? "medium"}
                            </span>
                          </div>
                          <p className="font-semibold text-sm mt-0.5 truncate">
                            {m.clientName ?? `Client #${m.clientId}`}
                          </p>
                          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground mt-0.5">
                            <span>
                              <span className="text-muted-foreground/70">Serial:</span>{" "}
                              <span className="font-mono">{m.originalSerial ?? "—"}</span>
                            </span>
                            <span>
                              <span className="text-muted-foreground/70">Type:</span>{" "}
                              {m.matterType ?? "—"}
                            </span>
                            <span>
                              <span className="text-muted-foreground/70">Lead Partner:</span>{" "}
                              {m.leadPartnerFullName ?? m.leadPartner ?? "—"}
                            </span>
                          </div>
                          {m.matterDescription && (
                            <p className="text-xs text-muted-foreground truncate mt-0.5">{m.matterDescription}</p>
                          )}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0 space-y-1">
                        {m.achievementPercentage && (
                          <div className="text-xs text-muted-foreground">{m.achievementPercentage}%</div>
                        )}
                        {m.createdAt && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
                            <Calendar className="h-3 w-3" />
                            {new Date(m.createdAt).toLocaleDateString()}
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
