import { useState, useRef } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle, Download } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import DashboardLayout from "@/components/DashboardLayout";
import { toast } from "sonner";

type ImportRow = {
  clientNumber?: string;
  fileNumber?: string;
  clientName?: string;
  clientStatus?: string;
  city?: string;
  matterType?: string;
};

type ImportError = { row: number; field: string; issue: string };

type ImportResult = {
  imported: number;
  skipped: number;
  errors: ImportError[];
};

export default function ImportPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [parsing, setParsing] = useState(false);

  const importMutation = trpc.import.clients.useMutation({
    onSuccess: (data) => {
      setResult(data);
      if (data.imported > 0) {
        toast.success(`${data.imported} client${data.imported !== 1 ? "s" : ""} imported successfully`);
      }
    },
    onError: (e) => toast.error(e.message),
  });

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setParsing(true);

    try {
      const text = await readFileAsText(file);
      const rows = parseCSV(text);
      setPreview(rows);
      toast.success(`${rows.length} rows parsed from file`);
    } catch (err: any) {
      toast.error("Failed to parse file: " + err.message);
    } finally {
      setParsing(false);
    }
  };

  const handleImport = () => {
    if (preview.length === 0) return;
    importMutation.mutate({ rows: preview });
  };

  const downloadTemplate = () => {
    const header = "Client Number,File Number,Client Name,Client Status,City,Matter Type";
    const sample = 'C-0001,F-2025-001,"Al-Rashid Trading Co","Existing Client",Riyadh,Corporate';
    const csv = [header, sample].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "client_import_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Import Clients</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload a CSV file to migrate client data from Excel into the CRM.
          </p>
        </div>

        {/* Instructions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">File Format</CardTitle>
            <CardDescription>
              Upload a CSV with the following columns. Download the template to get started.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Column</TableHead>
                    <TableHead>Required</TableHead>
                    <TableHead>Allowed Values</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    ["Client Number", "No", "Any text (must be unique)"],
                    ["File Number", "No", "Any text (must be unique)"],
                    ["Client Name", "Yes", "Any text"],
                    ["Client Status", "Yes", "Existing Client, Leads, Rejected"],
                    ["City", "No", "Riyadh, Dammam, Jeddah"],
                    ["Matter Type", "No", "Corporate, Litigation"],
                  ].map(([col, req, vals]) => (
                    <TableRow key={col}>
                      <TableCell className="font-mono text-sm font-medium">{col}</TableCell>
                      <TableCell>
                        <Badge variant={req === "Yes" ? "destructive" : "secondary"} className="text-xs">
                          {req}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{vals}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={downloadTemplate}>
                <Download className="h-4 w-4 mr-2" />
                Download Template CSV
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Upload */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload File</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="border-2 border-dashed rounded-xl p-10 text-center cursor-pointer hover:border-primary/50 hover:bg-accent/30 transition-all"
              onClick={() => fileInputRef.current?.click()}
            >
              <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              {fileName ? (
                <>
                  <p className="font-medium">{fileName}</p>
                  <p className="text-sm text-muted-foreground mt-1">{preview.length} rows ready to import</p>
                </>
              ) : (
                <>
                  <p className="font-medium">Click to select a CSV file</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Export your Excel workbook as CSV first, then upload here.
                  </p>
                </>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={handleFileChange}
            />
          </CardContent>
        </Card>

        {/* Preview */}
        {preview.length > 0 && !result && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">Preview — {preview.length} rows</CardTitle>
              <Button onClick={handleImport} disabled={importMutation.isPending}>
                <Upload className="h-4 w-4 mr-2" />
                {importMutation.isPending ? "Importing…" : `Import ${preview.length} Rows`}
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-80 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Client Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Client #</TableHead>
                      <TableHead>File #</TableHead>
                      <TableHead>City</TableHead>
                      <TableHead>Matter Type</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.slice(0, 50).map((row, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-muted-foreground text-xs">{i + 2}</TableCell>
                        <TableCell className="font-medium">{row.clientName ?? "—"}</TableCell>
                        <TableCell>{row.clientStatus ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{row.clientNumber ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{row.fileNumber ?? "—"}</TableCell>
                        <TableCell>{row.city ?? "—"}</TableCell>
                        <TableCell>{row.matterType ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                    {preview.length > 50 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground text-sm py-3">
                          … and {preview.length - 50} more rows
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Result */}
        {result && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Import Result</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 border border-green-200">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <div>
                    <p className="text-xs text-muted-foreground">Imported</p>
                    <p className="text-xl font-bold text-green-700">{result.imported}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200">
                  <XCircle className="h-5 w-5 text-red-600" />
                  <div>
                    <p className="text-xs text-muted-foreground">Skipped</p>
                    <p className="text-xl font-bold text-red-700">{result.skipped}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-50 border border-yellow-200">
                  <AlertTriangle className="h-5 w-5 text-yellow-600" />
                  <div>
                    <p className="text-xs text-muted-foreground">Errors</p>
                    <p className="text-xl font-bold text-yellow-700">{result.errors.length}</p>
                  </div>
                </div>
              </div>

              {result.errors.length > 0 && (
                <div>
                  <p className="font-medium text-sm mb-2">Validation Errors:</p>
                  <div className="max-h-60 overflow-y-auto space-y-1">
                    {result.errors.map((err, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm p-2 rounded bg-red-50 border border-red-100">
                        <span className="font-mono text-xs text-muted-foreground shrink-0">Row {err.row}</span>
                        <span className="font-medium text-red-800">{err.field}:</span>
                        <span className="text-red-700">{err.issue}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <Button
                variant="outline"
                onClick={() => { setResult(null); setPreview([]); setFileName(""); }}
              >
                Import Another File
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target?.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

function parseCSV(text: string): ImportRow[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map(h =>
    h.toLowerCase().replace(/\s+/g, " ").trim()
  );

  const headerMap: Record<string, keyof ImportRow> = {
    "client number": "clientNumber",
    "file number": "fileNumber",
    "client name": "clientName",
    "client status": "clientStatus",
    "city": "city",
    "matter type": "matterType",
  };

  const rows: ImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = parseCSVLine(line);
    const row: ImportRow = {};
    headers.forEach((h, idx) => {
      const key = headerMap[h];
      if (key) row[key] = cells[idx]?.trim() || undefined;
    });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
