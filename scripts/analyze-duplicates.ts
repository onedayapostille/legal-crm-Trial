#!/usr/bin/env tsx
/**
 * scripts/analyze-duplicates.ts
 *
 * READ-ONLY analysis of the AlGhazzawi master Excel sheet.
 * Identifies candidate duplicate rows for clients & matters and writes a CSV
 * report. Performs NO database writes and NO file mutations on the workbook.
 *
 * Usage:
 *   npx tsx scripts/analyze-duplicates.ts [path/to/file.xlsx]
 *
 * Output:
 *   scripts/duplicates-report.csv   — candidate duplicates grouped by key
 *
 * Detection keys:
 *   clients : normalized client name + city (when present)
 *   matters : normalized (clientName + matterReference) OR original serial
 *
 * Normalization:
 *   - trim, collapse whitespace
 *   - case-fold (locale-aware lower)
 *   - strip diacritics & Arabic tashkeel
 *   - unify Arabic alef forms (أ إ آ → ا) and ta marbuta (ة → ه)
 */

import { createRequire } from "module";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx") as typeof import("xlsx");

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const args = process.argv.slice(2);
const xlsxArg = args.find(a => !a.startsWith("--"));
const EXCEL_PATH = xlsxArg
  ? path.resolve(xlsxArg)
  : "C:\\Users\\pc\\Downloads\\ghazzawilawfirm\\Copy of Client_Tracker_Professional_v21.xlsx";

const OUT_PATH = path.resolve(__dirname, "duplicates-report.csv");

function normalize(s: unknown): string {
  if (s === null || s === undefined) return "";
  let v = String(s).trim();
  if (!v) return "";
  v = v.replace(/\s+/g, " ");
  v = v.toLowerCase();
  // strip diacritics (Latin)
  v = v.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  // strip Arabic tashkeel
  v = v.replace(/[ً-ْٰ]/g, "");
  // unify alef variants and ta marbuta
  v = v.replace(/[أإآ]/g, "ا").replace(/ة/g, "ه");
  return v;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Headers in the AlGhazzawi workbook sit on the second row of every sheet
// (the first row is a title banner). Parse as arrays-of-arrays, find the
// header row, and map subsequent rows to objects keyed by header.
function loadRows(wb: XLSX.WorkBook, sheetName: string): Record<string, unknown>[] {
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
  // pick the first row that looks like a header (contains 'Client Name')
  let headerIdx = matrix.findIndex(row => Array.isArray(row) && row.some(c => typeof c === "string" && /client name/i.test(c)));
  if (headerIdx < 0) headerIdx = 1; // fall back to row index 1
  const headers = (matrix[headerIdx] as unknown[]).map(h => (h === null || h === undefined ? "" : String(h)));
  const out: Record<string, unknown>[] = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const r = matrix[i] as unknown[];
    if (!Array.isArray(r) || r.every(c => c === null || c === "")) continue;
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      const k = headers[c];
      if (!k) continue;
      obj[k] = r[c] ?? null;
    }
    out.push(obj);
  }
  return out;
}

function pick(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const found = Object.keys(row).find(rk => rk.toLowerCase().trim() === k.toLowerCase().trim());
    if (found && row[found] !== null && row[found] !== "") return String(row[found]);
  }
  return "";
}

type Group = {
  key: string;
  reason: string;
  rows: Array<{ sheet: string; rowNum: number; data: Record<string, unknown> }>;
};

function findDuplicates() {
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`File not found: ${EXCEL_PATH}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(EXCEL_PATH);
  const sheetNames = wb.SheetNames;
  console.error(`Sheets in workbook: ${sheetNames.join(", ")}`);

  const groups: Group[] = [];

  for (const sheetName of sheetNames) {
    const rows = loadRows(wb, sheetName);
    if (rows.length === 0) continue;

    // Generic per-sheet detection on a synthetic key
    const buckets = new Map<string, Group>();
    rows.forEach((row, i) => {
      const clientName    = pick(row, "Client Name", "Client", "clientName");
      const matterRef     = pick(row, "Matter / Reference", "Matter Reference", "Matter Ref", "matterReference");
      const originalSer   = pick(row, "Original Serial", "Serial", "Serial No", "originalSerial", "S/N");
      const city          = pick(row, "City");
      const matterDesc    = pick(row, "Matter Description", "Description", "Acton Taken", "Next Action ", "Next Action");

      const candidates: Array<[string, string]> = [];
      if (clientName && matterRef) {
        candidates.push([`client+matter`, `${normalize(clientName)}|${normalize(matterRef)}`]);
      } else if (clientName && matterDesc) {
        candidates.push([`client+desc`, `${normalize(clientName)}|${normalize(matterDesc).slice(0, 80)}`]);
      } else if (clientName) {
        candidates.push([`client+city`, `${normalize(clientName)}|${normalize(city)}`]);
      }
      if (originalSer) {
        candidates.push([`original_serial`, normalize(originalSer)]);
      }

      for (const [reason, key] of candidates) {
        if (!key || key === "|") continue;
        const k = `${sheetName}::${reason}::${key}`;
        let g = buckets.get(k);
        if (!g) {
          g = { key: k, reason, rows: [] };
          buckets.set(k, g);
        }
        g.rows.push({ sheet: sheetName, rowNum: i + 2, data: row }); // +2 because header + 1-indexed
      }
    });

    for (const g of buckets.values()) {
      if (g.rows.length > 1) groups.push(g);
    }
  }

  // Write CSV
  const out: string[] = [];
  out.push(["group_id", "reason", "sheet", "row_in_sheet", "client_name", "matter_reference", "original_serial", "city", "matter_description"].join(","));
  groups.forEach((g, gi) => {
    for (const r of g.rows) {
      const row = r.data;
      out.push([
        gi + 1,
        g.reason,
        r.sheet,
        r.rowNum,
        csvEscape(pick(row, "Client Name", "Client", "clientName")),
        csvEscape(pick(row, "Matter Reference", "Matter Ref", "matterReference")),
        csvEscape(pick(row, "Original Serial", "Serial", "Serial No", "originalSerial", "S/N")),
        csvEscape(pick(row, "City")),
        csvEscape(pick(row, "Matter Description", "Description")),
      ].join(","));
    }
  });
  fs.writeFileSync(OUT_PATH, out.join("\n"), "utf8");

  console.error(`Found ${groups.length} candidate duplicate group(s) across ${sheetNames.length} sheet(s).`);
  console.error(`Report written to: ${OUT_PATH}`);
  console.error(`This script wrote NO changes to the workbook or the database.`);
}

findDuplicates();
