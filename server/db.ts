import { and, count, desc, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import fs from "fs";
import path from "path";
import {
  users, companies, leads, matters, tasks, notes, documents, payments,
  activityLogs, auditLogs, chatSubmissions,
  type InsertUser, type InsertLead, type InsertMatter,
  type InsertTask, type InsertNote, type InsertPayment,
  type InsertCompany, type InsertActivityLog, type InsertChatSubmission,
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

  const [activeMatterRow] = await db
    .select({ count: count() })
    .from(matters)
    .where(eq(matters.status, "active"));
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

