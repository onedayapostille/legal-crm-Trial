#!/usr/bin/env tsx
/**
 * scripts/import-excel.ts
 *
 * Migrates client data from the AlGhazzawi Excel workbook into the CRM database.
 * Imports into: clients, client_matters, client_lead_details, rejected_clients,
 *               financial_records, client_action_logs
 *
 * Usage:
 *   npm run import:clients                          real import
 *   npm run import:clients -- --dry-run             validate only, no DB writes
 *   npm run import:clients -- /path/to/file.xlsx    custom Excel path
 *   npm run import:clients -- --force               wipe & reimport (clears existing data)
 *
 * Requirements:
 *   DATABASE_URL must be set (via .env or environment)
 */

import "dotenv/config";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
// xlsx is CommonJS-only; use createRequire for ESM compatibility
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx") as typeof import("xlsx");
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../server/db.js";
import {
  clients,
  clientMatters,
  clientLeadDetails,
  rejectedClients,
  financialRecords,
  clientActionLogs,
} from "../drizzle/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── CLI Args ─────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE   = args.includes("--force");
const xlsxArg = args.find(a => !a.startsWith("--"));

const EXCEL_PATH = xlsxArg
  ? path.resolve(xlsxArg)
  : path.resolve(__dirname, "../../Downloads/Copy of Client_Tracker_Professional_v21.xlsx");

// ─── Types ────────────────────────────────────────────────────────────────────

type RowError = { sheet: string; row: number; reason: string };

const report = {
  clients:     { inserted: 0, updated: 0, skipped: 0 },
  matters:     { inserted: 0, skipped: 0 },
  leadDetails: { inserted: 0, updated: 0, skipped: 0 },
  rejected:    { inserted: 0, updated: 0, skipped: 0 },
  financial:   { inserted: 0, skipped: 0 },
  actionLogs:  { inserted: 0, skipped: 0 },
  errors:      [] as RowError[],
};

function addError(sheet: string, row: number, reason: string) {
  report.errors.push({ sheet, row, reason });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalise client numbers: 12234.0 → "12234", strips #REF! */
function normClientNum(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === "#REF!" || s.toLowerCase() === "client number") return null;
  // Excel sometimes stores integer-looking numbers as floats
  const n = Number(s);
  if (!isNaN(n) && Number.isFinite(n)) return String(Math.round(n));
  return s;
}

/** Normalise file numbers; converts "potential" / "rejected" placeholders */
function normFileNum(raw: unknown, clientNum: string | null): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === "#REF!") return null;
  const lo = s.toLowerCase();
  if (lo === "potential" || lo === "rejected") {
    return clientNum ? `${lo}_${clientNum}` : null;
  }
  return s;
}

function cleanStr(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === "" || s === "#REF!" ? null : s;
}

function cleanNum(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === "#REF!") return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : String(n);
}

function cleanDate(raw: unknown): string | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? null : raw.toISOString().split("T")[0];
  }
  const s = String(raw).trim();
  if (!s || s === "#REF!") return null;
  // Already YYYY-MM-DD from dateNF
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
}

function hasRef(row: unknown[]): boolean {
  return row.some(v => String(v) === "#REF!");
}

// ─── Enum Validators ──────────────────────────────────────────────────────────

const V_STATUS     = new Set(["Existing Client", "Leads", "Rejected"]);
const V_CITY       = new Set(["Riyadh", "Dammam", "Jeddah"]);
const V_MATTER     = new Set(["Corporate", "Litigation"]);
const V_FEE        = new Set(["Billable Hours", "Fixed / Project-Based Fees", "Retainers", "Success Fees", "Advisory / Special Mandates", "Blended"]);
const V_DISCOUNT   = new Set(["N/A", "P&L Head Lawyers", "CEO", "Board"]);
const V_COLLECT    = new Set(["Not Billed", "Partially Billed", "Billed", "Partially Collected", "Fully Collected", "Overdue"]);
const V_REJECT     = new Set(["Client", "Us"]);
const V_PRIORITY   = new Set(["low", "medium", "high", "urgent"]);

type ClientStatus   = "Existing Client" | "Leads" | "Rejected";
type City           = "Riyadh" | "Dammam" | "Jeddah";
type MatterType     = "Corporate" | "Litigation";
type FeeType        = "Billable Hours" | "Fixed / Project-Based Fees" | "Retainers" | "Success Fees" | "Advisory / Special Mandates" | "Blended";
type DiscountApproval = "N/A" | "P&L Head Lawyers" | "CEO" | "Board";
type CollectionStatus = "Not Billed" | "Partially Billed" | "Billed" | "Partially Collected" | "Fully Collected" | "Overdue";
type RejectionReason  = "Client" | "Us";
type Priority       = "low" | "medium" | "high" | "urgent";

const vStatus   = (s: string | null): ClientStatus | null    => (s && V_STATUS.has(s)   ? s as ClientStatus   : null);
const vCity     = (s: string | null): City | null            => (s && V_CITY.has(s)     ? s as City           : null);
const vMatter   = (s: string | null): MatterType | null      => (s && V_MATTER.has(s)   ? s as MatterType     : null);
const vFee      = (s: string | null): FeeType | null         => (s && V_FEE.has(s)      ? s as FeeType        : null);
const vDiscount = (s: string | null): DiscountApproval       => (s && V_DISCOUNT.has(s) ? s as DiscountApproval : "N/A");
const vCollect  = (s: string | null): CollectionStatus       => (s && V_COLLECT.has(s)  ? s as CollectionStatus : "Not Billed");
const vReject   = (s: string | null): RejectionReason | null => (s && V_REJECT.has(s)   ? s as RejectionReason : null);
const vPriority = (s: string | null): Priority               => {
  const lo = s?.toLowerCase() ?? "";
  return V_PRIORITY.has(lo) ? lo as Priority : "medium";
};

// ─── Sheet Reader ─────────────────────────────────────────────────────────────

/** Returns data rows from a sheet, skipping the first `skipRows` rows (header + label rows). */
function sheetRows(wb: XLSX.WorkBook, name: string, skipRows = 2): unknown[][] {
  const ws = wb.Sheets[name];
  if (!ws) { console.warn(`  ⚠  Sheet "${name}" not found`); return []; }
  const all = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    raw: true,
  }) as unknown[][];
  return all
    .slice(skipRows)
    .filter(row => row.some(v => v != null && v !== ""));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  AlGhazzawi CRM — Excel Import");
  console.log(`  Mode   : ${DRY_RUN ? "DRY RUN (no DB writes)" : FORCE ? "FORCE (wipe & reimport)" : "LIVE"}`);
  console.log(`  Source : ${EXCEL_PATH}`);
  console.log("══════════════════════════════════════════════════════\n");

  // Read workbook
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.readFile(EXCEL_PATH, { cellDates: true });
  } catch (e: any) {
    console.error(`✗ Cannot open Excel file: ${e.message}`);
    process.exit(1);
  }

  const db = DRY_RUN ? null : getDb();

  // ── 1. CLIENT LIST → clients table ─────────────────────────────────────────
  console.log("Step 1/6 — Importing clients from 'Client List'…");

  // Client List: row 0 = blank, row 1 = headers, row 2+ = data
  const clRows = sheetRows(wb, "Client List", 2);
  // Also pull from Leads and Rejected sheets to catch clients not in Client List
  const leadsRows    = sheetRows(wb, "Leads", 2);
  const rejectedRows = sheetRows(wb, "Rejected", 2);

  // Build merged client list (Client List is authoritative; Leads/Rejected fill gaps)
  type ClientRow = { clientNumber: string | null; fileNumber: string | null; clientName: string; status: ClientStatus; city: City | null; matterType: MatterType | null };
  const clientMap = new Map<string, ClientRow>(); // keyed by normalised fileNumber

  const addClientRow = (row: unknown[], sheet: string, rowNum: number) => {
    if (hasRef(row as unknown[])) { addError(sheet, rowNum, "#REF! error — row skipped"); return; }
    const clientNum  = normClientNum(row[0]);
    const fileNumRaw = cleanStr(row[1]);
    const fileNum    = normFileNum(row[1], clientNum);
    const name       = cleanStr(row[2]);
    const status     = vStatus(cleanStr(row[3]));
    const city       = vCity(cleanStr(row[4]));
    const matter     = vMatter(cleanStr(row[5]));

    if (!name) { addError(sheet, rowNum, "Missing client name"); return; }
    if (!status) { addError(sheet, rowNum, `Invalid status: "${cleanStr(row[3])}"`); return; }

    const key = fileNum ?? `name_${name.toLowerCase().replace(/\s+/g, "_")}`;
    clientMap.set(key, { clientNumber: clientNum, fileNumber: fileNum, clientName: name, status, city, matterType: matter });
  };

  clRows.forEach((r, i)    => addClientRow(r, "Client List", i + 3));
  leadsRows.forEach((r, i) => {
    const clientNum = normClientNum(r[0]);
    const fileNum   = normFileNum(r[1], clientNum); // "potential" → "potential_77"
    const key = fileNum ?? `name_${cleanStr(r[2])?.toLowerCase().replace(/\s+/g, "_")}`;
    if (!clientMap.has(key)) addClientRow(r, "Leads", i + 3);
  });
  rejectedRows.forEach((r, i) => {
    const clientNum = normClientNum(r[0]);
    const fileNum   = normFileNum(r[1], clientNum); // "rejected" → "rejected_72"
    const key = fileNum ?? `name_${cleanStr(r[2])?.toLowerCase().replace(/\s+/g, "_")}`;
    if (!clientMap.has(key)) addClientRow(r, "Rejected", i + 3);
  });

  console.log(`  Parsed ${clientMap.size} unique clients`);

  // Insert/upsert clients → build id map
  const clientIdMap = new Map<string, number>(); // fileNumber → DB id

  if (!DRY_RUN && db) {
    for (const [key, c] of clientMap) {
      try {
        if (c.fileNumber) {
          // Upsert by fileNumber (unique)
          const [row] = await db
            .insert(clients)
            .values({
              clientNumber: c.clientNumber ?? undefined,
              fileNumber:   c.fileNumber,
              clientName:   c.clientName,
              clientStatus: c.status,
              city:         c.city ?? undefined,
              matterType:   c.matterType ?? undefined,
            })
            .onConflictDoUpdate({
              target: clients.fileNumber,
              set: {
                clientName:   c.clientName,
                clientStatus: c.status,
                city:         c.city ?? undefined,
                matterType:   c.matterType ?? undefined,
                updatedAt:    new Date(),
              },
            })
            .returning({ id: clients.id });

          clientIdMap.set(key, row.id);
          report.clients.inserted++; // drizzle upsert always returns a row
        } else {
          // No file number — try clientNumber unique key, else match by name
          if (c.clientNumber) {
            const [row] = await db
              .insert(clients)
              .values({
                clientNumber: c.clientNumber,
                clientName:   c.clientName,
                clientStatus: c.status,
                city:         c.city ?? undefined,
                matterType:   c.matterType ?? undefined,
              })
              .onConflictDoUpdate({
                target: clients.clientNumber,
                set: {
                  clientName:   c.clientName,
                  clientStatus: c.status,
                  city:         c.city ?? undefined,
                  matterType:   c.matterType ?? undefined,
                  updatedAt:    new Date(),
                },
              })
              .returning({ id: clients.id });
            clientIdMap.set(key, row.id);
            report.clients.inserted++;
          } else {
            report.clients.skipped++;
          }
        }
      } catch (e: any) {
        addError("Client List", 0, `DB error for "${c.clientName}": ${e.message}`);
        report.clients.skipped++;
      }
    }
  } else {
    // Dry run — assign fake sequential IDs so downstream lookups work
    let fakeId = 1;
    for (const [key] of clientMap) {
      clientIdMap.set(key, fakeId++);
    }
    report.clients.inserted = clientMap.size;
  }

  console.log(`  ✓ ${report.clients.inserted} upserted, ${report.clients.skipped} skipped\n`);

  // ── Helper: resolve clientId from a data row ──────────────────────────────

  const resolveClientId = async (
    clientNum: string | null,
    fileNum: string | null,
    sheet: string,
    rowNum: number,
  ): Promise<number | null> => {
    // Try fileNumber key first (most reliable)
    if (fileNum && clientIdMap.has(fileNum)) return clientIdMap.get(fileNum)!;

    // Try clientNumber-based synthetic key for leads/rejected
    if (fileNum) {
      const lo = fileNum.split("_")[0];
      if (lo === "potential" || lo === "rejected") {
        if (clientIdMap.has(fileNum)) return clientIdMap.get(fileNum)!;
      }
    }

    // Fall back to DB lookup
    if (!DRY_RUN && db) {
      if (fileNum) {
        const [r] = await db.select({ id: clients.id }).from(clients).where(eq(clients.fileNumber, fileNum));
        if (r) { clientIdMap.set(fileNum, r.id); return r.id; }
      }
      if (clientNum) {
        const [r] = await db.select({ id: clients.id }).from(clients).where(eq(clients.clientNumber, clientNum));
        if (r) { if (fileNum) clientIdMap.set(fileNum, r.id); return r.id; }
      }
    }

    addError(sheet, rowNum, `Client not found: clientNum=${clientNum}, fileNum=${fileNum}`);
    return null;
  };

  // ── 2. AUTOMATION → client_matters ────────────────────────────────────────
  console.log("Step 2/6 — Importing client matters from 'Automation'…");

  const autoRows = sheetRows(wb, "Automation", 2);

  // Collect all client IDs we'll touch so we can clear old matters first
  const matterClientIds = new Set<number>();

  type MatterRecord = {
    clientId: number;
    originalSerial: string | null;
    matterReference: string | null;
    matterType: string | null;
    leadPartner: string | null;
    leadPartnerFullName: string | null;
    supportLead: string | null;
    attorneyHead: string | null;
    attorneyFullName: string | null;
    matterStatus: string | null;
    balanceWorkLeft: string | null;
    achievementPercentage: string | null;
    achievementStatus: string | null;
    priority: Priority;
  };

  const matterRecords: MatterRecord[] = [];

  for (let i = 0; i < autoRows.length; i++) {
    const row = autoRows[i];
    const rowNum = i + 3; // 1-indexed, skipped 2 header rows

    if (hasRef(row as unknown[])) {
      addError("Automation", rowNum, "#REF! error — row skipped");
      report.matters.skipped++;
      continue;
    }

    const clientNum = normClientNum(row[0]);
    const fileNum   = normFileNum(row[1], clientNum);
    const matterRef = cleanStr(row[6]);

    // Skip rows where there's no matter reference (just client info rows)
    // Actually Automation has one row per matter, so we process all non-empty rows
    const clientId = await resolveClientId(clientNum, fileNum, "Automation", rowNum);
    if (!clientId) { report.matters.skipped++; continue; }

    matterClientIds.add(clientId);

    // Original Serial must be matter-specific, never a copy of the client number.
    // If the source column mirrors the client number, drop it (it'll be left blank
    // rather than wrongly showing the client number as the matter serial).
    const rawSerial = cleanStr(row[5]);
    const originalSerial =
      rawSerial && clientNum && rawSerial.trim() === String(clientNum).trim() ? null : rawSerial;

    matterRecords.push({
      clientId,
      originalSerial,
      matterReference:       matterRef,
      matterType:            cleanStr(row[7]),
      leadPartner:           cleanStr(row[8]),
      leadPartnerFullName:   cleanStr(row[9]),
      supportLead:           cleanStr(row[10]),
      attorneyHead:          cleanStr(row[11]),
      attorneyFullName:      cleanStr(row[12]),
      matterStatus:          cleanStr(row[13]),
      balanceWorkLeft:       cleanNum(row[14]),
      achievementPercentage: cleanNum(row[15]),
      achievementStatus:     cleanStr(row[16]),
      priority:              vPriority(cleanStr(row[21])),
    });
  }

  if (!DRY_RUN && db && matterClientIds.size > 0) {
    // Clear existing matters for these clients (idempotency)
    if (FORCE || true) { // always clear & reimport for correctness
      await db.delete(clientMatters).where(inArray(clientMatters.clientId, [...matterClientIds]));
    }
    // Batch insert
    const BATCH = 50;
    for (let i = 0; i < matterRecords.length; i += BATCH) {
      const slice = matterRecords.slice(i, i + BATCH);
      await db.insert(clientMatters).values(slice.map(m => ({
        clientId:              m.clientId,
        originalSerial:        m.originalSerial   ?? undefined,
        matterReference:       m.matterReference  ?? undefined,
        matterType:            m.matterType       ?? undefined,
        leadPartner:           m.leadPartner      ?? undefined,
        leadPartnerFullName:   m.leadPartnerFullName ?? undefined,
        supportLead:           m.supportLead      ?? undefined,
        attorneyHead:          m.attorney1        ?? undefined,
        attorneyFullName:      m.attorneyFullName ?? undefined,
        matterStatus:          m.matterStatus     ?? undefined,
        balanceWorkLeft:       m.balanceWorkLeft  ?? undefined,
        achievementPercentage: m.achievementPercentage ?? undefined,
        achievementStatus:     m.achievementStatus ?? undefined,
        priority:              m.priority,
      })));
      report.matters.inserted += slice.length;
    }
  } else {
    report.matters.inserted = matterRecords.length;
    report.matters.skipped  += autoRows.length - matterRecords.length;
  }

  console.log(`  ✓ ${report.matters.inserted} inserted, ${report.matters.skipped} skipped\n`);

  // ── 3. LEADS → client_lead_details ────────────────────────────────────────
  console.log("Step 3/6 — Importing lead details from 'Leads'…");

  for (let i = 0; i < leadsRows.length; i++) {
    const row    = leadsRows[i];
    const rowNum = i + 3;

    if (hasRef(row as unknown[])) {
      addError("Leads", rowNum, "#REF! error — row skipped");
      report.leadDetails.skipped++;
      continue;
    }

    const clientNum = normClientNum(row[0]);
    const fileNum   = normFileNum(row[1], clientNum);
    const clientId  = await resolveClientId(clientNum, fileNum, "Leads", rowNum);
    if (!clientId) { report.leadDetails.skipped++; continue; }

    const record = {
      clientId,
      clientSource:     cleanStr(row[12]) ?? undefined,
      nextActionDate:   cleanDate(row[13]) ?? undefined,
      nextActionDate2:  cleanDate(row[14]) ?? undefined,
      nextActionOwner:  cleanStr(row[15])  ?? undefined,
      priority:         vPriority(cleanStr(row[16])),
      leadStatus:       cleanStr(row[11])  ?? undefined, // matterStatus used as lead status
    };

    if (!DRY_RUN && db) {
      try {
        await db
          .insert(clientLeadDetails)
          .values(record)
          .onConflictDoUpdate({
            target: clientLeadDetails.clientId,
            set: {
              clientSource:    record.clientSource,
              nextActionDate:  record.nextActionDate,
              nextActionDate2: record.nextActionDate2,
              nextActionOwner: record.nextActionOwner,
              priority:        record.priority,
              leadStatus:      record.leadStatus,
              updatedAt:       new Date(),
            },
          });
        report.leadDetails.inserted++;
      } catch (e: any) {
        addError("Leads", rowNum, `DB error: ${e.message}`);
        report.leadDetails.skipped++;
      }
    } else {
      report.leadDetails.inserted++;
    }
  }

  console.log(`  ✓ ${report.leadDetails.inserted} upserted, ${report.leadDetails.skipped} skipped\n`);

  // ── 4. REJECTED → rejected_clients ────────────────────────────────────────
  console.log("Step 4/6 — Importing rejected clients from 'Rejected'…");

  for (let i = 0; i < rejectedRows.length; i++) {
    const row    = rejectedRows[i];
    const rowNum = i + 3;

    if (hasRef(row as unknown[])) {
      addError("Rejected", rowNum, "#REF! error — row skipped");
      report.rejected.skipped++;
      continue;
    }

    const clientNum = normClientNum(row[0]);
    const fileNum   = normFileNum(row[1], clientNum);
    const clientId  = await resolveClientId(clientNum, fileNum, "Rejected", rowNum);
    if (!clientId) { report.rejected.skipped++; continue; }

    const record = {
      clientId,
      rejectionReasonSource: vReject(cleanStr(row[14])) ?? undefined,
      rejectionNotes:        cleanStr(row[12]) ?? undefined, // matterStatus column has rejection notes
      rejectedBy:            cleanStr(row[8])  ?? undefined, // leadPartner
    };

    if (!DRY_RUN && db) {
      try {
        await db
          .insert(rejectedClients)
          .values(record)
          .onConflictDoUpdate({
            target: rejectedClients.clientId,
            set: {
              rejectionReasonSource: record.rejectionReasonSource,
              rejectionNotes:        record.rejectionNotes,
              rejectedBy:            record.rejectedBy,
            },
          });
        report.rejected.inserted++;
      } catch (e: any) {
        addError("Rejected", rowNum, `DB error: ${e.message}`);
        report.rejected.skipped++;
      }
    } else {
      report.rejected.inserted++;
    }
  }

  console.log(`  ✓ ${report.rejected.inserted} upserted, ${report.rejected.skipped} skipped\n`);

  // ── 5. FINANCIAL → financial_records ──────────────────────────────────────
  console.log("Step 5/6 — Importing financial records from 'Financial'…");

  // Financial sheet: row 0 = restricted label, row 1 = headers, row 2+ = data
  const finRows = sheetRows(wb, "Financial", 2);
  const finClientIds = new Set<number>();

  type FinRecord = {
    clientId: number;
    feeType: FeeType | null;
    agreedFees: string | null;
    discountApproval: DiscountApproval;
    discountPercentage: string | null;
    discountAmount: string | null;
    netFees: string | null;
    billedAmount: string | null;
    revenue: string | null;
    collectedAmount: string | null;
    remainingAdvanced: string | null;
    outstandingAmount: string | null;
    collectionStatus: CollectionStatus;
    billingDate: string | null;
    paymentDate: string | null;
    invoiceNumber: string | null;
    responsibleLawyer: string | null;
    financeNotes: string | null;
  };

  const finRecords: FinRecord[] = [];

  for (let i = 0; i < finRows.length; i++) {
    const row    = finRows[i];
    const rowNum = i + 3;

    if (hasRef(row as unknown[])) {
      addError("Financial", rowNum, "#REF! error — row skipped");
      report.financial.skipped++;
      continue;
    }

    const clientNum = normClientNum(row[0]);
    const fileNum   = normFileNum(row[1], clientNum);
    const clientId  = await resolveClientId(clientNum, fileNum, "Financial", rowNum);
    if (!clientId) { report.financial.skipped++; continue; }

    finClientIds.add(clientId);
    finRecords.push({
      clientId,
      feeType:            vFee(cleanStr(row[10])),
      agreedFees:         cleanNum(row[11]),
      discountApproval:   vDiscount(cleanStr(row[12])),
      discountPercentage: cleanNum(row[13]),
      discountAmount:     cleanNum(row[14]),
      netFees:            cleanNum(row[15]),
      billedAmount:       cleanNum(row[16]),
      revenue:            cleanNum(row[17]),
      collectedAmount:    cleanNum(row[18]),
      remainingAdvanced:  cleanNum(row[19]),
      outstandingAmount:  cleanNum(row[20]),
      collectionStatus:   vCollect(cleanStr(row[21])),
      billingDate:        cleanDate(row[22]),
      paymentDate:        cleanDate(row[23]),
      invoiceNumber:      cleanStr(row[24]),
      responsibleLawyer:  cleanStr(row[25]),
      financeNotes:       cleanStr(row[26]),
    });
  }

  if (!DRY_RUN && db && finClientIds.size > 0) {
    // Clear existing financial records for these clients (idempotency)
    await db.delete(financialRecords).where(inArray(financialRecords.clientId, [...finClientIds]));

    const BATCH = 50;
    for (let i = 0; i < finRecords.length; i += BATCH) {
      const slice = finRecords.slice(i, i + BATCH);
      await db.insert(financialRecords).values(slice.map(f => ({
        clientId:           f.clientId,
        feeType:            f.feeType           ?? undefined,
        agreedFees:         f.agreedFees        ?? undefined,
        discountApproval:   f.discountApproval,
        discountPercentage: f.discountPercentage ?? undefined,
        discountAmount:     f.discountAmount    ?? undefined,
        netFees:            f.netFees           ?? undefined,
        billedAmount:       f.billedAmount      ?? undefined,
        revenue:            f.revenue           ?? undefined,
        collectedAmount:    f.collectedAmount   ?? undefined,
        remainingAdvanced:  f.remainingAdvanced ?? undefined,
        outstandingAmount:  f.outstandingAmount ?? undefined,
        collectionStatus:   f.collectionStatus,
        billingDate:        f.billingDate       ?? undefined,
        paymentDate:        f.paymentDate       ?? undefined,
        invoiceNumber:      f.invoiceNumber     ?? undefined,
        responsibleLawyer:  f.responsibleLawyer ?? undefined,
        financeNotes:       f.financeNotes      ?? undefined,
      })));
      report.financial.inserted += slice.length;
    }
  } else {
    report.financial.inserted = finRecords.length;
    report.financial.skipped  += finRows.length - finRecords.length;
  }

  console.log(`  ✓ ${report.financial.inserted} inserted, ${report.financial.skipped} skipped\n`);

  // ── 6. CLIENT ACTION LOG → client_action_logs ─────────────────────────────
  console.log("Step 6/6 — Importing action log from 'Client Action Log'…");

  const actionRows = sheetRows(wb, "Client Action Log", 2);
  const actionClientIds = new Set<number>();

  type ActionRecord = {
    clientId: number;
    actionOwner: string | null;
    nextStep: string | null;
    actionDate: string | null;
    actionType: string | null;
    actionDetails: string | null;
  };

  const actionRecords: ActionRecord[] = [];

  for (let i = 0; i < actionRows.length; i++) {
    const row    = actionRows[i];
    const rowNum = i + 3;

    if (hasRef(row as unknown[])) {
      addError("Client Action Log", rowNum, "#REF! error — row skipped");
      report.actionLogs.skipped++;
      continue;
    }

    // Skip rows that have no meaningful action data
    const actionOwner   = cleanStr(row[6]);
    const nextStep      = cleanStr(row[7]);
    const actionDate    = cleanDate(row[8]);
    const actionType    = cleanStr(row[9]);
    const actionDetails = cleanStr(row[10]);

    if (!actionOwner && !nextStep && !actionDate && !actionType && !actionDetails) {
      report.actionLogs.skipped++;
      continue;
    }

    const clientNum = normClientNum(row[0]);
    const fileNum   = normFileNum(row[1], clientNum);
    const clientId  = await resolveClientId(clientNum, fileNum, "Client Action Log", rowNum);
    if (!clientId) { report.actionLogs.skipped++; continue; }

    actionClientIds.add(clientId);
    actionRecords.push({ clientId, actionOwner, nextStep, actionDate, actionType, actionDetails });
  }

  if (!DRY_RUN && db && actionClientIds.size > 0) {
    // Clear existing logs for these clients (idempotency)
    await db.delete(clientActionLogs).where(inArray(clientActionLogs.clientId, [...actionClientIds]));

    const BATCH = 50;
    for (let i = 0; i < actionRecords.length; i += BATCH) {
      const slice = actionRecords.slice(i, i + BATCH);
      await db.insert(clientActionLogs).values(slice.map(a => ({
        clientId:      a.clientId,
        actionOwner:   a.actionOwner   ?? undefined,
        nextStep:      a.nextStep      ?? undefined,
        actionDate:    a.actionDate    ?? undefined,
        actionType:    a.actionType    ?? undefined,
        actionDetails: a.actionDetails ?? undefined,
      })));
      report.actionLogs.inserted += slice.length;
    }
  } else {
    report.actionLogs.inserted = actionRecords.length;
    report.actionLogs.skipped  += actionRows.length - actionRecords.length;
  }

  console.log(`  ✓ ${report.actionLogs.inserted} inserted, ${report.actionLogs.skipped} skipped\n`);

  // ── Print Report ──────────────────────────────────────────────────────────
  printReport();

  // Close DB connection
  if (!DRY_RUN) {
    const { getRawClient } = await import("../server/db.js");
    await getRawClient().end().catch(() => {});
  }

  process.exit(report.errors.length > 0 ? 1 : 0);
}

function printReport() {
  const t = report;
  console.log("══════════════════════════════════════════════════════");
  console.log("  IMPORT REPORT");
  console.log("══════════════════════════════════════════════════════");
  console.log(`  Clients         : ${t.clients.inserted} upserted, ${t.clients.skipped} skipped`);
  console.log(`  Client Matters  : ${t.matters.inserted} inserted, ${t.matters.skipped} skipped`);
  console.log(`  Lead Details    : ${t.leadDetails.inserted} upserted, ${t.leadDetails.skipped} skipped`);
  console.log(`  Rejected        : ${t.rejected.inserted} upserted, ${t.rejected.skipped} skipped`);
  console.log(`  Financial       : ${t.financial.inserted} inserted, ${t.financial.skipped} skipped`);
  console.log(`  Action Logs     : ${t.actionLogs.inserted} inserted, ${t.actionLogs.skipped} skipped`);
  console.log(`  Validation Errs : ${t.errors.length}`);
  console.log("──────────────────────────────────────────────────────");

  if (t.errors.length > 0) {
    console.log("\n  ERRORS:");
    t.errors.slice(0, 50).forEach(e => {
      console.log(`    [${e.sheet}] row ${e.row}: ${e.reason}`);
    });
    if (t.errors.length > 50) {
      console.log(`    … and ${t.errors.length - 50} more`);
    }
    console.log();
  }

  const mode = (global as any).__dryRun ? "DRY RUN — no data was written." : "Import complete.";
  console.log(`\n  ${mode}\n`);
}

main().catch(err => {
  console.error("\n✗ Fatal error:", err);
  process.exit(1);
});
