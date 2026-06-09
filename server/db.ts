import { and, count, desc, eq, gte, inArray, lte, ne, or, sql, ilike } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { TRPCError } from "@trpc/server";
import postgres from "postgres";
import fs from "fs";
import path from "path";
import {
  users, companies, leads, matters, tasks, notes, documents, payments,
  activityLogs, auditLogs, chatSubmissions,
  clients, clientMatters, clientLeadDetails, rejectedClients,
  financialRecords, clientActionLogs, matterLawyerRates, systemSettings,
  type InsertUser, type InsertLead, type InsertMatter,
  type InsertTask, type InsertNote, type InsertPayment,
  type InsertCompany, type InsertActivityLog, type InsertChatSubmission,
  type InsertClient, type InsertClientMatter, type InsertClientLeadDetail,
  type InsertRejectedClient, type InsertFinancialRecord, type InsertClientActionLog,
  type InsertMatterLawyerRate,
} from "../drizzle/schema";
import { hashPassword } from "./_core/auth";
import type { UserRole, UserStatus } from "../shared/const";

// ─── DB Connection ────────────────────────────────────────────────────────────

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

function shouldUseSsl(databaseUrl: string) {
  try {
    const parsed = new URL(databaseUrl);
    return parsed.searchParams.get("sslmode") === "require" || parsed.hostname.endsWith(".supabase.co");
  } catch {
    return databaseUrl.includes("sslmode=require") || databaseUrl.includes(".supabase.co");
  }
}

function shouldDisablePreparedStatements(databaseUrl: string) {
  try {
    const parsed = new URL(databaseUrl);
    return parsed.hostname.includes(".pooler.supabase.com") && parsed.port === "6543";
  } catch {
    return databaseUrl.includes(".pooler.supabase.com:6543");
  }
}

const leadStatusAliases: Record<string, string> = {
  Pending: "New",
  Declined: "Lost",
  Conflict: "On Hold",
  "Not Pursued": "Lost",
};

function sanitizeLeadInput(data: Record<string, unknown>) {
  const sanitized = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== "")
  ) as Record<string, unknown>;

  if (typeof sanitized.currentStatus === "string") {
    sanitized.currentStatus = leadStatusAliases[sanitized.currentStatus] ?? sanitized.currentStatus;
  }

  return sanitized;
}

function sanitizeOptionalInput(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== "")
  ) as Record<string, unknown>;
}

// Trim strings, drop empty / "0" placeholders for optional varchar fields, and
// validate numeric strings. Returns a fresh object safe to spread into a Drizzle
// insert/update for client_matters.
//
// Special case: `billingType` may be passed as `null` to explicitly clear the
// nullable enum column — null is preserved for this field only.
function sanitizeClientMatterInput(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(data)) {
    // Allow explicit null for billingType to clear the enum column
    if (key === "billingType") {
      out[key] = raw === undefined ? undefined : (raw ?? null);
      if (out[key] === undefined) delete out[key];
      continue;
    }
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      // numeric fields: must parse as a finite number
      if (key === "balanceWorkLeft" || key === "achievementPercentage") {
        const n = Number(trimmed);
        if (!Number.isFinite(n)) {
          throw new Error(`Invalid number for ${key}: "${trimmed}"`);
        }
        out[key] = String(n);
        continue;
      }
      out[key] = trimmed;
    } else {
      out[key] = raw;
    }
  }
  return out;
}

// Fixed discount-rate table matching the Excel workbook formula exactly:
//   N: Discount% = IF(M="P&L Head Lawyers",5%,IF(M="CEO",10%,IF(M="Board",15%,0)))
//   O: Discount Amount = ROUND(AgreedFees × Discount%, 2)
//   P: Net Fees = MAX(0, AgreedFees − DiscountAmount)
//   T: Remaining Advanced = BilledAmount − Revenue
//   U: Outstanding Amount = MAX(0, BilledAmount − CollectedAmount)
const DISCOUNT_RATES: Record<string, number> = {
  "N/A": 0,
  "P&L Head Lawyers": 5,
  "CEO": 10,
  "Board": 15,
};

// All financial calculated fields are derived — none are user inputs except
// discountApproval, agreedFees, billedAmount, revenue, and collectedAmount.
export function applyDiscountRules(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };

  const approval = String(out.discountApproval ?? "N/A");
  const pct = DISCOUNT_RATES[approval] ?? 0;
  const agreed = toNum(out.agreedFees) ?? 0;
  const discountAmt = round2(agreed * pct / 100);
  const netFees = round2(Math.max(0, agreed - discountAmt));

  out.discountPercentage = String(pct);
  out.discountAmount     = String(discountAmt);
  out.netFees            = String(netFees);

  // "Revenue" is now the single amount field. "Billed Amount" was removed from the
  // forms (it duplicated Revenue). We keep the billed_amount COLUMN as a
  // compatibility alias — always mirrored to revenue on write — so historical
  // readers and any missed report keep working and stay consistent.
  const revenue   = toNum(out.revenue)         ?? 0;
  const billed    = revenue; // alias
  const collected = toNum(out.collectedAmount) ?? 0;

  out.billedAmount      = String(round2(billed)); // mirror revenue
  out.remainingAdvanced = String(round2(billed - revenue)); // = 0 (kept for the column)
  out.outstandingAmount = String(round2(Math.max(0, revenue - collected)));

  return out;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    _client = postgres(url, {
      max: 10,
      ssl: shouldUseSsl(url) ? "require" : false,
      prepare: !shouldDisablePreparedStatements(url),
      connect_timeout: 10,
      idle_timeout: 30,
    });
    _db = drizzle(_client);
  }
  return _db;
}

export function getRawClient() {
  getDb(); // ensure _client is created
  return _client!;
}

// ─── Auto Migration ───────────────────────────────────────────────────────────

export async function runMigrations() {
  const client = getRawClient();
  const candidates = [
    path.resolve(process.cwd(), "drizzle/migrations"),
    path.resolve(process.cwd(), "drizzle", "migrations"),
    path.resolve(import.meta.dirname ?? __dirname, "../../drizzle/migrations"),
  ];

  let migrationsDir: string | null = null;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      migrationsDir = candidate;
      break;
    }
  }

  if (!migrationsDir) {
    console.warn("[DB] Migration directory not found - skipping (tables may already exist)");
    return;
  }

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter(file => file.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const fullPath = path.resolve(migrationsDir, file);
    const sqlContent = fs.readFileSync(fullPath, "utf-8");
    console.log(`[DB] Running migration from: ${fullPath}`);

    try {
      await client.unsafe(sqlContent);
      console.log(`[DB] Migration applied: ${file}`);
    } catch (err: any) {
      if (err?.message?.includes("already exists")) {
        console.log(`[DB] Migration skipped (already exists): ${file}`);
      } else {
        throw err;
      }
    }
  }
}

export async function getUserById(id: number) {
  const db = getDb();
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0] ?? null;
}

export async function getUserByEmail(email: string) {
  const db = getDb();
  const result = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
  return result[0] ?? null;
}

export async function getAllUsers() {
  const db = getDb();
  return db.select().from(users).orderBy(desc(users.createdAt));
}

export async function createUser(data: InsertUser) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    ...data,
    email: normalizeEmail(data.email),
  }).returning();
  return user;
}

export async function updateUser(id: number, data: Partial<InsertUser>) {
  const db = getDb();
  const nextData = {
    ...data,
    ...(data.email ? { email: normalizeEmail(data.email) } : {}),
    updatedAt: new Date(),
  };
  const [user] = await db.update(users).set(nextData).where(eq(users.id, id)).returning();
  return user;
}

export async function updateUserRole(userId: number, role: UserRole) {
  const db = getDb();
  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function updateUserStatus(userId: number, status: UserStatus) {
  const db = getDb();
  await db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function updateLastLogin(userId: number) {
  const db = getDb();
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
}

/** Create default admin on first boot if no users exist */
export async function ensureAdminExists() {
  const db = getDb();
  const existing = await db.select({ count: count() }).from(users);
  if ((existing[0]?.count ?? 0) > 0) return;

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || "System Administrator";

  if (!email || !password) {
    console.warn("[DB] No users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD, then run the seed script or restart.");
    return;
  }

  const hash = await hashPassword(password);
  await db.insert(users).values({
    email: normalizeEmail(email),
    name,
    passwordHash: hash,
    role: "admin",
    status: "active",
  });
  console.log(`[DB] Initial admin created for ${normalizeEmail(email)}`);
}

export async function countActiveAdmins(excludeUserId?: number) {
  const db = getDb();
  const conditions = [
    eq(users.role, "admin"),
    eq(users.status, "active"),
  ];
  if (excludeUserId) conditions.push(ne(users.id, excludeUserId));
  const [row] = await db.select({ count: count() }).from(users).where(and(...conditions));
  return Number(row?.count ?? 0);
}

export async function deleteUser(id: number) {
  const db = getDb();
  await db.transaction(async tx => {
    await tx.update(companies).set({ createdBy: null }).where(eq(companies.createdBy, id));
    await tx.update(leads).set({ createdBy: null }).where(eq(leads.createdBy, id));
    await tx.update(leads).set({ assignedTo: null }).where(eq(leads.assignedTo, id));
    await tx.update(matters).set({ createdBy: null }).where(eq(matters.createdBy, id));
    await tx.update(matters).set({ assignedTo: null }).where(eq(matters.assignedTo, id));
    await tx.update(tasks).set({ createdBy: null }).where(eq(tasks.createdBy, id));
    await tx.update(tasks).set({ assignedTo: null }).where(eq(tasks.assignedTo, id));
    await tx.update(notes).set({ createdBy: null }).where(eq(notes.createdBy, id));
    await tx.update(documents).set({ uploadedBy: null }).where(eq(documents.uploadedBy, id));
    await tx.update(activityLogs).set({ performedBy: null }).where(eq(activityLogs.performedBy, id));
    await tx.update(auditLogs).set({ userId: null }).where(eq(auditLogs.userId, id));
    await tx.update(chatSubmissions).set({ assignedTo: null }).where(eq(chatSubmissions.assignedTo, id));
    await tx.delete(users).where(eq(users.id, id));
  });
}

// ─── Companies ────────────────────────────────────────────────────────────────

export async function getAllCompanies() {
  const db = getDb();
  return db.select().from(companies).orderBy(companies.name);
}

export async function getCompanyById(id: number) {
  const db = getDb();
  const result = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  return result[0] ?? null;
}

export async function createCompany(data: InsertCompany) {
  const db = getDb();
  const [company] = await db.insert(companies).values(data).returning();
  return company;
}

export async function updateCompany(id: number, data: Partial<InsertCompany>) {
  const db = getDb();
  const [company] = await db
    .update(companies)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(companies.id, id))
    .returning();
  return company;
}

// ─── Leads ────────────────────────────────────────────────────────────────────

export async function generateLeadCode(): Promise<string> {
  const db = getDb();
  const result = await db
    .select({ maxId: sql<number>`COALESCE(MAX(${leads.id}), 0)` })
    .from(leads);
  const next = (Number(result[0]?.maxId) || 0) + 1;
  return `LEAD-${String(next).padStart(4, "0")}`;
}

export async function getAllLeads() {
  const db = getDb();
  return db.select().from(leads).orderBy(desc(leads.createdAt));
}

export async function getLeadById(id: number) {
  const db = getDb();
  const result = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  return result[0] ?? null;
}

export async function createLead(data: Record<string, unknown>, userId: number) {
  const db = getDb();
  const leadCode = await generateLeadCode();
  const sanitized = sanitizeLeadInput(data);

  const [lead] = await db
    .insert(leads)
    .values({ ...(sanitized as InsertLead), leadCode, createdBy: userId })
    .returning();

  await logActivity({
    entityType: "lead",
    entityId: lead.id,
    action: "created",
    description: `Lead ${leadCode} created for ${data.clientName}`,
    performedBy: userId,
  });

  return lead;
}

export async function updateLead(id: number, data: Record<string, unknown>) {
  const db = getDb();
  const sanitized = sanitizeLeadInput(data);
  if ((sanitized.currentStatus === "Converted" || sanitized.conversionDate) && !sanitized.matterCode) {
    const existing = await getLeadById(id);
    if (!existing?.matterCode) {
      sanitized.matterCode = await generateMatterCode();
    }
  }
  const [lead] = await db
    .update(leads)
    .set({ ...(sanitized as Partial<InsertLead>), updatedAt: new Date() })
    .where(eq(leads.id, id))
    .returning();
  return lead;
}

export async function deleteLead(id: number) {
  const db = getDb();
  await db.delete(leads).where(eq(leads.id, id));
}

export async function getLeadStatusSummary() {
  const db = getDb();
  return db
    .select({ status: leads.currentStatus, count: count() })
    .from(leads)
    .groupBy(leads.currentStatus);
}

export async function getLeadKpiMetrics() {
  const db = getDb();
  const [totalRow] = await db.select({ count: count() }).from(leads);
  const total = Number(totalRow?.count ?? 0);

  const [convertedRow] = await db
    .select({ count: count() })
    .from(leads)
    .where(eq(leads.currentStatus, "Converted"));
  const converted = Number(convertedRow?.count ?? 0);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const [thisMonthRow] = await db
    .select({ count: count() })
    .from(leads)
    .where(sql`${leads.dateOfEnquiry} >= ${startOfMonth}`);
  const thisMonth = Number(thisMonthRow?.count ?? 0);

  const [revenueRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(${leads.proposalValue}), 0)` })
    .from(leads)
    .where(eq(leads.currentStatus, "Converted"));
  const revenue = Number(revenueRow?.total ?? 0);

  // "Active Matters" counts client matters whose status is exactly "Active"
  // (case/whitespace-insensitive, since client_matters.matter_status is free-text).
  // This is the same table/data shown on the /matters list, so the KPI value and
  // the click-through filtered list always agree.
  const [activeMatterRow] = await db
    .select({ count: count() })
    .from(clientMatters)
    .where(isActiveMatterStatus());
  const activeMatters = Number(activeMatterRow?.count ?? 0);

  const [pendingTaskRow] = await db
    .select({ count: count() })
    .from(tasks)
    .where(ne(tasks.status, "done"));
  const pendingTasks = Number(pendingTaskRow?.count ?? 0);

  return {
    totalLeads: total,
    newLeads: thisMonth,
    convertedLeads: converted,
    conversionRate: total > 0 ? Math.round((converted / total) * 100) : 0,
    totalRevenue: revenue,
    activeMatters,
    pendingTasks,
  };
}

export async function getPipelineForecast() {
  const db = getDb();
  const weights: Record<string, number> = {
    New: 0.05,
    Contacted: 0.15,
    "Meeting Scheduled": 0.35,
    "Proposal Sent": 0.6,
    Converted: 1.0,
    Lost: 0,
    "On Hold": 0.1,
  };

  const rows = await db
    .select({
      status: leads.currentStatus,
      count: count(),
      totalValue: sql<string>`COALESCE(SUM(${leads.proposalValue}), 0)`,
    })
    .from(leads)
    .groupBy(leads.currentStatus);

  return rows.map(r => ({
    status: r.status,
    count: r.count,
    totalValue: Number(r.totalValue),
    probability: weights[r.status ?? ""] ?? 0,
    weightedValue: Number(r.totalValue) * (weights[r.status ?? ""] ?? 0),
  }));
}

export async function getRecentActivity(limit = 20) {
  const db = getDb();
  return db
    .select()
    .from(activityLogs)
    .orderBy(desc(activityLogs.createdAt))
    .limit(limit);
}

// ─── Matters ─────────────────────────────────────────────────────────────────

export async function generateMatterCode(): Promise<string> {
  const db = getDb();
  const year = new Date().getFullYear();
  const [row] = await db
    .select({ count: count() })
    .from(matters)
    .where(sql`EXTRACT(YEAR FROM ${matters.createdAt}) = ${year}`);
  const next = (Number(row?.count ?? 0)) + 1;
  return `MAT-${year}-${String(next).padStart(3, "0")}`;
}

export async function getAllMatters() {
  const db = getDb();
  return db.select().from(matters).orderBy(desc(matters.createdAt));
}

export async function getMatterById(id: number) {
  const db = getDb();
  const result = await db.select().from(matters).where(eq(matters.id, id)).limit(1);
  return result[0] ?? null;
}

export async function createMatter(data: Record<string, unknown>, userId: number) {
  const db = getDb();
  const matterCode = await generateMatterCode();
  const sanitized = sanitizeOptionalInput(data);

  const [matter] = await db
    .insert(matters)
    .values({ ...(sanitized as InsertMatter), matterCode, createdBy: userId })
    .returning();

  await logActivity({
    entityType: "matter",
    entityId: matter.id,
    action: "created",
    description: `Matter ${matterCode} opened: ${data.title}`,
    performedBy: userId,
  });

  return matter;
}

export async function updateMatter(id: number, data: Record<string, unknown>) {
  const db = getDb();
  const sanitized = sanitizeOptionalInput(data);
  const [matter] = await db
    .update(matters)
    .set({ ...(sanitized as Partial<InsertMatter>), updatedAt: new Date() })
    .where(eq(matters.id, id))
    .returning();
  return matter;
}

export async function deleteMatter(id: number) {
  const db = getDb();
  await db.delete(matters).where(eq(matters.id, id));
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export async function getAllTasks(filters?: { matterId?: number; assignedTo?: number; status?: string }) {
  const db = getDb();
  const conditions = [];
  if (filters?.matterId) conditions.push(eq(tasks.matterId, filters.matterId));
  if (filters?.assignedTo) conditions.push(eq(tasks.assignedTo, filters.assignedTo));
  if (filters?.status) conditions.push(eq(tasks.status, filters.status as typeof tasks.status._.data));

  return db
    .select()
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(tasks.dueDate, desc(tasks.createdAt));
}

export async function getTaskById(id: number) {
  const db = getDb();
  const result = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return result[0] ?? null;
}

export async function createTask(data: Record<string, unknown>, userId: number) {
  const db = getDb();
  const sanitized = sanitizeOptionalInput(data);
  const [task] = await db
    .insert(tasks)
    .values({ ...(sanitized as InsertTask), createdBy: userId })
    .returning();
  return task;
}

export async function updateTask(id: number, data: Record<string, unknown>) {
  const db = getDb();
  const sanitized = sanitizeOptionalInput(data);
  const completedAt = sanitized.status === "done" ? new Date() : undefined;
  const [task] = await db
    .update(tasks)
    .set({ ...(sanitized as Partial<InsertTask>), updatedAt: new Date(), ...(completedAt ? { completedAt } : {}) })
    .where(eq(tasks.id, id))
    .returning();
  return task;
}

export async function deleteTask(id: number) {
  const db = getDb();
  await db.delete(tasks).where(eq(tasks.id, id));
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export async function getNotesByEntity(entityType: string, entityId: number) {
  const db = getDb();
  return db
    .select()
    .from(notes)
    .where(and(eq(notes.entityType, entityType), eq(notes.entityId, entityId)))
    .orderBy(desc(notes.createdAt));
}

export async function createNote(data: InsertNote) {
  const db = getDb();
  const [note] = await db.insert(notes).values(data).returning();
  return note;
}

export async function deleteNote(id: number) {
  const db = getDb();
  await db.delete(notes).where(eq(notes.id, id));
}

// ─── Payments ─────────────────────────────────────────────────────────────────

export async function getAllPayments() {
  const db = getDb();
  return db.select().from(payments).orderBy(desc(payments.createdAt));
}

export async function getPaymentByLeadId(leadId: number) {
  const db = getDb();
  const result = await db.select().from(payments).where(eq(payments.leadId, leadId)).limit(1);
  return result[0] ?? null;
}

export async function getPaymentById(id: number) {
  const db = getDb();
  const result = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
  return result[0] ?? null;
}

export async function createPayment(data: Record<string, unknown>) {
  const db = getDb();
  const sanitized = sanitizeOptionalInput(data);
  const [payment] = await db.insert(payments).values(sanitized as InsertPayment).returning();
  return payment;
}

export async function updatePayment(id: number, data: Record<string, unknown>) {
  const db = getDb();
  const sanitized = sanitizeOptionalInput(data);
  const [payment] = await db
    .update(payments)
    .set({ ...(sanitized as Partial<InsertPayment>), updatedAt: new Date() })
    .where(eq(payments.id, id))
    .returning();
  return payment;
}

// ─── Activity Logging ─────────────────────────────────────────────────────────

export async function logActivity(data: InsertActivityLog) {
  try {
    const db = getDb();
    await db.insert(activityLogs).values(data);
  } catch {
    // Non-critical — don't fail the main operation
  }
}

// ─── Financial Record Audit ───────────────────────────────────────────────────

// Fields to diff on every financial-record update.
// Order determines display order in the UI.
const FINANCIAL_AUDIT_FIELDS: ReadonlyArray<string> = [
  "clientMatterId",
  "feeType",
  "agreedFees",
  "discountApproval",
  "netFees",
  "billedAmount",
  "revenue",
  "collectedAmount",
  "outstandingAmount",
  "collectionStatus",
  "billingDate",
  "paymentDate",
  "invoiceNumber",
  "responsibleLawyer",
  "financeNotes",
];

// Decimal fields need canonical normalization to prevent "1000.00" vs "1000" false positives.
const DECIMAL_AUDIT_FIELDS = new Set([
  "agreedFees", "netFees", "billedAmount", "revenue",
  "collectedAmount", "outstandingAmount",
]);

function normalizeAuditValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (DECIMAL_AUDIT_FIELDS.has(field)) {
    const n = Number(value);
    return Number.isFinite(n) ? String(round2(n)) : String(value);
  }
  return String(value).trim();
}

// ─── Audit Logs ───────────────────────────────────────────────────────────────

export async function createAuditLog(data: {
  entityType?: string;
  entityId: number;
  userId: number;
  action: "created" | "updated" | "deleted" | "status_changed" | "role_changed" | "password_reset" | "assigned";
  fieldName?: string;
  oldValue?: string;
  newValue?: string;
  description?: string;
}) {
  const db = getDb();
  await db.insert(auditLogs).values({ entityType: "lead", ...data });
}

export async function getAuditLogsByEntity(entityType: string, entityId: number) {
  const db = getDb();
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, entityId)))
    .orderBy(desc(auditLogs.createdAt));
}

// Returns all audit log entries for a specific financial record, joined with
// the user's name so the UI can show who made each change.
export async function getFinancialAuditLogs(financialRecordId: number) {
  const db = getDb();
  return db
    .select({
      id:             auditLogs.id,
      action:         auditLogs.action,
      fieldName:      auditLogs.fieldName,
      oldValue:       auditLogs.oldValue,
      newValue:       auditLogs.newValue,
      description:    auditLogs.description,
      createdAt:      auditLogs.createdAt,
      changedByName:  users.name,
      changedByEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(
      and(
        eq(auditLogs.entityType, "financial_record"),
        eq(auditLogs.entityId, financialRecordId),
      )
    )
    .orderBy(auditLogs.createdAt); // ascending — oldest first (chronological)
}

// ─── Chat Submissions ─────────────────────────────────────────────────────────

export async function getAllChatSubmissions() {
  const db = getDb();
  return db.select().from(chatSubmissions).orderBy(desc(chatSubmissions.createdAt));
}

export async function createChatSubmission(data: InsertChatSubmission) {
  const db = getDb();
  const [sub] = await db.insert(chatSubmissions).values(data).returning();
  return sub;
}

export async function updateChatSubmissionStatus(id: number, status: "new" | "read" | "replied" | "converted") {
  const db = getDb();
  await db.update(chatSubmissions).set({ status, updatedAt: new Date() }).where(eq(chatSubmissions.id, id));
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

export async function getDashboardStats() {
  return getLeadKpiMetrics();
}

export async function getUserActivityStats(userId: number) {
  const db = getDb();
  const [leadCount] = await db
    .select({ count: count() })
    .from(leads)
    .where(eq(leads.createdBy, userId));
  return { leadsCreated: Number(leadCount?.count ?? 0) };
}

// ─── Clients ──────────────────────────────────────────────────────────────────

export async function getAllClients(filters?: {
  clientStatus?: string;
  city?: string;
  matterType?: string;
  search?: string;
}) {
  const db = getDb();
  const conditions = [];

  if (filters?.clientStatus) {
    conditions.push(eq(clients.clientStatus, filters.clientStatus as any));
  }
  if (filters?.city) {
    conditions.push(eq(clients.city, filters.city as any));
  }
  if (filters?.matterType) {
    conditions.push(eq(clients.matterType, filters.matterType as any));
  }
  if (filters?.search) {
    const term = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(clients.clientName, term),
        ilike(clients.clientNumber, term),
        ilike(clients.fileNumber, term),
      )
    );
  }

  const query = db.select().from(clients).orderBy(desc(clients.createdAt));
  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}

/**
 * Most recent Lead-status clients, restricted to the last `days` days, newest
 * first, capped at `limit`. Powers the dashboard "Recent Leads" widget.
 *
 * Timezone consistency: the cutoff is computed with the DATABASE clock — NOW()
 * minus an interval — which is the same clock that stamps created_at (defaultNow
 * = now()). The comparison therefore never depends on the app server's or the
 * browser's timezone.
 */
export async function getRecentLeads(days = 30, limit = 5) {
  const db = getDb();
  return db
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.clientStatus, "Leads"),
        gte(clients.createdAt, sql`NOW() - make_interval(days => ${days})`),
      ),
    )
    .orderBy(desc(clients.createdAt))
    .limit(limit);
}

export async function getClientById(id: number) {
  const db = getDb();
  const result = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  return result[0] ?? null;
}

// ─── Conflict Check ───────────────────────────────────────────────────────────

export type ConflictMatchType = "Client" | "Matter" | "Opposing Party";

export interface ConflictMatch {
  matchType: ConflictMatchType; // what kind of record matched
  recordId: number;             // client id (Client) or matter id (Matter/Opposing Party)
  name: string;                 // the matched text (client/matter name or opposing party)
  status: string;               // current status of the matched record
  clientId: number;             // owning client id (for navigation)
  clientName: string;           // owning client name
}

/**
 * Search clients, matters, and opposing-party fields for a single free-text
 * term and return a flat, normalized list of conflict matches. Each match
 * carries: match type, matched record id, matched name, and current status.
 * Case-insensitive partial match; internal whitespace is collapsed.
 */
export async function searchConflicts(rawQuery: string): Promise<ConflictMatch[]> {
  const db = getDb();
  const normalized = rawQuery.trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  const term = `%${normalized}%`;
  const needle = normalized.toLowerCase();
  const contains = (v: string | null | undefined) => !!v && v.toLowerCase().includes(needle);

  // 1) Clients — name / client # / file #
  const matchedClients = await db
    .select()
    .from(clients)
    .where(
      or(
        ilike(clients.clientName, term),
        ilike(clients.clientNumber, term),
        ilike(clients.fileNumber, term),
      ),
    )
    .orderBy(desc(clients.createdAt));

  // 2) + 3) Matters — name/reference/type, and opposing party — joined to the
  //         owning client so we can show the client context.
  const matchedMatters = await db
    .select({
      id: clientMatters.id,
      clientId: clientMatters.clientId,
      matterReference: clientMatters.matterReference,
      matterType: clientMatters.matterType,
      matterDescription: clientMatters.matterDescription,
      matterStatus: clientMatters.matterStatus,
      opposingParty: clientMatters.opposingParty,
      clientName: clients.clientName,
    })
    .from(clientMatters)
    .leftJoin(clients, eq(clientMatters.clientId, clients.id))
    .where(
      or(
        ilike(clientMatters.matterReference, term),
        ilike(clientMatters.matterType, term),
        ilike(clientMatters.matterDescription, term),
        ilike(clientMatters.opposingParty, term),
      ),
    )
    .orderBy(desc(clientMatters.createdAt));

  const matches: ConflictMatch[] = [];

  for (const c of matchedClients) {
    matches.push({
      matchType: "Client",
      recordId: c.id,
      name: c.clientName,
      status: c.clientStatus,
      clientId: c.id,
      clientName: c.clientName,
    });
  }

  for (const m of matchedMatters) {
    const ownerName = m.clientName ?? `Client #${m.clientId}`;
    const status = m.matterStatus ?? "—";
    // Opposing-party hit (a conflict signal in its own right)
    if (contains(m.opposingParty)) {
      matches.push({
        matchType: "Opposing Party",
        recordId: m.id,
        name: m.opposingParty as string,
        status,
        clientId: m.clientId,
        clientName: ownerName,
      });
    }
    // Matter-name/type/description hit
    if (contains(m.matterReference) || contains(m.matterType) || contains(m.matterDescription)) {
      matches.push({
        matchType: "Matter",
        recordId: m.id,
        name: m.matterReference ?? m.matterDescription ?? `Matter #${m.id}`,
        status,
        clientId: m.clientId,
        clientName: ownerName,
      });
    }
  }

  return matches;
}

/**
 * Run a conflict check for a (prospective) matter using its name and opposing
 * party. Searches each provided term and de-duplicates by (matchType, recordId).
 */
export async function checkMatterConflicts(opts: {
  matterName?: string | null;
  opposingParty?: string | null;
}): Promise<ConflictMatch[]> {
  const terms = [opts.matterName, opts.opposingParty]
    .map(t => (t ?? "").trim())
    .filter(t => t.length > 0);
  if (terms.length === 0) return [];

  const all: ConflictMatch[] = [];
  for (const t of terms) all.push(...(await searchConflicts(t)));

  const seen = new Set<string>();
  return all.filter(m => {
    const key = `${m.matchType}:${m.recordId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function createClient(data: InsertClient, userId: number) {
  const db = getDb();
  // Infer the intake channel when the caller didn't specify one:
  //  - created straight as "Existing Client" → "Direct" (walk-in, not funnel)
  //  - otherwise (Leads/Rejected) → "Lead" (entered the intake funnel)
  const convertedFrom =
    data.convertedFrom ??
    (data.clientStatus === "Existing Client" ? "Direct" : "Lead");
  const [client] = await db
    .insert(clients)
    .values({ ...data, convertedFrom, createdBy: userId })
    .returning();
  await createAuditLog({
    entityType: "client",
    entityId: client.id,
    userId,
    action: "created",
    description: `Client ${client.clientName} created with status ${client.clientStatus}`,
  });
  return client;
}

// ─── Rejected-client lock ─────────────────────────────────────────────────────

export const REJECTED_LOCK_MESSAGE =
  "This client is marked as Rejected. No new records can be created or modified.";

/** Throw 403 if the given client is Rejected. No-op for null/unknown ids. */
export async function assertClientNotRejected(clientId: number | null | undefined) {
  if (clientId == null) return;
  const client = await getClientById(clientId);
  if (client?.clientStatus === "Rejected") {
    throw new TRPCError({ code: "FORBIDDEN", message: REJECTED_LOCK_MESSAGE });
  }
}

/** Throw 403 if the matter's owning client is Rejected. */
export async function assertMatterClientNotRejected(clientMatterId: number) {
  const matter = await getClientMatterById(clientMatterId);
  await assertClientNotRejected((matter as { clientId?: number } | null)?.clientId ?? null);
}

/** Throw 403 if the financial record's owning client is Rejected. */
export async function assertFinancialRecordClientNotRejected(recordId: number) {
  const db = getDb();
  const [rec] = await db
    .select({ clientId: financialRecords.clientId })
    .from(financialRecords)
    .where(eq(financialRecords.id, recordId))
    .limit(1);
  await assertClientNotRejected(rec?.clientId ?? null);
}

/** Throw 403 if the action log's owning client is Rejected. */
export async function assertActionClientNotRejected(actionId: number) {
  const db = getDb();
  const [a] = await db
    .select({ clientId: clientActionLogs.clientId })
    .from(clientActionLogs)
    .where(eq(clientActionLogs.id, actionId))
    .limit(1);
  await assertClientNotRejected(a?.clientId ?? null);
}

/** Throw 403 if the lawyer-rate's owning client is Rejected. */
export async function assertRateClientNotRejected(rateId: number) {
  const db = getDb();
  const [r] = await db
    .select({ clientMatterId: matterLawyerRates.clientMatterId })
    .from(matterLawyerRates)
    .where(eq(matterLawyerRates.id, rateId))
    .limit(1);
  if (r) await assertMatterClientNotRejected(r.clientMatterId);
}

export async function updateClient(id: number, data: Partial<InsertClient>, userId: number) {
  const db = getDb();
  const existing = await getClientById(id);

  // Lock: a Rejected client is read-only. The ONLY permitted update is moving it
  // out of Rejected (reactivation), so the client is never permanently bricked.
  if (existing?.clientStatus === "Rejected") {
    const movingOut = typeof data.clientStatus === "string" && data.clientStatus !== "Rejected";
    if (!movingOut) {
      throw new TRPCError({ code: "FORBIDDEN", message: REJECTED_LOCK_MESSAGE });
    }
  }

  const [client] = await db
    .update(clients)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(clients.id, id))
    .returning();

  if (existing && data.clientStatus && existing.clientStatus !== data.clientStatus) {
    await createAuditLog({
      entityType: "client",
      entityId: id,
      userId,
      action: "status_changed",
      fieldName: "clientStatus",
      oldValue: existing.clientStatus,
      newValue: data.clientStatus,
      description: `Client ${existing.clientName} status changed from ${existing.clientStatus} to ${data.clientStatus}`,
    });
  } else if (existing) {
    await createAuditLog({
      entityType: "client",
      entityId: id,
      userId,
      action: "updated",
      description: `Client ${existing.clientName} updated`,
    });
  }
  return client;
}

export async function deleteClient(id: number) {
  const db = getDb();
  await db.delete(clients).where(eq(clients.id, id));
}

export async function getClientStatusCounts() {
  const db = getDb();
  const rows = await db
    .select({ status: clients.clientStatus, count: count() })
    .from(clients)
    .groupBy(clients.clientStatus);
  const result = { existing: 0, leads: 0, rejected: 0, total: 0, nonActive: 0 };
  for (const row of rows) {
    const n = Number(row.count);
    result.total += n;
    if (row.status === "Existing Client") result.existing = n;
    else if (row.status === "Leads") result.leads = n;
    else if (row.status === "Rejected") result.rejected = n;
  }
  // "Non-active" leads = every client that is NOT a converted Active ("Existing Client").
  // This is the basis for the Dashboard "Total Leads" KPI, while "Leads Pipeline"
  // counts only clients still in "Leads" status (i.e. requiring follow-up).
  result.nonActive = result.leads + result.rejected;
  return result;
}

export type ConversionRange = "month" | "quarter" | "all";

// Inclusive lower-bound date for a conversion range, or null for "all time".
// Exported for reuse/testing.
export function conversionRangeStart(range: ConversionRange, now: Date): Date | null {
  if (range === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  if (range === "quarter") {
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
    return new Date(now.getFullYear(), quarterStartMonth, 1);
  }
  return null; // all time
}

/**
 * Dashboard "Conversion Rate" KPI.
 *
 *   Conversion Rate = converted clients / total intake * 100
 *
 *   - total intake     = clients whose intake channel is Lead or Enquiry
 *                        (Direct walk-ins are excluded). Reported split as
 *                        totalLeads + totalEnquiries.
 *   - converted clients = those intake clients that reached "Existing Client"
 *                         (Active). Direct clients can never be "converted".
 *
 * Because the numerator is a strict subset of the denominator, the rate is
 * always between 0 and 100. The rate is rounded to one decimal place.
 *
 * The optional `range` bounds clients by createdAt (intake date): this month,
 * this quarter, or all time.
 */
export async function getClientConversionMetrics(
  range: ConversionRange = "all",
  now: Date = new Date(),
) {
  const db = getDb();
  const start = conversionRangeStart(range, now);
  const inRange = start ? gte(clients.createdAt, start) : undefined;

  const fromFunnel = inArray(clients.convertedFrom, ["Lead", "Enquiry"]);

  const [leadRow] = await db
    .select({ count: count() })
    .from(clients)
    .where(and(eq(clients.convertedFrom, "Lead"), inRange));

  const [enquiryRow] = await db
    .select({ count: count() })
    .from(clients)
    .where(and(eq(clients.convertedFrom, "Enquiry"), inRange));

  const [convertedRow] = await db
    .select({ count: count() })
    .from(clients)
    .where(and(eq(clients.clientStatus, "Existing Client"), fromFunnel, inRange));

  const totalLeads = Number(leadRow?.count ?? 0);
  const totalEnquiries = Number(enquiryRow?.count ?? 0);
  const totalIntake = totalLeads + totalEnquiries;
  const convertedClients = Number(convertedRow?.count ?? 0);

  const conversionRate =
    totalIntake > 0
      ? Math.round((convertedClients / totalIntake) * 1000) / 10 // 1 decimal place
      : 0;

  return {
    range,
    convertedClients,
    totalLeads,
    totalEnquiries,
    totalIntake,
    conversionRate,
  };
}

// ─── Client Matters ───────────────────────────────────────────────────────────

export async function getClientMatters(clientId: number) {
  const db = getDb();
  return db
    .select()
    .from(clientMatters)
    .where(eq(clientMatters.clientId, clientId))
    .orderBy(desc(clientMatters.createdAt));
}

// Case/whitespace-insensitive predicate for a client matter's status. Because
// client_matters.matter_status is a free-text VARCHAR, stored values may vary in
// casing/padding (e.g. "Active", "active", " On Hold "). Normalize both sides so
// "Active" always matches regardless of how it was entered.
function matterStatusEquals(status: string) {
  return sql`lower(trim(${clientMatters.matterStatus})) = ${status.trim().toLowerCase()}`;
}

function isActiveMatterStatus() {
  return matterStatusEquals("Active");
}

// Aggregated view across all clients with client name joined in. Used by the
// global /matters list page. An optional status filter is applied at the DB
// layer (not in the frontend) so the list always matches the dashboard KPI.
export async function getAllClientMatters(filters: { status?: string } = {}) {
  const db = getDb();
  const status = filters.status?.trim();
  return db
    .select({
      id: clientMatters.id,
      clientId: clientMatters.clientId,
      clientName: clients.clientName,
      clientNumber: clients.clientNumber,
      originalSerial: clientMatters.originalSerial,
      matterReference: clientMatters.matterReference,
      matterType: clientMatters.matterType,
      matterDescription: clientMatters.matterDescription,
      leadPartner: clientMatters.leadPartner,
      leadPartnerFullName: clientMatters.leadPartnerFullName,
      matterStatus: clientMatters.matterStatus,
      achievementPercentage: clientMatters.achievementPercentage,
      achievementStatus: clientMatters.achievementStatus,
      priority: clientMatters.priority,
      createdAt: clientMatters.createdAt,
    })
    .from(clientMatters)
    .leftJoin(clients, eq(clientMatters.clientId, clients.id))
    .where(status ? matterStatusEquals(status) : undefined)
    .orderBy(desc(clientMatters.createdAt));
}

export async function getClientMatterById(id: number) {
  const db = getDb();
  const result = await db.select().from(clientMatters).where(eq(clientMatters.id, id)).limit(1);
  return result[0] ?? null;
}

// ─── Original Serial (matter-specific identifier) ─────────────────────────────

export const ORIGINAL_SERIAL_PREFIX = "MAT-";
const ORIGINAL_SERIAL_RE = /^MAT-\d{4,}$/;

/**
 * Next auto-generated Original Serial, independent of the client number.
 * Scans existing MAT-#### serials and increments the highest. Format: MAT-0001.
 */
export async function nextOriginalSerial(): Promise<string> {
  const db = getDb();
  const rows = await db
    .select({ s: clientMatters.originalSerial })
    .from(clientMatters)
    .where(ilike(clientMatters.originalSerial, `${ORIGINAL_SERIAL_PREFIX}%`));
  let max = 0;
  for (const { s } of rows) {
    const m = /^MAT-(\d+)$/.exec((s ?? "").trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${ORIGINAL_SERIAL_PREFIX}${String(max + 1).padStart(4, "0")}`;
}

/** True if `serial` is already used by another matter (optionally excluding one id). */
export async function isOriginalSerialTaken(serial: string, excludeId?: number): Promise<boolean> {
  const db = getDb();
  const where = excludeId
    ? and(eq(clientMatters.originalSerial, serial), ne(clientMatters.id, excludeId))
    : eq(clientMatters.originalSerial, serial);
  const rows = await db.select({ id: clientMatters.id }).from(clientMatters).where(where).limit(1);
  return rows.length > 0;
}

/**
 * Resolve the Original Serial for an insert/update:
 *  - blank → auto-generate an independent MAT-#### serial
 *  - provided → validate format + enforce uniqueness across all matters
 * Never derived from the client number.
 */
async function resolveOriginalSerial(
  raw: unknown,
  opts: { excludeId?: number } = {},
): Promise<string | undefined> {
  const provided = typeof raw === "string" ? raw.trim() : "";
  if (!provided) {
    return opts.excludeId ? undefined : nextOriginalSerial();
  }
  if (provided.length > 50) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Original Serial must be 50 characters or fewer." });
  }
  if (await isOriginalSerialTaken(provided, opts.excludeId)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Original Serial "${provided}" is already used by another matter. It must be unique.`,
    });
  }
  return provided;
}

export async function createClientMatter(
  data: Record<string, unknown>,
  userId: number,
  conflicts: ConflictMatch[] = [],
) {
  const db = getDb();
  const clean = sanitizeClientMatterInput(data) as Partial<InsertClientMatter>;
  // Original Serial is generated/validated independently of the client number.
  clean.originalSerial = await resolveOriginalSerial(clean.originalSerial);
  const [matter] = await db
    .insert(clientMatters)
    .values({ ...clean, clientId: (data as any).clientId, createdBy: userId } as InsertClientMatter)
    .returning();

  // Auditable record of the conflict check performed at creation time. When
  // conflicts were present, the matter was created with explicit acknowledgement.
  const ref = matter.matterReference ?? matter.originalSerial ?? `#${matter.id}`;
  const description =
    conflicts.length > 0
      ? `Client matter ${ref} created — CONFLICT CHECK: ${conflicts.length} potential match(es) acknowledged [` +
        conflicts.map(c => `${c.matchType}: ${c.name} (${c.status})`).join("; ") +
        `]`
      : `Client matter ${ref} created — conflict check clear`;
  await createAuditLog({
    entityType: "client_matter",
    entityId: matter.id,
    userId,
    action: "created",
    description,
  });

  return matter;
}

export async function updateClientMatter(id: number, data: Record<string, unknown>, userId: number) {
  const db = getDb();
  const clean = sanitizeClientMatterInput(data) as Partial<InsertClientMatter>;
  // If the Original Serial is being changed, validate uniqueness (excluding this row).
  if (clean.originalSerial !== undefined) {
    const resolved = await resolveOriginalSerial(clean.originalSerial, { excludeId: id });
    if (resolved === undefined) delete clean.originalSerial; // blank on update → leave unchanged
    else clean.originalSerial = resolved;
  }
  const [matter] = await db
    .update(clientMatters)
    .set({ ...clean, updatedAt: new Date() })
    .where(eq(clientMatters.id, id))
    .returning();
  await createAuditLog({
    entityType: "client_matter",
    entityId: id,
    userId,
    action: "updated",
    description: `Client matter ${matter?.matterReference ?? id} updated`,
  });
  return matter;
}

export async function deleteClientMatter(id: number) {
  const db = getDb();
  await db.delete(clientMatters).where(eq(clientMatters.id, id));
}

// ─── Matter Lawyer Rates ──────────────────────────────────────────────────────

// Roles that may be assigned as a matter's lead/co-lawyer.
export const ASSIGNABLE_LAWYER_ROLES = ["admin", "manager", "partner", "lawyer"] as const;

/** Active users who may be assigned to a matter as lead/co-lawyers. */
export async function getAssignableLawyers() {
  const db = getDb();
  return db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(and(eq(users.status, "active"), inArray(users.role, [...ASSIGNABLE_LAWYER_ROLES] as any)))
    .orderBy(users.name);
}

/** Fetch + validate a user that is being assigned as a lawyer. Throws if invalid. */
async function resolveAssignedUser(userId: number) {
  const db = getDb();
  const [u] = await db
    .select({ id: users.id, name: users.name, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) throw new TRPCError({ code: "BAD_REQUEST", message: "Selected lawyer does not exist." });
  if (u.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "Selected lawyer is not active." });
  if (!(ASSIGNABLE_LAWYER_ROLES as readonly string[]).includes(u.role)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Users with role "${u.role}" cannot be assigned as a lawyer.` });
  }
  return u;
}

export async function getMatterLawyerRates(clientMatterId: number) {
  const db = getDb();
  const rows = await db
    .select({
      id: matterLawyerRates.id,
      clientMatterId: matterLawyerRates.clientMatterId,
      userId: matterLawyerRates.userId,
      lawyerName: matterLawyerRates.lawyerName,
      userName: users.name,
      userRole: users.role,
      role: matterLawyerRates.role,
      hourlyRate: matterLawyerRates.hourlyRate,
      currency: matterLawyerRates.currency,
      isActive: matterLawyerRates.isActive,
      effectiveDate: matterLawyerRates.effectiveDate,
      notes: matterLawyerRates.notes,
      createdAt: matterLawyerRates.createdAt,
    })
    .from(matterLawyerRates)
    .leftJoin(users, eq(matterLawyerRates.userId, users.id))
    .where(eq(matterLawyerRates.clientMatterId, clientMatterId))
    .orderBy(desc(matterLawyerRates.createdAt));
  // The live user name is authoritative; fall back to the stored value for
  // legacy rows that predate the user link.
  return rows.map(r => ({ ...r, lawyerName: r.userName ?? r.lawyerName }));
}

export async function createMatterLawyerRate(data: Record<string, unknown>, userId: number) {
  const db = getDb();
  // Names cannot be free text: a rate must reference an assignable user, and the
  // stored lawyerName is derived from that user.
  const assignedUserId = Number(data.userId);
  if (!Number.isFinite(assignedUserId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A lawyer (assigned user) is required." });
  }
  const lawyer = await resolveAssignedUser(assignedUserId);

  const hourlyRate = Number(data.hourlyRate);
  if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Hourly rate must be a number greater than or equal to 0." });
  }

  const clientMatterId = data.clientMatterId as number;
  const dup = await db
    .select({ id: matterLawyerRates.id })
    .from(matterLawyerRates)
    .where(and(eq(matterLawyerRates.clientMatterId, clientMatterId), eq(matterLawyerRates.userId, assignedUserId)))
    .limit(1);
  if (dup.length) {
    throw new TRPCError({ code: "CONFLICT", message: `${lawyer.name ?? "This lawyer"} already has a rate on this matter.` });
  }

  const [rate] = await db
    .insert(matterLawyerRates)
    .values({
      clientMatterId,
      userId:        assignedUserId,
      lawyerName:    (lawyer.name ?? "Unknown").trim(), // server-derived, not free text
      role:          data.role ? String(data.role).trim() || undefined : (lawyer.role ?? undefined),
      hourlyRate:    String(hourlyRate),
      currency:      data.currency ? String(data.currency).trim() : "SAR",
      isActive:      data.isActive !== undefined ? Boolean(data.isActive) : true,
      effectiveDate: data.effectiveDate ? String(data.effectiveDate) : undefined,
      notes:         data.notes ? String(data.notes).trim() || undefined : undefined,
      createdBy:     userId,
    } as InsertMatterLawyerRate)
    .returning();
  return rate;
}

export async function updateMatterLawyerRate(id: number, data: Record<string, unknown>, userId: number) {
  const db = getDb();
  const updates: Partial<InsertMatterLawyerRate> & { updatedAt: Date } = { updatedAt: new Date() };

  // lawyerName is never accepted as free text; it is re-derived from the user.
  if (data.userId !== undefined) {
    const lawyer = await resolveAssignedUser(Number(data.userId));
    updates.userId = lawyer.id;
    updates.lawyerName = (lawyer.name ?? "Unknown").trim();
  }
  if (data.role !== undefined)       updates.role       = String(data.role).trim() || undefined;
  if (data.hourlyRate !== undefined) {
    const n = Number(data.hourlyRate);
    if (!Number.isFinite(n) || n < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Hourly rate must be a number ≥ 0." });
    updates.hourlyRate = String(n);
  }
  if (data.currency !== undefined)      updates.currency      = String(data.currency).trim() || "SAR";
  if (data.isActive !== undefined)      updates.isActive      = Boolean(data.isActive);
  if (data.effectiveDate !== undefined) updates.effectiveDate = data.effectiveDate ? String(data.effectiveDate) : null;
  if (data.notes !== undefined)         updates.notes         = data.notes ? String(data.notes).trim() || undefined : undefined;

  const [rate] = await db
    .update(matterLawyerRates)
    .set(updates)
    .where(eq(matterLawyerRates.id, id))
    .returning();
  await createAuditLog({
    entityType: "matter_lawyer_rate",
    entityId: id,
    userId,
    action: "updated",
    description: `Lawyer rate ${rate?.lawyerName ?? id} updated`,
  });
  return rate;
}

export async function deleteMatterLawyerRate(id: number) {
  const db = getDb();
  await db.delete(matterLawyerRates).where(eq(matterLawyerRates.id, id));
}

/**
 * Reassign a matter's lead lawyer to an assignable user. Controlled action —
 * exposed via a permission-restricted (Admin/Partner) endpoint. The lead name is
 * derived from the user, so it cannot be overridden by free text.
 */
export async function reassignLeadLawyer(clientMatterId: number, newUserId: number, actorId: number) {
  const db = getDb();
  const lawyer = await resolveAssignedUser(newUserId);
  const [existing] = await db.select().from(clientMatters).where(eq(clientMatters.id, clientMatterId)).limit(1);
  if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Matter not found." });

  const [matter] = await db
    .update(clientMatters)
    .set({
      leadLawyerId: lawyer.id,
      leadPartnerFullName: lawyer.name ?? existing.leadPartnerFullName, // keep legacy display in sync
      updatedAt: new Date(),
    })
    .where(eq(clientMatters.id, clientMatterId))
    .returning();

  await createAuditLog({
    entityType: "client_matter",
    entityId: clientMatterId,
    userId: actorId,
    action: "assigned",
    fieldName: "leadLawyerId",
    oldValue: existing.leadLawyerId != null ? String(existing.leadLawyerId) : undefined,
    newValue: String(lawyer.id),
    description: `Lead lawyer for matter ${existing.matterReference ?? clientMatterId} reassigned to ${lawyer.name ?? lawyer.id}`,
  });
  return matter;
}

/**
 * All lawyers billable on a matter (lead + co-lawyers) with their effective
 * hourly rate. This is the integration point for hours/billing logic: every
 * entry has a userId and a resolved rate (or null if not yet set).
 */
export async function getMatterBillableLawyers(clientMatterId: number) {
  const db = getDb();
  const [matter] = await db
    .select({ leadLawyerId: clientMatters.leadLawyerId, leadPartnerFullName: clientMatters.leadPartnerFullName })
    .from(clientMatters)
    .where(eq(clientMatters.id, clientMatterId))
    .limit(1);

  const rates = await getMatterLawyerRates(clientMatterId);
  const rateByUser = new Map<number, (typeof rates)[number]>();
  for (const r of rates) if (r.userId != null) rateByUser.set(r.userId, r);

  type Lawyer = {
    userId: number | null;
    name: string;
    role: string | null;
    isLead: boolean;
    hourlyRate: string | null;
    currency: string | null;
    rateId: number | null;
    isActive: boolean;
  };

  let lead: Lawyer | null = null;
  if (matter?.leadLawyerId) {
    const [u] = await db
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, matter.leadLawyerId))
      .limit(1);
    const r = rateByUser.get(matter.leadLawyerId);
    lead = {
      userId: matter.leadLawyerId,
      name: u?.name ?? matter.leadPartnerFullName ?? "Unknown",
      role: u?.role ?? null,
      isLead: true,
      hourlyRate: r?.hourlyRate ?? null,
      currency: r?.currency ?? null,
      rateId: r?.id ?? null,
      isActive: r?.isActive ?? true,
    };
  } else if (matter?.leadPartnerFullName) {
    // Legacy free-text lead not yet linked to a user.
    lead = {
      userId: null, name: matter.leadPartnerFullName, role: null, isLead: true,
      hourlyRate: null, currency: null, rateId: null, isActive: true,
    };
  }

  const coLawyers: Lawyer[] = rates
    .filter(r => r.userId != null && r.userId !== matter?.leadLawyerId)
    .map(r => ({
      userId: r.userId,
      name: r.lawyerName,
      role: r.role ?? r.userRole ?? null,
      isLead: false,
      hourlyRate: r.hourlyRate,
      currency: r.currency,
      rateId: r.id,
      isActive: r.isActive,
    }));

  return { lead, coLawyers, all: [...(lead ? [lead] : []), ...coLawyers] };
}

// ─── Client Lead Details ──────────────────────────────────────────────────────

export async function getClientLeadDetail(clientId: number) {
  const db = getDb();
  const result = await db
    .select()
    .from(clientLeadDetails)
    .where(eq(clientLeadDetails.clientId, clientId))
    .limit(1);
  return result[0] ?? null;
}

export async function upsertClientLeadDetail(clientId: number, data: Partial<InsertClientLeadDetail>) {
  const db = getDb();
  const existing = await getClientLeadDetail(clientId);
  if (existing) {
    const [updated] = await db
      .update(clientLeadDetails)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(clientLeadDetails.clientId, clientId))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(clientLeadDetails)
    .values({ ...data, clientId } as InsertClientLeadDetail)
    .returning();
  return created;
}

export async function getLeadsWithActionsDueThisWeek() {
  const db = getDb();
  const today = new Date();
  const weekEnd = new Date();
  weekEnd.setDate(today.getDate() + 7);
  const todayStr = today.toISOString().split("T")[0];
  const weekEndStr = weekEnd.toISOString().split("T")[0];
  return db
    .select()
    .from(clientLeadDetails)
    .where(
      and(
        gte(clientLeadDetails.nextActionDate, todayStr),
        lte(clientLeadDetails.nextActionDate, weekEndStr),
      )
    );
}

// ─── Rejected Clients ─────────────────────────────────────────────────────────

export async function getRejectedClientDetail(clientId: number) {
  const db = getDb();
  const result = await db
    .select()
    .from(rejectedClients)
    .where(eq(rejectedClients.clientId, clientId))
    .limit(1);
  return result[0] ?? null;
}

export async function upsertRejectedClient(clientId: number, data: Partial<InsertRejectedClient>) {
  const db = getDb();
  const existing = await getRejectedClientDetail(clientId);
  if (existing) {
    const [updated] = await db
      .update(rejectedClients)
      .set(data)
      .where(eq(rejectedClients.clientId, clientId))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(rejectedClients)
    .values({ ...data, clientId } as InsertRejectedClient)
    .returning();
  return created;
}

// ─── System Settings ─────────────────────────────────────────────────────────

/** Read a single setting by key. Returns null if not found. */
export async function getSystemSetting(key: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  return row?.value ?? null;
}

/**
 * Returns the configured overdue invoice days threshold.
 * Falls back to 30 if the setting is missing or non-numeric.
 */
export async function getOverdueDays(): Promise<number> {
  const raw = await getSystemSetting("overdue_invoice_days");
  const n   = raw !== null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

/** Upsert a system setting. Creates it if missing, updates it if present. */
export async function upsertSystemSetting(
  key:       string,
  value:     string,
  updatedBy: number,
): Promise<void> {
  const db = getDb();
  await db
    .insert(systemSettings)
    .values({ key, value, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target:  systemSettings.key,
      set:     { value, updatedBy, updatedAt: new Date() },
    });
}

// ─── Financial Records ────────────────────────────────────────────────────────

/**
 * Statuses that mean an invoice has been issued but payment is still
 * outstanding — the only candidates for the date-based overdue calculation.
 * "Not Billed" is excluded because no invoice exists yet.
 * "Fully Collected" is excluded because payment is complete.
 */
const OVERDUE_CANDIDATE_STATUSES = new Set([
  "Billed",
  "Partially Billed",
  "Partially Collected",
  "Overdue",       // already manually flagged — always included
]);

/**
 * Returns true when a record should be flagged as overdue.
 * Logic:
 *   – status must be an unpaid/issued status (not "Not Billed" or "Fully Collected")
 *   – billingDate must be present (no invoice date → cannot be overdue)
 *   – (today − billingDate) in days ≥ overdueDays
 */
function computeIsOverdue(
  r: { collectionStatus?: string | null; billingDate?: string | null },
  overdueDays: number,
): boolean {
  if (!r.collectionStatus || !OVERDUE_CANDIDATE_STATUSES.has(r.collectionStatus)) return false;
  if (!r.billingDate) return false;
  const today  = new Date();
  today.setHours(0, 0, 0, 0);
  const billed = new Date(r.billingDate);
  billed.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - billed.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays >= overdueDays;
}

export async function getFinancialRecords(filters?: {
  clientId?: number;
  clientMatterId?: number;
  collectionStatus?: string;
}) {
  const db          = getDb();
  const overdueDays = await getOverdueDays();
  const conditions  = [];
  if (filters?.clientId) conditions.push(eq(financialRecords.clientId, filters.clientId));
  if (filters?.clientMatterId) {
    conditions.push(eq(financialRecords.clientMatterId, filters.clientMatterId));
  }
  if (filters?.collectionStatus) {
    conditions.push(eq(financialRecords.collectionStatus, filters.collectionStatus as any));
  }
  const query = db.select().from(financialRecords).orderBy(desc(financialRecords.createdAt));
  const rows  = await (conditions.length > 0 ? query.where(and(...conditions)) : query);
  // Annotate each row with a computed overdue flag based on date math + config.
  return rows.map(r => ({ ...r, isComputedOverdue: computeIsOverdue(r, overdueDays) }));
}

export async function getFinancialRecordById(id: number) {
  const db = getDb();
  const result = await db.select().from(financialRecords).where(eq(financialRecords.id, id)).limit(1);
  return result[0] ?? null;
}

export async function createFinancialRecord(data: InsertFinancialRecord, userId: number) {
  const db = getDb();
  const computed = applyDiscountRules(data as Record<string, unknown>) as InsertFinancialRecord;
  const [record] = await db
    .insert(financialRecords)
    .values({ ...computed, createdBy: userId })
    .returning();
  await createAuditLog({
    entityType: "financial_record",
    entityId: record.id,
    userId,
    action: "created",
    description: `Financial record created for client ${data.clientId}`,
  });
  return record;
}

export async function updateFinancialRecord(id: number, data: Partial<InsertFinancialRecord>, userId: number) {
  const db = getDb();
  // Re-derive discount fields whenever inputs change. Pull the existing row so
  // that updating only one side of the (pct, amount) pair still reconciles
  // against the persisted agreedFees.
  const existing = await getFinancialRecordById(id);
  if (!existing) throw new Error(`Financial record ${id} not found`);

  // Only pass the 5 user-editable inputs to applyDiscountRules — never spread
  // the full DB row (which contains id, createdAt, etc.) into SET.
  // Revenue is the single amount input; billedAmount is derived (alias) from it.
  const rulesInput = {
    discountApproval: data.discountApproval ?? existing.discountApproval ?? "N/A",
    agreedFees:       data.agreedFees       ?? existing.agreedFees,
    revenue:          data.revenue          ?? existing.revenue,
    collectedAmount:  data.collectedAmount  ?? existing.collectedAmount,
  };
  const computed = applyDiscountRules(rulesInput as Record<string, unknown>);

  const [record] = await db
    .update(financialRecords)
    .set({
      // user-supplied partial update fields
      ...data,
      // server-computed overrides (always win over any client value)
      discountPercentage: computed.discountPercentage as string,
      discountAmount:     computed.discountAmount     as string,
      netFees:            computed.netFees            as string,
      billedAmount:       computed.billedAmount       as string, // mirror revenue
      remainingAdvanced:  computed.remainingAdvanced  as string,
      outstandingAmount:  computed.outstandingAmount  as string,
      updatedAt:          new Date(),
    })
    .where(eq(financialRecords.id, id))
    .returning();

  // ─── Field-level audit diff ────────────────────────────────────────────────
  // Compare each tracked field between the pre-update snapshot (existing) and
  // the persisted row (record). One audit entry is written per changed field.
  let changedFieldCount = 0;
  for (const field of FINANCIAL_AUDIT_FIELDS) {
    const oldNorm = normalizeAuditValue(field, (existing as Record<string, unknown>)[field]);
    const newNorm = normalizeAuditValue(field, (record  as Record<string, unknown>)[field]);
    if (oldNorm !== newNorm) {
      changedFieldCount++;
      await createAuditLog({
        entityType: "financial_record",
        entityId:   id,
        userId,
        action:     "updated",
        fieldName:  field,
        oldValue:   oldNorm || "(empty)",
        newValue:   newNorm || "(empty)",
        description: `Field "${field}" changed on financial record ${id}`,
      });
    }
  }

  // If nothing tracked changed (e.g. only updatedAt moved), still write a
  // summary entry so the record appears in the audit trail.
  if (changedFieldCount === 0) {
    await createAuditLog({
      entityType:  "financial_record",
      entityId:    id,
      userId,
      action:      "updated",
      description: `Financial record ${id} saved (no tracked fields changed)`,
    });
  }

  return record;
}

export async function deleteFinancialRecord(id: number) {
  const db = getDb();
  await db.delete(financialRecords).where(eq(financialRecords.id, id));
}

export async function getFinancialSummary() {
  const db          = getDb();
  const overdueDays = await getOverdueDays();
  // Use sql.raw for the numeric literal — it is validated as a positive integer
  // by getOverdueDays(), so injection is not possible.
  const overdaysSql = sql.raw(String(overdueDays));
  const [row] = await db
    .select({
      totalRevenue:     sql<string>`COALESCE(SUM(${financialRecords.revenue}), 0)`,
      totalOutstanding: sql<string>`COALESCE(SUM(${financialRecords.outstandingAmount}), 0)`,
      // Date-based overdue: billed but unpaid, billing date older than configured threshold.
      overdueCount: sql<string>`COUNT(*) FILTER (
        WHERE ${financialRecords.collectionStatus} IN ('Billed', 'Partially Billed', 'Partially Collected', 'Overdue')
        AND   ${financialRecords.billingDate} IS NOT NULL
        AND   CURRENT_DATE - ${financialRecords.billingDate}::date >= ${overdaysSql}
      )`,
      // To Be Billed uses Revenue (the single amount source) = MAX(0, agreedFees - revenue).
      totalToBeBilled:  sql<string>`COALESCE(SUM(GREATEST(0, COALESCE(${financialRecords.agreedFees}, 0)::numeric - COALESCE(${financialRecords.revenue}, 0)::numeric)), 0)`,
    })
    .from(financialRecords);
  return {
    totalRevenue:    Number(row?.totalRevenue    ?? 0),
    totalOutstanding:Number(row?.totalOutstanding?? 0),
    overdueCount:    Number(row?.overdueCount    ?? 0),
    totalToBeBilled: Number(row?.totalToBeBilled ?? 0),
    overdueDays,   // expose so callers can show "X days" in the UI
  };
}

// ─── To Be Billed Breakdown ───────────────────────────────────────────────────

export async function getToBeBilledBreakdown() {
  const db = getDb();

  // Reusable SQL expression: MAX(0, agreedFees - revenue) per row, then SUM.
  // Revenue is the single amount source (billed_amount is a deprecated alias).
  const tbbSum = sql<string>`COALESCE(SUM(GREATEST(0, COALESCE(${financialRecords.agreedFees}, 0)::numeric - COALESCE(${financialRecords.revenue}, 0)::numeric)), 0)`;

  // ── By Client ──────────────────────────────────────────────────────────────
  const byClientRaw = await db
    .select({
      clientId:   financialRecords.clientId,
      clientName: clients.clientName,
      toBeBilled: tbbSum,
    })
    .from(financialRecords)
    .innerJoin(clients, eq(financialRecords.clientId, clients.id))
    .groupBy(financialRecords.clientId, clients.clientName);

  // ── By Matter (only records linked to a matter) ────────────────────────────
  const byMatterRaw = await db
    .select({
      clientId:       financialRecords.clientId,
      clientName:     clients.clientName,
      clientMatterId: financialRecords.clientMatterId,
      matterReference:clientMatters.matterReference,
      originalSerial: clientMatters.originalSerial,
      matterType:     clientMatters.matterType,
      toBeBilled:     tbbSum,
    })
    .from(financialRecords)
    .innerJoin(clients, eq(financialRecords.clientId, clients.id))
    .innerJoin(clientMatters, eq(financialRecords.clientMatterId, clientMatters.id))
    .groupBy(
      financialRecords.clientId,
      clients.clientName,
      financialRecords.clientMatterId,
      clientMatters.matterReference,
      clientMatters.originalSerial,
      clientMatters.matterType,
    );

  const byClient = byClientRaw
    .map(r => ({
      clientId:   r.clientId,
      clientName: r.clientName,
      toBeBilled: Number(r.toBeBilled),
    }))
    .filter(r => r.toBeBilled > 0)
    .sort((a, b) => b.toBeBilled - a.toBeBilled);

  const byMatter = byMatterRaw
    .map(r => ({
      clientId:       r.clientId,
      clientName:     r.clientName,
      clientMatterId: r.clientMatterId,
      matterReference:r.matterReference ?? r.originalSerial ?? null,
      matterType:     r.matterType,
      toBeBilled:     Number(r.toBeBilled),
    }))
    .filter(r => r.toBeBilled > 0)
    .sort((a, b) => b.toBeBilled - a.toBeBilled);

  return { byClient, byMatter };
}

// ─── Client Action Logs ───────────────────────────────────────────────────────

export async function getClientActionLogs(clientId?: number) {
  const db = getDb();
  const query = db.select().from(clientActionLogs).orderBy(desc(clientActionLogs.createdAt));
  if (clientId) return query.where(eq(clientActionLogs.clientId, clientId));
  return query;
}

export async function createClientActionLog(data: InsertClientActionLog, userId: number) {
  const db = getDb();
  const [log] = await db
    .insert(clientActionLogs)
    .values({ ...data, createdBy: userId })
    .returning();
  await syncTaskFromActionLog(log, userId);
  return log;
}

export async function updateClientActionLog(id: number, data: Partial<InsertClientActionLog>, userId?: number) {
  const db = getDb();
  const [log] = await db
    .update(clientActionLogs)
    .set(data)
    .where(eq(clientActionLogs.id, id))
    .returning();
  if (log) await syncTaskFromActionLog(log, userId ?? log.createdBy ?? null);
  return log;
}

// When an action log carries a nextStep (the user's "what to do next"),
// upsert a linked row in `tasks` so the Tasks module reflects pending work.
// The link is the one-to-one column tasks.client_action_log_id.
async function syncTaskFromActionLog(
  log: { id: number; clientId: number; clientMatterId: number | null; nextStep: string | null; actionDate: string | null; actionOwner: string | null; actionType: string | null },
  userId: number | null
) {
  const db = getDb();
  const hasNext = typeof log.nextStep === "string" && log.nextStep.trim() !== "";

  const existing = await db
    .select()
    .from(tasks)
    .where(eq(tasks.clientActionLogId, log.id))
    .limit(1);
  const existingTask = existing[0];

  if (!hasNext) {
    if (existingTask) {
      await db.delete(tasks).where(eq(tasks.id, existingTask.id));
    }
    return;
  }

  const title = (log.nextStep ?? "").trim().slice(0, 500);
  const description = log.actionType ? `${log.actionType}: ${log.nextStep}` : log.nextStep;
  const values = {
    title,
    description: description ?? null,
    clientId: log.clientId,
    clientMatterId: log.clientMatterId ?? null,
    clientActionLogId: log.id,
    dueDate: log.actionDate ?? null,
    createdBy: userId ?? undefined,
    updatedAt: new Date(),
  } as Partial<InsertTask>;

  if (existingTask) {
    // Don't clobber user-edited status/assignee on the task; only refresh
    // fields driven by the action log.
    await db
      .update(tasks)
      .set({
        title: values.title!,
        description: values.description ?? null,
        clientMatterId: values.clientMatterId ?? null,
        dueDate: values.dueDate ?? null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, existingTask.id));
  } else {
    await db.insert(tasks).values(values as InsertTask);
  }
}

export async function deleteClientActionLog(id: number) {
  const db = getDb();
  await db.delete(clientActionLogs).where(eq(clientActionLogs.id, id));
}

export async function getActionsThisWeek() {
  const db = getDb();
  const today = new Date();
  const weekEnd = new Date();
  weekEnd.setDate(today.getDate() + 7);
  const todayStr = today.toISOString().split("T")[0];
  const weekEndStr = weekEnd.toISOString().split("T")[0];
  const [row] = await db
    .select({ count: count() })
    .from(clientActionLogs)
    .where(
      and(
        gte(clientActionLogs.actionDate, todayStr),
        lte(clientActionLogs.actionDate, weekEndStr),
      )
    );
  return Number(row?.count ?? 0);
}

// ─── Client Import (with validation) ─────────────────────────────────────────

type ImportRow = {
  clientNumber?: string;
  fileNumber?: string;
  clientName?: string;
  clientStatus?: string;
  city?: string;
  matterType?: string;
};

const VALID_STATUSES = ["Existing Client", "Leads", "Rejected"];
const VALID_CITIES = ["Riyadh", "Dammam", "Jeddah"];
const VALID_MATTER_TYPES = ["Corporate", "Litigation"];

export async function importClients(rows: ImportRow[], userId: number) {
  const db = getDb();

  const errors: Array<{ row: number; field: string; issue: string }> = [];
  const valid: InsertClient[] = [];
  const skipped: number[] = [];

  // Pre-load existing client/file numbers for dup detection
  const existingClients = await getAllClients();
  const existingNames = new Set(existingClients.map(c => c.clientName.toLowerCase()));
  const existingFileNums = new Set(existingClients.map(c => c.fileNumber?.toLowerCase()).filter(Boolean));
  const existingClientNums = new Set(existingClients.map(c => c.clientNumber?.toLowerCase()).filter(Boolean));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-indexed + header row
    let hasError = false;

    // Clean #REF! values
    const clean = (v?: string) => {
      if (!v || v.trim() === "" || v.includes("#REF!") || v.includes("#N/A") || v.includes("#VALUE!")) return undefined;
      return v.trim();
    };

    const clientName = clean(row.clientName);
    const clientStatus = clean(row.clientStatus);
    const city = clean(row.city);
    const matterType = clean(row.matterType);
    const clientNumber = clean(row.clientNumber);
    const fileNumber = clean(row.fileNumber);

    if (!clientName) {
      errors.push({ row: rowNum, field: "clientName", issue: "Missing client name" });
      hasError = true;
    }
    if (!clientStatus) {
      errors.push({ row: rowNum, field: "clientStatus", issue: "Missing client status" });
      hasError = true;
    } else if (!VALID_STATUSES.includes(clientStatus)) {
      errors.push({ row: rowNum, field: "clientStatus", issue: `Invalid status "${clientStatus}". Must be one of: ${VALID_STATUSES.join(", ")}` });
      hasError = true;
    }
    if (city && !VALID_CITIES.includes(city)) {
      errors.push({ row: rowNum, field: "city", issue: `Invalid city "${city}". Must be one of: ${VALID_CITIES.join(", ")}` });
      hasError = true;
    }
    if (matterType && !VALID_MATTER_TYPES.includes(matterType)) {
      errors.push({ row: rowNum, field: "matterType", issue: `Invalid matter type "${matterType}". Must be one of: ${VALID_MATTER_TYPES.join(", ")}` });
      hasError = true;
    }
    if (clientName && existingNames.has(clientName.toLowerCase())) {
      errors.push({ row: rowNum, field: "clientName", issue: `Duplicate client name "${clientName}"` });
      hasError = true;
    }
    if (fileNumber && existingFileNums.has(fileNumber.toLowerCase())) {
      errors.push({ row: rowNum, field: "fileNumber", issue: `Duplicate file number "${fileNumber}"` });
      hasError = true;
    }
    if (clientNumber && existingClientNums.has(clientNumber.toLowerCase())) {
      errors.push({ row: rowNum, field: "clientNumber", issue: `Duplicate client number "${clientNumber}"` });
      hasError = true;
    }

    if (hasError) {
      skipped.push(rowNum);
      continue;
    }

    valid.push({
      clientName: clientName!,
      clientStatus: clientStatus! as any,
      city: city as any,
      matterType: matterType as any,
      clientNumber,
      fileNumber,
      createdBy: userId,
    });

    // Track in-batch duplicates
    if (clientName) existingNames.add(clientName.toLowerCase());
    if (fileNumber) existingFileNums.add(fileNumber.toLowerCase());
    if (clientNumber) existingClientNums.add(clientNumber.toLowerCase());
  }

  let imported = 0;
  if (valid.length > 0) {
    const inserted = await db.insert(clients).values(valid).returning();
    imported = inserted.length;
  }

  return { imported, skipped: skipped.length, errors };
}

// ─── Enhanced Dashboard Stats ─────────────────────────────────────────────────

export async function getClientDashboardStats() {
  const [clientCounts, financialSummary, actionsThisWeek] = await Promise.all([
    getClientStatusCounts(),
    getFinancialSummary(),
    getActionsThisWeek(),
  ]);
  return { ...clientCounts, ...financialSummary, actionsThisWeek };
}

