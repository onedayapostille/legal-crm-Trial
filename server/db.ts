import { and, count, desc, eq, getTableColumns, gte, inArray, lt, lte, ne, or, sql, ilike } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
  userNotifications,
  type Lead, type InsertUser, type InsertLead, type InsertMatter,
  type InsertTask, type InsertNote, type InsertPayment,
  type InsertCompany, type InsertActivityLog, type InsertChatSubmission,
  type InsertClient, type InsertClientMatter, type InsertClientLeadDetail,
  type InsertRejectedClient, type InsertFinancialRecord, type InsertClientActionLog,
  type InsertMatterLawyerRate,
} from "../drizzle/schema";
import { hashPassword } from "./_core/auth";
import { channelMediumRequired } from "../shared/const";
import { notifyLawyerAssignment } from "./emailNotifications";
import type { UserRole, UserStatus } from "../shared/const";

/**
 * Validate the two-level communication channel.
 *  - channel_type required when `requireType` (enquiry creation).
 *  - channel_medium required for Digital Channels and Referral.
 */
export function validateChannel(
  channelType: unknown,
  channelMedium: unknown,
  opts: { requireType: boolean },
) {
  const type = typeof channelType === "string" ? channelType.trim() : "";
  const medium = typeof channelMedium === "string" ? channelMedium.trim() : "";
  if (opts.requireType && !type) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Channel type is required." });
  }
  if (type && channelMediumRequired(type) && !medium) {
    const label = type === "Referral" ? "Referral name" : "Channel medium";
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} is required for ${type}.` });
  }
}

// ─── DB Connection ────────────────────────────────────────────────────────────

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

// Supabase requires SSL on BOTH the direct host (db.<ref>.supabase.co) and the
// connection pooler (<...>.pooler.supabase.com). Match both ".supabase.co" and
// ".supabase.com" so a pooler URL gets SSL even without an explicit ?sslmode.
function isSupabaseHost(hostnameOrUrl: string) {
  return /\.supabase\.(co|com)(\b|$)/.test(hostnameOrUrl);
}

function shouldUseSsl(databaseUrl: string) {
  try {
    const parsed = new URL(databaseUrl);
    return parsed.searchParams.get("sslmode") === "require" || isSupabaseHost(parsed.hostname);
  } catch {
    return databaseUrl.includes("sslmode=require") || isSupabaseHost(databaseUrl);
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

  // The client sends enquiryAt as a UTC ISO string; the timestamptz column wants a
  // Date. Postgres stores it as UTC regardless of the connection timezone.
  if (typeof sanitized.enquiryAt === "string") {
    const d = new Date(sanitized.enquiryAt);
    if (Number.isNaN(d.getTime())) delete sanitized.enquiryAt;
    else sanitized.enquiryAt = d;
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

// Current approved discount rates and formulas. Legacy billed_amount and
// remaining_advanced formulas are intentionally not applied; see
// FINANCIAL_FORMULAS.md for the Finance-approval items.
const DISCOUNT_RATES: Record<string, number> = {
  "N/A": 0,
  "P&L Head Lawyers": 5,
  "CEO": 10,
  "Board": 15,
};

// Active calculated fields are derived from discountApproval, agreedFees,
// revenue, and collectedAmount.
export function applyDiscountRules(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  // Never forward legacy amounts into an INSERT/UPDATE, even if an internal
  // caller supplies them. Existing database values are preserved separately.
  delete out.billedAmount;
  delete out.remainingAdvanced;

  const approval = String(out.discountApproval ?? "N/A");
  const pct = DISCOUNT_RATES[approval] ?? 0;
  const agreed = toNum(out.agreedFees) ?? 0;
  const discountAmt = round2(agreed * pct / 100);
  const netFees = round2(Math.max(0, agreed - discountAmt));

  out.discountPercentage = String(pct);
  out.discountAmount     = String(discountAmt);
  out.netFees            = String(netFees);

  // "Revenue" is the single active amount field. "Billed Amount" and
  // "Remaining Advanced" are LEGACY, READ-ONLY columns (CRM-012): the application
  // no longer writes them. Previously billed_amount was mirrored to revenue on
  // every write, which overwrote genuine historical billed values and forced
  // remaining_advanced to 0 — corrupting prior accounting meaning. We now leave
  // both columns untouched so historical data is preserved; new rows leave them
  // NULL. The `financial_billed_revenue_discrepancies` view (migration 0011)
  // surfaces any pre-existing rows where the two still differ, for finance review.
  const revenue   = toNum(out.revenue)         ?? 0;
  const collected = toNum(out.collectedAmount) ?? 0;

  // Outstanding remains an active derived field, computed from Revenue.
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

// Developer-facing guidance, logged to the SERVER console only — never sent to
// the client (it would leak setup details onto the public login screen).
export const DATABASE_URL_HELP =
  "DATABASE_URL is not set. The app reads it only from the environment — it is " +
  "never hard-coded. To fix:\n" +
  "  1. Copy the template:   cp .env.example .env\n" +
  "  2. Edit .env and set DATABASE_URL to your PostgreSQL connection string, e.g.\n" +
  "       DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/legal_crm\n" +
  "     (add ?sslmode=require for managed/remote databases)\n" +
  "  3. Restart the app (pnpm dev) or, with Docker, pass it via env_file/-e.\n" +
  "  See README.md → \"Secrets & Security\" / \"Troubleshooting\".";

// Concise, user-safe message returned to API callers (e.g. the login page).
export const DATABASE_NOT_CONFIGURED_MESSAGE =
  "The service is temporarily unavailable. Please try again later or contact your administrator.";

let _loggedDbHelp = false;

export function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      // Log the actionable guidance for operators/developers (server-side only),
      // once, then throw a generic message so nothing internal leaks to clients.
      if (!_loggedDbHelp) {
        console.error(`[DB] ${DATABASE_URL_HELP}`);
        _loggedDbHelp = true;
      }
      throw new Error(DATABASE_NOT_CONFIGURED_MESSAGE);
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

  // Migration ledger: record applied files so they are not re-executed on every
  // boot, and so drift between the files on disk and the DB is visible. Each
  // migration is still written to be individually idempotent, so the ledger is an
  // optimization + drift signal — NOT a correctness dependency (a fresh DB with no
  // ledger simply applies everything once, then records it).
  await client.unsafe(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   text        PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const appliedRows = (await client.unsafe(
    `SELECT filename FROM schema_migrations`,
  )) as unknown as Array<{ filename: string }>;
  const applied = new Set(appliedRows.map(r => r.filename));

  for (const file of migrationFiles) {
    if (applied.has(file)) continue; // already recorded as applied

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
    // Record on success OR on a benign "already exists" (objects are present).
    await client`INSERT INTO schema_migrations (filename) VALUES (${file}) ON CONFLICT DO NOTHING`;
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

export async function getAllLeads(filters?: {
  channelType?: string;
  channelMedium?: string;
  status?: string;
  search?: string;
  assignedTo?: number;
}) {
  const db = getDb();
  const conditions = [];
  if (filters?.channelType) conditions.push(eq(leads.channelType, filters.channelType));
  if (filters?.channelMedium) conditions.push(ilike(leads.channelMedium, `%${filters.channelMedium}%`));
  if (filters?.status) conditions.push(eq(leads.currentStatus, filters.status as any));
  if (filters?.assignedTo) conditions.push(eq(leads.assignedTo, filters.assignedTo));
  if (filters?.search) {
    const t = `%${filters.search}%`;
    conditions.push(or(ilike(leads.clientName, t), ilike(leads.leadCode, t), ilike(leads.email, t)));
  }
  // Join the assigned user so the list can show/report the lead lawyer's name.
  const q = db
    .select({ ...getTableColumns(leads), assignedToName: users.name })
    .from(leads)
    .leftJoin(users, eq(users.id, leads.assignedTo))
    .orderBy(desc(leads.createdAt));
  return conditions.length ? q.where(and(...conditions)) : q;
}

/** Distinct channel values present in the leads table — powers filter dropdowns. */
export async function getLeadChannelOptions() {
  const db = getDb();
  const rows = await db
    .selectDistinct({ channelType: leads.channelType, channelMedium: leads.channelMedium })
    .from(leads);
  const types = new Set<string>();
  const mediums = new Set<string>();
  for (const r of rows) {
    if (r.channelType) types.add(r.channelType);
    if (r.channelMedium) mediums.add(r.channelMedium);
  }
  return { types: Array.from(types).sort(), mediums: Array.from(mediums).sort() };
}

export async function getLeadById(id: number) {
  const db = getDb();
  const result = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  return result[0] ?? null;
}

// Roles that may be assigned as a lead lawyer on an enquiry.
const LEAD_LAWYER_ROLES = ["partner", "lawyer"] as const;

/** Active Partners/Lawyers for the "Suggested Lead Lawyer" dropdown. */
export async function getLeadLawyers() {
  const db = getDb();
  return db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.status, "active"), inArray(users.role, [...LEAD_LAWYER_ROLES] as any)))
    .orderBy(users.name);
}

/** Validate an assigned lead-lawyer id; throws on invalid/inactive/wrong-role. */
export async function assertLeadLawyer(userId: number) {
  const db = getDb();
  const [u] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) throw new TRPCError({ code: "BAD_REQUEST", message: "Selected lead lawyer does not exist." });
  if (u.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "Selected lead lawyer is not active." });
  if (!(LEAD_LAWYER_ROLES as readonly string[]).includes(u.role)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Lead lawyer must be a Partner or Lawyer." });
  }
  return u;
}

// ─── In-app notifications ─────────────────────────────────────────────────────

export async function createNotification(data: {
  userId: number; title: string; body?: string; entityType?: string; entityId?: number;
}) {
  const db = getDb();
  const [n] = await db.insert(userNotifications).values(data).returning();
  return n;
}

export async function getUserNotifications(userId: number, limit = 20) {
  const db = getDb();
  return db
    .select()
    .from(userNotifications)
    .where(eq(userNotifications.userId, userId))
    .orderBy(desc(userNotifications.createdAt))
    .limit(limit);
}

export async function getUnreadNotificationCount(userId: number) {
  const db = getDb();
  const [row] = await db
    .select({ count: count() })
    .from(userNotifications)
    .where(and(eq(userNotifications.userId, userId), eq(userNotifications.isRead, false)));
  return Number(row?.count ?? 0);
}

export async function markNotificationRead(id: number, userId: number) {
  const db = getDb();
  await db
    .update(userNotifications)
    .set({ isRead: true })
    .where(and(eq(userNotifications.id, id), eq(userNotifications.userId, userId)));
  return { success: true };
}

export async function markAllNotificationsRead(userId: number) {
  const db = getDb();
  await db
    .update(userNotifications)
    .set({ isRead: true })
    .where(and(eq(userNotifications.userId, userId), eq(userNotifications.isRead, false)));
  return { success: true };
}

/**
 * Notify a newly assigned lead lawyer: in-app notification (stored) + email
 * (via the pluggable email utility). Email is best-effort and never blocks/throws.
 */
async function notifyLeadAssignment(
  lawyer: { id: number; name: string | null; email: string },
  lead: { id: number; leadCode: string | null; serviceRequested?: string | null; urgencyLevel?: string | null },
  clientName: string,
) {
  await createNotification({
    userId: lawyer.id,
    title: "New lead assignment",
    body: `You have been assigned as lead lawyer on a new enquiry: ${clientName}.`,
    entityType: "lead",
    entityId: lead.id,
  });
  // Best-effort email to the lawyer's registered address.
  void notifyLawyerAssignment(
    lawyer.email,
    lawyer.name ?? "Lawyer",
    lead.leadCode ?? `Lead #${lead.id}`,
    clientName,
    lead.serviceRequested ?? "—",
    lead.urgencyLevel ?? "—",
    "email",
  ).catch(err => console.error("[notifyLeadAssignment] email failed:", err));
}

// ─── Canonical intake mirror (lead → client) ──────────────────────────────────
//
// CANONICAL INTAKE MODEL: clients + client_lead_details.
//
// The legacy `leads` table remains the rich enquiry record and powers the
// Enquiries Log, but it is NOT the source of truth for the Leads Pipeline,
// dashboard lead metrics, Recent Leads, or Conversion Rate — those all read
// `clients`. To keep a single canonical source while preserving the legacy
// enquiry data, every lead create/update mirrors a linked canonical client
// (clients.source_lead_id = leads.id) plus its client_lead_details row.

/** Map a legacy enquiry `currentStatus` to a canonical `clientStatus`. */
export function mapLeadStatusToClientStatus(
  currentStatus: string | null | undefined,
): "Existing Client" | "Leads" | "Rejected" {
  switch (currentStatus) {
    case "Converted":
      return "Existing Client";
    case "Lost":
      return "Rejected";
    default:
      // New / Contacted / Meeting Scheduled / Proposal Sent / On Hold → still in pipeline
      return "Leads";
  }
}

/**
 * Create or update the canonical client mirror for a legacy lead, keyed by
 * clients.source_lead_id. Idempotent: safe to call on every lead create/update.
 *
 * Status handling is conservative — it never auto-resurrects a client that was
 * manually moved to "Rejected": a Rejected mirror is only promoted (e.g. when
 * the enquiry is later Converted), never silently dropped back to "Leads".
 */
export async function syncLeadToClient(lead: Lead): Promise<void> {
  const db = getDb();
  const mappedStatus = mapLeadStatusToClientStatus(lead.currentStatus);

  const [existing] = await db
    .select()
    .from(clients)
    .where(eq(clients.sourceLeadId, lead.id))
    .limit(1);

  let clientId: number;
  if (existing) {
    // Never auto-un-reject: keep a manual "Rejected" unless the enquiry itself
    // reached "Existing Client" (Converted).
    const nextStatus =
      existing.clientStatus === "Rejected" && mappedStatus === "Leads"
        ? "Rejected"
        : mappedStatus;
    await db
      .update(clients)
      .set({
        clientName: lead.clientName,
        clientStatus: nextStatus,
        updatedAt: new Date(),
      })
      .where(eq(clients.id, existing.id));
    clientId = existing.id;
  } else {
    const [created] = await db
      .insert(clients)
      .values({
        clientName: lead.clientName,
        clientStatus: mappedStatus,
        convertedFrom: "Enquiry",
        sourceLeadId: lead.id,
        createdBy: lead.createdBy ?? null,
      })
      .returning();
    clientId = created.id;
    // Audit only when we have a valid actor (audit_logs.user_id is an FK).
    if (lead.createdBy != null) {
      await createAuditLog({
        entityType: "client",
        entityId: clientId,
        userId: lead.createdBy,
        action: "created",
        description: `Client ${lead.clientName} mirrored from enquiry ${lead.leadCode ?? lead.id}`,
      });
    }
  }

  // Mirror the shared intake fields into client_lead_details (1:1 with client).
  await upsertClientLeadDetail(clientId, {
    channelType: lead.channelType ?? undefined,
    channelMedium: lead.channelMedium ?? undefined,
    assignedLawyerId: lead.assignedTo ?? null,
    clientSource: lead.referralSourceName ?? undefined,
    leadStatus: lead.currentStatus ?? undefined,
  });
}

export async function createLead(data: Record<string, unknown>, userId: number) {
  const db = getDb();
  const leadCode = await generateLeadCode();
  const sanitized = sanitizeLeadInput(data);

  // Validate + denormalize the assigned lead lawyer's name (store id + name).
  let lawyer: Awaited<ReturnType<typeof assertLeadLawyer>> | null = null;
  if (sanitized.assignedTo != null) {
    lawyer = await assertLeadLawyer(Number(sanitized.assignedTo));
    sanitized.suggestedLeadLawyer = lawyer.name ?? undefined;
  }

  const [lead] = await db
    .insert(leads)
    .values({ ...(sanitized as InsertLead), leadCode, createdBy: userId })
    .returning();

  // Mirror into the canonical client model so the enquiry is immediately visible
  // in the Leads Pipeline, dashboard metrics, Recent Leads, and Conversion Rate.
  await syncLeadToClient(lead);

  await logActivity({
    entityType: "lead",
    entityId: lead.id,
    action: "created",
    description: `Lead ${leadCode} created for ${data.clientName}`,
    performedBy: userId,
  });

  if (lawyer) await notifyLeadAssignment(lawyer, lead, String(data.clientName ?? lead.clientName));

  return lead;
}

export async function updateLead(id: number, data: Record<string, unknown>) {
  const db = getDb();
  const sanitized = sanitizeLeadInput(data);
  const existing = await getLeadById(id);

  if ((sanitized.currentStatus === "Converted" || sanitized.conversionDate) && !sanitized.matterCode) {
    if (!existing?.matterCode) {
      sanitized.matterCode = await generateMatterCode();
    }
  }

  // Validate + denormalize lead-lawyer name; notify only on a *change* of assignee.
  let newlyAssigned: Awaited<ReturnType<typeof assertLeadLawyer>> | null = null;
  if (sanitized.assignedTo != null) {
    const lawyer = await assertLeadLawyer(Number(sanitized.assignedTo));
    sanitized.suggestedLeadLawyer = lawyer.name ?? undefined;
    if (existing?.assignedTo !== lawyer.id) newlyAssigned = lawyer;
  }

  const [lead] = await db
    .update(leads)
    .set({ ...(sanitized as Partial<InsertLead>), updatedAt: new Date() })
    .where(eq(leads.id, id))
    .returning();

  // Keep the canonical client mirror in sync (status, name, channel, assignee).
  await syncLeadToClient(lead);

  if (newlyAssigned) await notifyLeadAssignment(newlyAssigned, lead, String(lead.clientName ?? ""));

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

export async function getLeadKpiMetrics(viewer?: TaskViewer) {
  const db = getDb();
  const [totalRow] = await db.select({ count: count() }).from(leads);
  const total = Number(totalRow?.count ?? 0);

  const [convertedRow] = await db
    .select({ count: count() })
    .from(leads)
    .where(eq(leads.currentStatus, "Converted"));
  const converted = Number(convertedRow?.count ?? 0);

  // "This month" is computed from the stored UTC enquiry timestamp using the DB
  // clock (date_trunc on now()), so it is timezone-consistent rather than relying
  // on a string-compared date built from the app server's local time.
  const [thisMonthRow] = await db
    .select({ count: count() })
    .from(leads)
    .where(gte(leads.enquiryAt, sql`date_trunc('month', now())`));
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

  // Pending-tasks KPI respects the same role-based visibility as the task list.
  const pendingConds = [ne(tasks.status, "done")];
  if (viewer) {
    const vis = await taskVisibilityCondition(viewer);
    if (vis) pendingConds.push(vis);
  }
  const [pendingTaskRow] = await db
    .select({ count: count() })
    .from(tasks)
    .where(and(...pendingConds));
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

// ─── Role-based task visibility (backend enforced) ────────────────────────────

export type TaskViewer = { id: number; role: string };

/** Active user ids whose supervisor (reports_to_id) is the given partner. */
export async function getReportingUserIds(partnerId: number): Promise<number[]> {
  const db = getDb();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.reportsToId, partnerId), eq(users.status, "active")));
  return rows.map(r => r.id);
}

/**
 * SQL WHERE condition restricting tasks to those the viewer may see:
 *   - admin / manager → null (no restriction; see all)
 *   - partner → own (assignee/creator) OR assigned to a lawyer reporting to them
 *   - everyone else (lawyer, staff, …) → own only (assignee or creator)
 * Returns null only for admin/manager.
 */
export async function taskVisibilityCondition(viewer: TaskViewer) {
  if (viewer.role === "admin" || viewer.role === "manager") return null;
  const own = or(eq(tasks.assignedTo, viewer.id), eq(tasks.createdBy, viewer.id));
  if (viewer.role === "partner") {
    const ids = await getReportingUserIds(viewer.id);
    if (ids.length > 0) return or(own, inArray(tasks.assignedTo, ids));
  }
  return own;
}

/** Whether a single task row is visible to the viewer (same rules as the SQL filter). */
export async function isTaskVisibleTo(
  task: { assignedTo: number | null; createdBy: number | null },
  viewer: TaskViewer,
): Promise<boolean> {
  if (viewer.role === "admin" || viewer.role === "manager") return true;
  if (task.assignedTo === viewer.id || task.createdBy === viewer.id) return true;
  if (viewer.role === "partner" && task.assignedTo != null) {
    const ids = await getReportingUserIds(viewer.id);
    if (ids.includes(task.assignedTo)) return true;
  }
  return false;
}

/** Throw NOT_FOUND if the task is missing OR not visible to the viewer (used by mutations). */
export async function assertTaskVisible(id: number, viewer: TaskViewer) {
  const task = await getTaskById(id, viewer);
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found." });
  return task;
}

export async function getAllTasks(
  filters?: {
    matterId?: number;
    assignedTo?: number;
    status?: string;
    clientId?: number;
    clientMatterId?: number;
  },
  viewer?: TaskViewer,
) {
  const db = getDb();
  const conditions = [];
  if (filters?.matterId) conditions.push(eq(tasks.matterId, filters.matterId));
  if (filters?.assignedTo) conditions.push(eq(tasks.assignedTo, filters.assignedTo));
  if (filters?.status) conditions.push(eq(tasks.status, filters.status as typeof tasks.status._.data));
  if (filters?.clientId) conditions.push(eq(tasks.clientId, filters.clientId));
  if (filters?.clientMatterId) conditions.push(eq(tasks.clientMatterId, filters.clientMatterId));

  // Backend-enforced role-based visibility (applies in addition to any filters).
  if (viewer) {
    const vis = await taskVisibilityCondition(viewer);
    if (vis) conditions.push(vis);
  }

  // Join assignee + client + client matter so BOTH the main Tasks page and the
  // per-client tab render full context (client name, matter reference/type,
  // assignee) from one query — they read the exact same rows, just filtered.
  return db
    .select({
      ...getTableColumns(tasks),
      assigneeName: users.name,
      clientName: clients.clientName,
      matterReference: clientMatters.matterReference,
      matterType: clientMatters.matterType,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedTo))
    .leftJoin(clients, eq(clients.id, tasks.clientId))
    .leftJoin(clientMatters, eq(clientMatters.id, tasks.clientMatterId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(tasks.dueDate, desc(tasks.createdAt));
}

/**
 * Single task enriched with all the context the Task Details view needs:
 * client (name + status), matter (reference, type, lead partner), assignee and
 * creator names, and the originating action-log entry when one is linked. The
 * row-level visibility check is preserved — returns null when the viewer may not
 * see the task (no data leak). Read access is intentionally NOT blocked for
 * Rejected clients: historical tasks stay viewable for audit/history.
 */
export async function getTaskById(id: number, viewer?: TaskViewer) {
  const db = getDb();
  const creator = alias(users, "task_creator");
  const actionLog = alias(clientActionLogs, "task_source_action_log");
  const [task] = await db
    .select({
      ...getTableColumns(tasks),
      assigneeName: users.name,
      creatorName: creator.name,
      clientName: clients.clientName,
      clientStatus: clients.clientStatus,
      matterReference: clientMatters.matterReference,
      matterType: clientMatters.matterType,
      matterLeadPartner: clientMatters.leadPartnerFullName,
      // Originating action-log entry (when the task was created from one) so the
      // detail view can show its context and link back to it.
      actionLogId: actionLog.id,
      actionLogType: actionLog.actionType,
      actionLogDate: actionLog.actionDate,
      actionLogDetails: actionLog.actionDetails,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedTo))
    .leftJoin(creator, eq(creator.id, tasks.createdBy))
    .leftJoin(clients, eq(clients.id, tasks.clientId))
    .leftJoin(clientMatters, eq(clientMatters.id, tasks.clientMatterId))
    .leftJoin(actionLog, eq(actionLog.id, tasks.clientActionLogId))
    .where(eq(tasks.id, id))
    .limit(1);
  if (!task) return null;
  if (viewer && !(await isTaskVisibleTo(task, viewer))) return null;
  return task;
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

export async function getDashboardStats(viewer?: TaskViewer) {
  return getLeadKpiMetrics(viewer);
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
  // Unified intake filters:
  convertedFrom?: string;      // origin: Lead | Enquiry | Direct
  assignedLawyerId?: number;   // lead's assigned lawyer (client_lead_details)
  createdFrom?: string;        // YYYY-MM-DD (inclusive)
  createdTo?: string;          // YYYY-MM-DD (inclusive)
  channelType?: string;        // communication channel type (client_lead_details)
  channelMedium?: string;      // communication channel medium
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
  if (filters?.convertedFrom) {
    conditions.push(eq(clients.convertedFrom, filters.convertedFrom as any));
  }
  if (filters?.assignedLawyerId) {
    conditions.push(eq(clientLeadDetails.assignedLawyerId, filters.assignedLawyerId));
  }
  if (filters?.channelType) {
    conditions.push(eq(clientLeadDetails.channelType, filters.channelType));
  }
  if (filters?.channelMedium) {
    conditions.push(ilike(clientLeadDetails.channelMedium, `%${filters.channelMedium}%`));
  }
  // Date range on created_at, compared with the DB clock (timezone-consistent).
  if (filters?.createdFrom) {
    conditions.push(gte(clients.createdAt, sql`${filters.createdFrom}::timestamp`));
  }
  if (filters?.createdTo) {
    conditions.push(lt(clients.createdAt, sql`(${filters.createdTo}::date + 1)`));
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

  // Left-join the lead detail (1:1) + assigned lawyer user so the intake page can
  // filter/show the assigned lawyer. All client columns are preserved, plus two
  // additive fields, so existing consumers are unaffected.
  const base = db
    .select({
      ...getTableColumns(clients),
      assignedLawyerId: clientLeadDetails.assignedLawyerId,
      assignedLawyerName: users.name,
      channelType: clientLeadDetails.channelType,
      channelMedium: clientLeadDetails.channelMedium,
    })
    .from(clients)
    .leftJoin(clientLeadDetails, eq(clientLeadDetails.clientId, clients.id))
    .leftJoin(users, eq(users.id, clientLeadDetails.assignedLawyerId))
    .orderBy(desc(clients.createdAt));

  if (conditions.length > 0) {
    return base.where(and(...conditions));
  }
  return base;
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
/**
 * Canonical form used to compare names for conflict checking. The goal is to
 * tolerate harmless differences (case, spacing, punctuation, common Arabic
 * spelling variants) WITHOUT fuzzy matching that would create false positives —
 * matching stays substring-exact on the normalized form.
 *
 *   - lower-cased
 *   - Arabic diacritics (tashkeel) stripped
 *   - alef variants (أ إ آ) → bare alef (ا); alef-maksura (ى) → yaa (ي);
 *     taa-marbuta (ة) → haa (ه) — the usual data-entry inconsistencies
 *   - Arabic-Indic digits (٠-٩) → Latin (0-9)
 *   - any punctuation/symbol, Arabic or Latin (، ؛ ؟ . , - / …), → a space
 *   - whitespace collapsed
 */
export function normalizeForConflict(input: string): string {
  return input
    .toLowerCase()
    .replace(/[ً-ْٰ]/g, "") // tashkeel / superscript alef
    .replace(/[آأإٱ]/g, "ا") // أ إ آ ٱ → ا
    .replace(/ى/g, "ي") // ى → ي
    .replace(/ة/g, "ه") // ة → ه
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)) // ٠-٩ → 0-9
    // Punctuation/symbols (Latin + Arabic: ، ؛ ؟ ٫ ٬ « » … – —) and whitespace
    // → a single space, so "Al-Futtaim", "Al Futtaim" and "الفطيم، ش.م.ع" align.
    .replace(/[\s!-/:-@[-`{-~،؛؟٫٬٭۔«»…–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function searchConflicts(rawQuery: string): Promise<ConflictMatch[]> {
  const db = getDb();
  const needle = normalizeForConflict(rawQuery);
  if (!needle) return [];

  // Precise, conservative decision: the normalized query must appear as a
  // substring of the normalized candidate value. Tolerates case/spacing/
  // punctuation/Arabic-variant differences but is not fuzzy.
  const contains = (v: string | null | undefined) => !!v && normalizeForConflict(v).includes(needle);

  // SQL pre-filter — fetch a superset of candidates. Because punctuation differs
  // between query and stored value, we ilike on each significant *token* of the
  // normalized query (tokens carry no punctuation, so they still match inside
  // "Al-Futtaim", "Al Futtaim", etc.). The precise `contains` check above then
  // refines the result set in JS.
  const tokens = needle.split(" ").filter(t => t.length >= 2);
  const searchTokens = tokens.length > 0 ? tokens : [needle];
  const likeFor = (cols: any[]) =>
    or(...cols.flatMap(col => searchTokens.map(tok => ilike(col, `%${tok}%`))));

  // 1) Clients — name / client # / file #
  const matchedClients = await db
    .select()
    .from(clients)
    .where(likeFor([clients.clientName, clients.clientNumber, clients.fileNumber]))
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
      likeFor([
        clientMatters.matterReference,
        clientMatters.matterType,
        clientMatters.matterDescription,
        clientMatters.opposingParty,
      ]),
    )
    .orderBy(desc(clientMatters.createdAt));

  const matches: ConflictMatch[] = [];

  for (const c of matchedClients) {
    // Refine the broadened token pre-filter down to a precise normalized hit.
    if (!contains(c.clientName) && !contains(c.clientNumber) && !contains(c.fileNumber)) continue;
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
 *
 * `clientId` (the prospective matter's owning client) scopes out FALSE POSITIVES:
 * by confirmed rule, different clients MAY reuse the same Matter Reference, so a
 * "Matter" match that belongs to a DIFFERENT client is not a conflict of interest
 * and is excluded. Genuine conflict signals — an existing Client by that name, an
 * Opposing Party match, or a same-client matter — are always kept. The standalone
 * manual search (clients.conflictCheck) passes no clientId and is unaffected.
 */
export async function checkMatterConflicts(opts: {
  matterName?: string | null;
  opposingParty?: string | null;
  clientId?: number | null;
}): Promise<ConflictMatch[]> {
  const terms = [opts.matterName, opts.opposingParty]
    .map(t => (t ?? "").trim())
    .filter(t => t.length > 0);
  if (terms.length === 0) return [];

  const all: ConflictMatch[] = [];
  for (const t of terms) all.push(...(await searchConflicts(t)));

  const seen = new Set<string>();
  return all.filter(m => {
    // A matter under a DIFFERENT client sharing this reference/type/description is
    // allowed (references are unique per-client, not globally) — drop it.
    if (opts.clientId != null && m.matchType === "Matter" && m.clientId !== opts.clientId) {
      return false;
    }
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
 * Conversion Rate KPI — the single source of truth for every Conversion Rate
 * display (dashboard card, KPI dashboard, reports). It reads the canonical
 * Leads Pipeline (the `clients` intake model), NOT the legacy `leads` table and
 * NOT the revenue "Pipeline" (pipeline-forecast). Those are kept separate by
 * design so lead-to-client conversion is never mixed with revenue/workflow data.
 *
 *   Conversion Rate = converted leads / total leads * 100
 *
 *   - total leads     = intake whose channel is Lead or Enquiry — i.e. every
 *                       valid lead (Direct walk-ins are NOT leads, so excluded).
 *                       Rejected/Lost leads REMAIN in the denominator. Reported
 *                       split as totalLeads + totalEnquiries.
 *   - converted leads = those leads that became clients. In the canonical model a
 *                       lead "became a client" exactly when its mirror reached
 *                       clientStatus "Existing Client" — which is what the lead
 *                       statuses "Converted"/"Existing Client", a linked client,
 *                       and a non-null conversion date all collapse to here.
 *
 * Because the numerator is a strict subset of the denominator, the rate is
 * always between 0 and 100, rounded to one decimal place, and is 0 (never NaN)
 * when there are no leads in the period.
 *
 * Cohort filter: `range` bounds leads by createdAt (lead creation date): this
 * month, this quarter, or all time. Monthly/Quarterly rate = leads CREATED in
 * the period that converted / total leads CREATED in the period.
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
    period: range,            // alias: the selected period (month | quarter | all)
    convertedClients,
    converted: convertedClients, // alias: "Converted leads count"
    totalLeads,
    totalEnquiries,
    totalIntake,
    total: totalIntake,       // alias: "Total leads count"
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
      leadLawyerId: clientMatters.leadLawyerId,
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

// ─── Original Serial (inherited client number) + Matter Reference ─────────────
//
// CONFIRMED BUSINESS RULE (CRM-007):
//   * client_matters.original_serial = the PARENT CLIENT's Original Serial /
//     Client Number. It represents the client, NOT the matter. Multiple matters
//     under the same client SHARE the same original_serial. It is therefore NOT
//     unique, has NO MAT-#### format, and is never max+1 allocated.
//   * matter_reference is the matter-level identifier. Uniqueness is enforced on
//     (client_id, matter_reference) — a client cannot have two matters with the
//     same reference. Different clients may reuse a reference.

/** True if a Postgres unique-violation (used to map races to a friendly error). */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23505";
}

/**
 * The Original Serial a new/blank matter should inherit from its parent client:
 * the client's Original Serial / Client Number. Fallbacks when the client has no
 * client number (documented): file number, else "CL-<clientId>" so the column is
 * never left blank and still ties back to the client.
 */
export async function defaultOriginalSerialFromClient(clientId: number): Promise<string> {
  const client = await getClientById(clientId);
  const fromNumber = (client?.clientNumber ?? "").trim();
  if (fromNumber) return fromNumber;
  const fromFile = (client?.fileNumber ?? "").trim();
  if (fromFile) return fromFile;
  return `CL-${clientId}`;
}

/**
 * Enforce that a client does not already have another matter with the same
 * matter_reference (CRM-007). Blank references are not constrained (a client may
 * have several matters with no reference yet). Application-level check that
 * mirrors the (client_id, matter_reference) unique index.
 */
export async function assertMatterReferenceUniqueForClient(
  clientId: number,
  matterReference: string | null | undefined,
  excludeId?: number,
): Promise<void> {
  const ref = (matterReference ?? "").trim();
  if (!ref) return; // blank reference → not constrained
  const db = getDb();
  const conds = [eq(clientMatters.clientId, clientId), eq(clientMatters.matterReference, ref)];
  if (excludeId) conds.push(ne(clientMatters.id, excludeId));
  const rows = await db.select({ id: clientMatters.id }).from(clientMatters).where(and(...conds)).limit(1);
  if (rows.length > 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Matter Reference "${ref}" is already used by another matter for this client. It must be unique per client.`,
    });
  }
}

export async function createClientMatter(
  data: Record<string, unknown>,
  userId: number,
  conflicts: ConflictMatch[] = [],
) {
  const db = getDb();
  const clean = sanitizeClientMatterInput(data) as Partial<InsertClientMatter>;
  const clientId = (data as any).clientId as number;

  // Matter Type is authoritative at the matter level (CRM-006): require it.
  if (!clean.matterType || String(clean.matterType).trim() === "") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Matter Type is required when creating a matter." });
  }

  // Matter Reference is the matter-level identifier and is required for new
  // matters (CRM-007). Checked against the raw input because the sanitizer drops
  // blank strings.
  if (!(typeof data.matterReference === "string" && data.matterReference.trim() !== "")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Matter Reference is required when creating a matter." });
  }

  // Original Serial = inherited client number. If not provided, default it from
  // the parent client. If provided, use it as-is (NOT unique, no format).
  const providedSerial = typeof clean.originalSerial === "string" ? clean.originalSerial.trim() : "";
  clean.originalSerial = providedSerial || (await defaultOriginalSerialFromClient(clientId));

  // Matter Reference is the matter-level identifier and must be unique per client.
  await assertMatterReferenceUniqueForClient(clientId, clean.matterReference);

  // Lead Partner may be assigned as a real user (CRM-013). Validate the user is
  // active + eligible, and mirror the name into the legacy display column. The
  // legacy leadPartner* free-text remains supported for records without a user.
  if (data.leadLawyerId != null) {
    const lawyer = await resolveAssignedUser(Number(data.leadLawyerId));
    clean.leadLawyerId = lawyer.id;
    clean.leadPartnerFullName = lawyer.name ?? clean.leadPartnerFullName;
  }

  let matter: typeof clientMatters.$inferSelect;
  try {
    [matter] = await db
      .insert(clientMatters)
      .values({ ...clean, clientId, createdBy: userId } as InsertClientMatter)
      .returning();
  } catch (err) {
    // DB backstop for the (client_id, matter_reference) unique index.
    if (isUniqueViolation(err)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Matter Reference "${clean.matterReference}" is already used by another matter for this client.`,
      });
    }
    throw err;
  }

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
  const existing = await getClientMatterById(id);

  // Original Serial: preserve the existing value. If it is being cleared (blank),
  // refill it from the parent client's Original Serial / Client Number — it is
  // never left empty and never re-allocated. A non-blank provided value is kept.
  if (clean.originalSerial !== undefined) {
    const provided = String(clean.originalSerial ?? "").trim();
    if (provided) {
      clean.originalSerial = provided;
    } else if (existing) {
      clean.originalSerial = (existing.originalSerial ?? "").trim()
        || (await defaultOriginalSerialFromClient(existing.clientId));
    } else {
      delete clean.originalSerial;
    }
  }

  // Matter Reference is required going forward (CRM-007): when an update touches
  // it, it cannot be blanked. Detected on the RAW input (the sanitizer drops blank
  // strings, so a blank submission would otherwise look like "not provided").
  // Updates that do NOT include matterReference are left alone, so editing other
  // fields on a legacy record with a blank reference is not blocked or overwritten.
  if (data.matterReference !== undefined) {
    const rawRef = typeof data.matterReference === "string" ? data.matterReference.trim() : "";
    if (!rawRef) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Matter Reference is required and cannot be cleared." });
    }
    if (existing) {
      await assertMatterReferenceUniqueForClient(existing.clientId, rawRef, id);
    }
  }

  // Lead Partner user link (CRM-013). A number assigns + validates the user and
  // syncs the legacy display name; an explicit null unlinks (keeping any legacy
  // free-text). Handled off the raw input because the sanitizer drops null.
  if (data.leadLawyerId !== undefined) {
    if (data.leadLawyerId === null) {
      clean.leadLawyerId = null;
    } else {
      const lawyer = await resolveAssignedUser(Number(data.leadLawyerId));
      clean.leadLawyerId = lawyer.id;
      clean.leadPartnerFullName = lawyer.name ?? clean.leadPartnerFullName;
    }
  }

  let matter: typeof clientMatters.$inferSelect;
  try {
    [matter] = await db
      .update(clientMatters)
      .set({ ...clean, updatedAt: new Date() })
      .where(eq(clientMatters.id, id))
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Matter Reference "${clean.matterReference}" is already used by another matter for this client.`,
      });
    }
    throw err;
  }
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

  try {
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
  } catch (err) {
    // DB backstop for the (client_matter_id, user_id) unique index — covers the
    // race between the app-level duplicate check above and the insert.
    if (isUniqueViolation(err)) {
      throw new TRPCError({ code: "CONFLICT", message: `${lawyer.name ?? "This lawyer"} already has a rate on this matter.` });
    }
    throw err;
  }
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

  let rate: typeof matterLawyerRates.$inferSelect;
  try {
    [rate] = await db
      .update(matterLawyerRates)
      .set(updates)
      .where(eq(matterLawyerRates.id, id))
      .returning();
  } catch (err) {
    // Reassigning a rate to a user who already has one on this matter collides
    // with the (client_matter_id, user_id) unique index.
    if (isUniqueViolation(err)) {
      throw new TRPCError({ code: "CONFLICT", message: "That lawyer already has a rate on this matter." });
    }
    throw err;
  }
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

/**
 * Validate the (clientId, clientMatterId) pair for a financial record (CRM-010).
 * Client-level records are allowed (clientMatterId null/undefined → no-op). When a
 * matter IS linked, it must exist AND belong to the same client — enforced
 * server-side so a record can never point at another client's matter, regardless
 * of frontend filtering.
 */
export async function assertMatterBelongsToClient(
  clientMatterId: number | null | undefined,
  clientId: number,
): Promise<void> {
  if (clientMatterId == null) return; // client-level record — allowed
  const matter = await getClientMatterById(clientMatterId);
  if (!matter) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Selected matter does not exist." });
  }
  if (matter.clientId !== clientId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Selected matter belongs to a different client. The matter must belong to this client.",
    });
  }
}

export async function createFinancialRecord(data: InsertFinancialRecord, userId: number) {
  const db = getDb();
  await assertMatterBelongsToClient((data as any).clientMatterId, (data as any).clientId);
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

  // Defense in depth for internal callers: the public router does not accept
  // these legacy fields, and this service must never write them either.
  const {
    billedAmount: _legacyBilledAmount,
    remainingAdvanced: _legacyRemainingAdvanced,
    ...editableData
  } = data;

  // CRM-010: if the matter link is being set/changed (and not cleared), it must
  // belong to this record's client. clientId is immutable on update.
  if (editableData.clientMatterId != null) {
    await assertMatterBelongsToClient(editableData.clientMatterId, existing.clientId);
  }

  // Only pass the 5 user-editable inputs to applyDiscountRules — never spread
  // the full DB row (which contains id, createdAt, etc.) into SET.
  // Revenue is the single active amount input. Legacy amounts are excluded.
  const rulesInput = {
    discountApproval: editableData.discountApproval ?? existing.discountApproval ?? "N/A",
    agreedFees:       editableData.agreedFees       ?? existing.agreedFees,
    revenue:          editableData.revenue          ?? existing.revenue,
    collectedAmount:  editableData.collectedAmount  ?? existing.collectedAmount,
  };
  const computed = applyDiscountRules(rulesInput as Record<string, unknown>);

  const [record] = await db
    .update(financialRecords)
    .set({
      // user-supplied partial update fields
      ...editableData,
      // server-computed overrides (always win over any client value).
      // billedAmount + remainingAdvanced are intentionally NOT set here: they are
      // legacy, read-only columns and must keep their historical values (CRM-012).
      discountPercentage: computed.discountPercentage as string,
      discountAmount:     computed.discountAmount     as string,
      netFees:            computed.netFees            as string,
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
      // To Be Billed = MAX(0, netFees - revenue), using Net Fees (after discount).
      // Fall back to agreedFees when netFees is NULL (legacy rows never re-saved):
      // with no discount applied netFees == agreedFees, so the result is unchanged.
      totalToBeBilled:  sql<string>`COALESCE(SUM(GREATEST(0, COALESCE(${financialRecords.netFees}, ${financialRecords.agreedFees}, 0)::numeric - COALESCE(${financialRecords.revenue}, 0)::numeric)), 0)`,
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

  // Reusable SQL expression: MAX(0, netFees - revenue) per row, then SUM.
  // Net Fees (after discount) is the basis; falls back to agreedFees when netFees
  // is NULL (legacy rows). Revenue is the single amount source; legacy
  // billed_amount is not used.
  const tbbSum = sql<string>`COALESCE(SUM(GREATEST(0, COALESCE(${financialRecords.netFees}, ${financialRecords.agreedFees}, 0)::numeric - COALESCE(${financialRecords.revenue}, 0)::numeric)), 0)`;

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
  // Provenance so the Tasks UI can label the origin clearly (e.g. Document, Call,
  // Meeting, Email). The concrete action-log row is `source_id`; the one-to-one
  // `client_action_log_id` remains the idempotent upsert key + detail back-link,
  // which is why these auto-created tasks are never duplicated.
  const sourceType = (log.actionType ?? "").trim() || "action_log";
  const values = {
    title,
    description: description ?? null,
    clientId: log.clientId,
    clientMatterId: log.clientMatterId ?? null,
    clientActionLogId: log.id,
    sourceType,
    sourceId: log.id,
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
        sourceType,
        sourceId: log.id,
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

