import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

// Mirrors the backend `ConflictMatch` shape returned by
// clients.conflictCheck / clientMatters.checkConflicts.
export interface ConflictMatch {
  matchType: "Client" | "Matter" | "Opposing Party";
  recordId: number;
  name: string;
  status: string;
  clientId: number;
  clientName: string;
}

const MATCH_TYPE_COLORS: Record<ConflictMatch["matchType"], string> = {
  Client: "bg-purple-100 text-purple-800 border-purple-200",
  Matter: "bg-blue-100 text-blue-800 border-blue-200",
  "Opposing Party": "bg-amber-100 text-amber-900 border-amber-300",
};

const STATUS_COLORS: Record<string, string> = {
  "Existing Client": "bg-green-100 text-green-800 border-green-200",
  Leads: "bg-blue-100 text-blue-800 border-blue-200",
  Rejected: "bg-red-100 text-red-800 border-red-200",
};

/**
 * Renders normalized conflict matches with match type, matched name, current
 * status, owning client, and the matched record id. Used by both the standalone
 * Conflict Check dialog and the matter-creation warning.
 */
export default function ConflictMatchTable({
  matches,
  onNavigate,
}: {
  matches: ConflictMatch[];
  onNavigate?: () => void;
}) {
  const [, navigate] = useLocation();

  return (
    <div className="rounded-lg border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="text-xs h-8">Match Type</TableHead>
            <TableHead className="text-xs h-8">Matched Name</TableHead>
            <TableHead className="text-xs h-8">Status</TableHead>
            <TableHead className="text-xs h-8">Client</TableHead>
            <TableHead className="text-xs h-8 text-right">Record&nbsp;ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {matches.map((m, i) => (
            <TableRow key={`${m.matchType}-${m.recordId}-${i}`} className="text-xs">
              <TableCell className="py-2">
                <Badge variant="outline" className={`text-xs ${MATCH_TYPE_COLORS[m.matchType]}`}>
                  {m.matchType}
                </Badge>
              </TableCell>
              <TableCell className="py-2 font-medium">
                <button
                  className="text-primary hover:underline text-left"
                  onClick={() => { onNavigate?.(); navigate(`/clients/${m.clientId}`); }}
                >
                  {m.name}
                </button>
              </TableCell>
              <TableCell className="py-2">
                <Badge variant="outline" className={`text-xs ${STATUS_COLORS[m.status] ?? ""}`}>
                  {m.status}
                </Badge>
              </TableCell>
              <TableCell className="py-2 text-muted-foreground">{m.clientName}</TableCell>
              <TableCell className="py-2 text-right font-mono text-muted-foreground">
                #{m.recordId}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
