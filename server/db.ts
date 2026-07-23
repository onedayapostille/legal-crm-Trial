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
  userNotifications, aiAuditLogs, practiceHeads,
  type Lead, type InsertUser, type InsertLead, type InsertMatter,
  type InsertTask, type InsertNote, type InsertPayment,
  type InsertCompany, type InsertActivityLog, type InsertChatSubmission,
  type InsertClient, type InsertClientMatter, type InsertClientLeadDetail,
  type InsertRejectedClient, type InsertFinancialRecord, type InsertClientActionLog,
  type InsertMatterLawyerRate, type Client, type ClientMatter, type FinancialRecord,
} from "../drizzle/schema";
import { hashPassword } from "./_core/auth";
import { channelMediumRequired, MATTER_TYPES, isSupportedMatterType } from "../shared/const";
import { notifyLawyerAssignment } from "./emailNotifications";
import type { UserRole, UserStatus } from "../shared/const";
import { ASSIGNMENT_FIELDS, LEGAL_TEAM_ASSIGNMENT_ROLES, type AssignmentField } from "../shared/assignmentEligibility";
import {
  LEAD_LAWYER_ELIGIBLE_ROLES,
  leadLawyerOverlayApplies,
  clientEditLimitedToExistingClients,
  scopeFor,
  can,
  type Scope,
} from "../shared/permissions";
import {
  clientScopeCondition,
  matterScopeCondition,
  financialViewCondition,
  mayViewAnyFinancial,
  taskScopeCondition,
  clientInUserPracticeCondition,
  matterInUserPracticeCondition,
  matterTeamCondition,
  isMatterAssignedToUser,
  isLeadLawyerOfMatter,
  effectiveMatterType,
  practiceKey,
  changedScopeDefiningFields,
  MATTER_SCOPE_DEFINING_FIELDS,
  CLIENT_SCOPE_DEFINING_FIELDS,
  type AuthUser,
} from "./authorization";

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

// Finance / Invoicing: monetary inputs must be finite and NON-NEGATIVE.
// The public router validates this via zod (nonNegativeMoney), but this guard is
// defense-in-depth for any internal caller of create/updateFinancialRecord.
// Empty / null / undefined means "leave unset" and is allowed. Throws BAD_REQUEST
// (HTTP 400) on a negative or non-numeric amount. Outstanding is separately
// clamped to max(0, revenue - collected) in applyDiscountRules and so can never
// be persisted negative.
export function assertNonNegativeFinancialAmounts(data: Record<string, unknown>) {
  for (const field of ["agreedFees", "revenue", "collectedAmount"] as const) {
    const raw = data[field];
    if (raw === null || raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${field} must be a valid non-negative number.`,
      });
    }
  }
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

// Roles that may be assigned as a lead lawyer on an enquiry: the central
// Lead-Lawyer-eligible set (Trainee excluded per the documented spec conflict;
// legacy partner/lawyer retained for un-migrated accounts).
const LEAD_LAWYER_ROLES = LEAD_LAWYER_ELIGIBLE_ROLES;

/** Active Lead-Lawyer-eligible users for the "Suggested Lead Lawyer" dropdown. */
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
    throw new TRPCError({ code: "BAD_REQUEST", message: "Lead lawyer must be a Lead-Lawyer-eligible lawyer grade." });
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

  // Dashboard KPIs are scoped like the underlying modules (V (Asgn)/(Reg) in
  // the matrix): intake/conversion KPIs require firm-wide or registry client
  // visibility; the revenue KPI requires firm-wide financial visibility;
  // active matters and pending tasks are computed over the viewer's scope.
  const clientScope = viewer ? scopeFor(viewer.role, "clients.view") : "ALL";
  const intakeVisible = clientScope === "ALL" || clientScope === "REGISTRY";
  const revenueVisible = !viewer || scopeFor(viewer.role, "financial.view") === "ALL";

  const canonicalConversion = intakeVisible
    ? await getClientConversionMetrics("all")
    : { totalLeads: 0, convertedLeads: 0, conversionRate: 0 };
  const canonicalMonth = intakeVisible
    ? await getClientConversionMetrics("month")
    : { totalLeads: 0 };

  let total = 0;
  let converted = 0;
  let thisMonth = 0;
  if (intakeVisible) {
    const [totalRow] = await db.select({ count: count() }).from(leads);
    total = Number(totalRow?.count ?? 0);

    const [convertedRow] = await db
      .select({ count: count() })
      .from(leads)
      .where(eq(leads.currentStatus, "Converted"));
    converted = Number(convertedRow?.count ?? 0);

    // "This month" is computed from the stored UTC enquiry timestamp using the DB
    // clock (date_trunc on now()), so it is timezone-consistent rather than relying
    // on a string-compared date built from the app server's local time.
    const [thisMonthRow] = await db
      .select({ count: count() })
      .from(leads)
      .where(gte(leads.enquiryAt, sql`date_trunc('month', now())`));
    thisMonth = Number(thisMonthRow?.count ?? 0);
  }

  let revenue: number | null = null;
  if (revenueVisible) {
    const [revenueRow] = await db
      .select({ total: sql<string>`COALESCE(SUM(${leads.proposalValue}), 0)` })
      .from(leads)
      .where(eq(leads.currentStatus, "Converted"));
    revenue = Number(revenueRow?.total ?? 0);
  }

  // "Active Matters" counts client matters whose status is exactly "Active"
  // (case/whitespace-insensitive, since client_matters.matter_status is free-text).
  // This is the same table/data shown on the /matters list, so the KPI value and
  // the click-through filtered list always agree (both viewer-scoped).
  const activeMatterConds = [isActiveMatterStatus()];
  if (viewer) {
    const matterCond = matterScopeCondition(viewer, scopeFor(viewer.role, "matters.view"));
    if (matterCond) activeMatterConds.push(matterCond);
  }
  const [activeMatterRow] = await db
    .select({ count: count() })
    .from(clientMatters)
    .where(and(...activeMatterConds));
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
    totalLeads: canonicalConversion.totalLeads,
    legacyTotalLeads: total,
    newLeads: canonicalMonth.totalLeads,
    legacyNewLeads: thisMonth,
    convertedLeads: canonicalConversion.convertedLeads,
    legacyConvertedLeads: converted,
    conversionTotalLeads: canonicalConversion.totalLeads,
    conversionRate: canonicalConversion.conversionRate,
    totalRevenue: revenue,
    activeMatters,
    pendingTasks,
  };
}

export async function getRecentActivity(limit = 20, viewer?: TaskViewer) {
  const db = getDb();
  // Firm-wide activity feed is reserved for roles with firm-wide/registry
  // client visibility; ASSIGNED-scope viewers see only their own actions
  // (activity rows reference entities across the whole firm).
  const conditions = [];
  if (viewer) {
    const clientScope = scopeFor(viewer.role, "clients.view");
    if (clientScope === "NONE") return [];
    if (clientScope !== "ALL" && clientScope !== "REGISTRY") {
      conditions.push(eq(activityLogs.performedBy, viewer.id));
    }
  }
  return db
    .select()
    .from(activityLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
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

/**
 * Legacy matters module (the standalone `matters` table, single assigned_to
 * FK). ASSIGNED scope = matters assigned to or created by the viewer. Legacy
 * matters carry no city/matter-type pair, so they resolve to NO practice:
 * OWN_PRACTICE editors (Head of Practice) get view-all but no edit/create on
 * this legacy module (least privilege, documented).
 */
function legacyMatterScopeCondition(viewer: TaskViewer) {
  const scope = scopeFor(viewer.role, "matters.view");
  if (scope === "ALL" || scope === "REGISTRY") return undefined;
  if (scope === "NONE") return sql`FALSE`;
  return or(eq(matters.assignedTo, viewer.id), eq(matters.createdBy, viewer.id));
}

export async function getAllMatters(viewer?: TaskViewer) {
  const db = getDb();
  const cond = viewer ? legacyMatterScopeCondition(viewer) : undefined;
  return db.select().from(matters).where(cond).orderBy(desc(matters.createdAt));
}

export async function getMatterById(id: number, viewer?: TaskViewer) {
  const db = getDb();
  const scopeCond = viewer ? legacyMatterScopeCondition(viewer) : undefined;
  const where = scopeCond ? and(eq(matters.id, id), scopeCond) : eq(matters.id, id);
  const result = await db.select().from(matters).where(where).limit(1);
  return result[0] ?? null;
}

/** Edit/delete guard for legacy matters (no practice resolution possible). */
export async function assertCanEditLegacyMatter(viewer: TaskViewer, id: number) {
  const matter = await getMatterById(id, viewer);
  if (!matter) throw new TRPCError({ code: "NOT_FOUND", message: "Matter not found." });
  const scope = scopeFor(viewer.role, "matters.edit");
  const allowed =
    scope === "ALL" ||
    (scope === "ASSIGNED" && (matter.assignedTo === viewer.id || matter.createdBy === viewer.id));
  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have permission to edit this matter.",
    });
  }
  return matter;
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
 * SQL WHERE condition restricting tasks to those the viewer may see
 * (AGP spec matrix, tasks.view):
 *   - ALL scope (admin, manager read-only, head_of_practice, coordinator,
 *     legacy partner/staff aliases) → null (no restriction)
 *   - OWN scope (all lawyer grades, paralegal, finance, legacy lawyer) → own
 *     tasks (assignee or creator) PLUS — via the Lead Lawyer overlay — every
 *     task of matters the viewer leads (client_matter_id link)
 *   - NONE (legacy viewer) → matches nothing
 */
export async function taskVisibilityCondition(viewer: TaskViewer) {
  return taskScopeCondition(viewer) ?? null;
}

/** Whether a single task row is visible to the viewer (same rules as the SQL filter). */
export async function isTaskVisibleTo(
  task: { assignedTo: number | null; createdBy: number | null; clientMatterId?: number | null },
  viewer: TaskViewer,
): Promise<boolean> {
  const scope = scopeFor(viewer.role, "tasks.view");
  if (scope === "ALL") return true;
  if (scope === "NONE") return false;
  if (task.assignedTo === viewer.id || task.createdBy === viewer.id) return true;
  // Lead Lawyer overlay: all tasks of matters the viewer leads.
  if (task.clientMatterId != null && leadLawyerOverlayApplies(viewer.role)) {
    const db = getDb();
    const [m] = await db
      .select({ id: clientMatters.id })
      .from(clientMatters)
      .where(and(eq(clientMatters.id, task.clientMatterId), eq(clientMatters.leadLawyerId, viewer.id)))
      .limit(1);
    if (m) return true;
  }
  return false;
}

/** Throw NOT_FOUND if the task is missing OR not visible to the viewer (used by mutations). */
export async function assertTaskVisible(id: number, viewer: TaskViewer) {
  const task = await getTaskById(id, viewer);
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found." });
  return task;
}

/** Lead Lawyer overlay: does the viewer lead this client matter? */
export async function hasLeadLawyerAuthority(viewer: TaskViewer, clientMatterId: number) {
  if (!leadLawyerOverlayApplies(viewer.role)) return false;
  const db = getDb();
  const [m] = await db
    .select({ id: clientMatters.id })
    .from(clientMatters)
    .where(and(eq(clientMatters.id, clientMatterId), eq(clientMatters.leadLawyerId, viewer.id)))
    .limit(1);
  return Boolean(m);
}

/** Whether the viewer is the designated Lead Lawyer on ANY matter (overlay). */
export async function userLeadsAnyMatter(viewer: TaskViewer) {
  if (!leadLawyerOverlayApplies(viewer.role)) return false;
  const db = getDb();
  const [m] = await db
    .select({ id: clientMatters.id })
    .from(clientMatters)
    .where(eq(clientMatters.leadLawyerId, viewer.id))
    .limit(1);
  return Boolean(m);
}

/** Directory of active users for task-assignment pickers (id/name/role only). */
export async function getActiveAssignableUsers() {
  const db = getDb();
  return db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.status, "active"))
    .orderBy(users.name);
}

/** Validate an id references an existing ACTIVE user (task assignee, etc.). */
export async function assertActiveUser(userId: number, label = "user") {
  const db = getDb();
  const [u] = await db
    .select({ id: users.id, status: users.status, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) throw new TRPCError({ code: "BAD_REQUEST", message: `Selected ${label} does not exist.` });
  if (u.status !== "active") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Selected ${label} is not active.` });
  }
  return u;
}

/**
 * Task-assignment authority (BR-10). Assigning a task to ANOTHER user requires
 * tasks.assign (admin, head_of_practice, senior/executive associate,
 * coordinator) OR the Lead Lawyer overlay for the matter the task belongs to.
 * Self-assignment and unassigned tasks are always permitted. The assignee is
 * validated as an existing active user (never trusted raw from the client).
 */
export async function assertTaskAssignmentAllowed(
  viewer: TaskViewer,
  params: { assignedTo: number | null | undefined; clientMatterId?: number | null },
) {
  const target = params.assignedTo;
  if (target == null || target === viewer.id) {
    if (target != null) await assertActiveUser(target, "assignee");
    return;
  }
  await assertActiveUser(target, "assignee");
  if (can(viewer.role, "tasks.assign")) return;
  if (params.clientMatterId != null && (await hasLeadLawyerAuthority(viewer, params.clientMatterId))) {
    return;
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Your role cannot assign tasks to other users.",
  });
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

export async function getNotesByEntity(entityType: string, entityId: number, viewer?: TaskViewer) {
  const db = getDb();
  const conditions = [eq(notes.entityType, entityType), eq(notes.entityId, entityId)];
  // Private notes are visible only to their author (admins excepted).
  if (viewer && viewer.role !== "admin") {
    conditions.push(or(eq(notes.isPrivate, false), eq(notes.createdBy, viewer.id))!);
  }
  return db
    .select()
    .from(notes)
    .where(and(...conditions))
    .orderBy(desc(notes.createdAt));
}

export async function createNote(data: InsertNote) {
  const db = getDb();
  const [note] = await db.insert(notes).values(data).returning();
  return note;
}

export async function getNoteById(id: number) {
  const db = getDb();
  const [note] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  return note ?? null;
}

/** Notes are deletable by their author or an admin only. */
export async function deleteNote(id: number, viewer: TaskViewer) {
  const db = getDb();
  const note = await getNoteById(id);
  if (!note) throw new TRPCError({ code: "NOT_FOUND", message: "Note not found." });
  if (viewer.role !== "admin" && note.createdBy !== viewer.id) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the author or an admin can delete a note.",
    });
  }
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

/**
 * Viewer-scoped audit access: the change history of a record is as sensitive
 * as the record itself. Access requires the corresponding view authority on
 * the underlying entity; unknown entity types are admin-only. Records the
 * viewer cannot see yield an empty result (no existence probe).
 */
export async function getAuditLogsByEntityScoped(
  entityType: string,
  entityId: number,
  viewer: TaskViewer,
) {
  if (viewer.role !== "admin") {
    switch (entityType) {
      case "lead":
        if (!can(viewer.role, "enquiries.view") && !can(viewer.role, "enquiries.manage")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No access to enquiry history." });
        }
        break;
      case "client": {
        const c = await getClientByIdScoped(entityId, viewer);
        if (!c) return [];
        break;
      }
      case "client_matter": {
        const m = await getClientMatterByIdScoped(entityId, viewer);
        if (!m) return [];
        break;
      }
      case "matter": {
        const m = await getMatterById(entityId, viewer);
        if (!m) return [];
        break;
      }
      case "financial_record": {
        if (!mayViewAnyFinancial(viewer)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No access to financial history." });
        }
        const r = await getFinancialRecordByIdScoped(entityId, viewer);
        if (!r) return [];
        break;
      }
      case "matter_lawyer_rate":
        // Rate history is financial information.
        if (scopeFor(viewer.role, "financial.view") === "NONE") {
          throw new TRPCError({ code: "FORBIDDEN", message: "No access to rate history." });
        }
        break;
      case "user":
      default:
        throw new TRPCError({ code: "FORBIDDEN", message: "No access to this audit history." });
    }
  }
  return getAuditLogsByEntity(entityType, entityId);
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

// ─── Authorization contexts & record-level checks ────────────────────────────
// Record-level enforcement for the capability × scope policy
// (shared/permissions.ts + server/authorization.ts). Pattern:
//   • *Scoped accessors apply the viewer's row filter IN the SQL query
//     (list endpoints never over-fetch and filter in the client).
//   • assertCan* helpers re-fetch the authoritative record and verify access
//     before any mutation (anti-IDOR). Records the viewer cannot even VIEW
//     yield NOT_FOUND (no existence leak); visible-but-not-editable yields
//     FORBIDDEN.

/** Practices (city|matterType keys) this user heads, from practice_heads. */
export async function getUserPracticeKeys(userId: number): Promise<Set<string>> {
  const db = getDb();
  const rows = await db
    .select({ city: practiceHeads.city, matterType: practiceHeads.matterType })
    .from(practiceHeads)
    .where(eq(practiceHeads.headOfPracticeId, userId));
  return new Set(rows.map(r => `${r.city}|${r.matterType}`));
}

type EditContext = { scope: Scope; practiceKeys: Set<string> | null };

async function editContextFor(viewer: TaskViewer, capability: "clients.edit" | "matters.edit" | "financial.edit" | "financial.create" | "clients.create" | "matters.create" | "matters.assignTeam"): Promise<EditContext> {
  const scope = scopeFor(viewer.role, capability);
  const practiceKeys = scope === "OWN_PRACTICE" ? await getUserPracticeKeys(viewer.id) : null;
  return { scope, practiceKeys };
}

/** JS-side per-row edit check for an already-fetched client. */
export function canEditClientRow(
  viewer: TaskViewer,
  editCtx: EditContext,
  client: Pick<Client, "clientStatus" | "city" | "matterType">,
): boolean {
  switch (editCtx.scope) {
    case "ALL":
      // Least-privilege spec reading: Paralegal edits Existing Client records
      // only (no general edit rights over Leads or Rejected).
      if (clientEditLimitedToExistingClients(viewer.role)) {
        return client.clientStatus === "Existing Client";
      }
      return true;
    case "OWN_PRACTICE": {
      const key = practiceKey(client.city, client.matterType);
      return key != null && (editCtx.practiceKeys?.has(key) ?? false);
    }
    case "REGISTRY":
      // Coordinator: leads & existing clients. Rejected records remain locked
      // by the global Rejected write-lock (only the approved reactivation
      // workflow passes through it).
      return true;
    default:
      return false;
  }
}

/** Client visible to the viewer? (scoped fetch — NULL when out of scope). */
export async function getClientByIdScoped(id: number, viewer: TaskViewer) {
  const db = getDb();
  const cond = clientScopeCondition(viewer, scopeFor(viewer.role, "clients.view"));
  const where = cond ? and(eq(clients.id, id), cond) : eq(clients.id, id);
  const [client] = await db.select().from(clients).where(where).limit(1);
  if (!client) return null;
  const editCtx = await editContextFor(viewer, "clients.edit");
  return { ...client, viewerCanEdit: canEditClientRow(viewer, editCtx, client) };
}

/** Creating a client: Head of Practice may only create within own practice. */
export async function assertCanCreateClient(
  viewer: TaskViewer,
  data: { city?: string | null; matterType?: string | null },
) {
  const { scope, practiceKeys } = await editContextFor(viewer, "clients.create");
  if (scope === "NONE") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Your role cannot create clients." });
  }
  if (scope === "OWN_PRACTICE") {
    const key = practiceKey(data.city ?? null, data.matterType ?? null);
    if (!key || !practiceKeys!.has(key)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You can only create clients within your own practice (city + matter type).",
      });
    }
  }
}

/**
 * Editing a client: verifies visibility (NOT_FOUND when out of view scope),
 * edit authority on the CURRENT record, and — for OWN_PRACTICE editors — that
 * authorization-defining fields (city, matter type) are not moved outside the
 * practice (records can be neither pulled in nor pushed out).
 */
export async function assertCanEditClient(
  viewer: TaskViewer,
  clientId: number,
  input?: Record<string, unknown>,
) {
  const client = await getClientByIdScoped(clientId, viewer);
  if (!client) throw new TRPCError({ code: "NOT_FOUND", message: "Client not found." });
  const editCtx = await editContextFor(viewer, "clients.edit");
  if (!canEditClientRow(viewer, editCtx, client)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have permission to edit this client.",
    });
  }
  if (input && editCtx.scope === "OWN_PRACTICE") {
    const changed = changedScopeDefiningFields(client, input, CLIENT_SCOPE_DEFINING_FIELDS);
    if (changed.length > 0) {
      const newKey = practiceKey(
        (input.city as string | null | undefined) ?? client.city,
        (input.matterType as string | null | undefined) ?? client.matterType,
      );
      if (!newKey || !editCtx.practiceKeys!.has(newKey)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You cannot move a client outside your own practice (city / matter type).",
        });
      }
    }
  }
  return client;
}

/** Matter visible to the viewer? (scoped fetch — NULL when out of scope). */
export async function getClientMatterByIdScoped(id: number, viewer: TaskViewer) {
  const db = getDb();
  const cond = matterScopeCondition(viewer, scopeFor(viewer.role, "matters.view"));
  const where = cond ? and(eq(clientMatters.id, id), cond) : eq(clientMatters.id, id);
  const [matter] = await db.select().from(clientMatters).where(where).limit(1);
  return matter ?? null;
}

/** JS-side per-row edit check for an already-fetched client matter. */
export function canEditMatterRow(
  viewer: TaskViewer,
  editCtx: EditContext,
  matter: ClientMatter,
  client: Pick<Client, "city" | "matterType"> | null,
): boolean {
  switch (editCtx.scope) {
    case "ALL":
      return true;
    case "ASSIGNED":
      return isMatterAssignedToUser(matter, viewer.id);
    case "OWN_PRACTICE": {
      if (!client) return false;
      const eff = effectiveMatterType(matter.matterType, client.matterType);
      const key = practiceKey(client.city, eff);
      return key != null && (editCtx.practiceKeys?.has(key) ?? false);
    }
    default:
      return false;
  }
}

/** Creating a matter: HoP only within own practice (client city + matter type). */
export async function assertCanCreateClientMatter(
  viewer: TaskViewer,
  data: { clientId: number; matterType?: string | null },
) {
  const { scope, practiceKeys } = await editContextFor(viewer, "matters.create");
  if (scope === "NONE") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Your role cannot create matters." });
  }
  if (scope === "OWN_PRACTICE") {
    const client = await getClientById(data.clientId);
    if (!client) throw new TRPCError({ code: "NOT_FOUND", message: "Client not found." });
    const eff = effectiveMatterType(data.matterType ?? null, client.matterType);
    const key = practiceKey(client.city, eff);
    if (!key || !practiceKeys!.has(key)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You can only create matters within your own practice (city + matter type).",
      });
    }
  }
}

/**
 * Editing a matter: verifies visibility, edit authority on the CURRENT record,
 * and field-level authorization — "edit matter details" NEVER includes the
 * authorization-defining fields (lead lawyer, team FKs, client link, matter
 * type). Changing those requires matters.assignTeam: admin firm-wide, or Head
 * of Practice when both the current AND resulting state stay in own practice.
 */
export async function assertCanEditClientMatter(
  viewer: TaskViewer,
  matterId: number,
  input?: Record<string, unknown>,
) {
  const matter = await getClientMatterByIdScoped(matterId, viewer);
  if (!matter) throw new TRPCError({ code: "NOT_FOUND", message: "Matter not found." });

  const editCtx = await editContextFor(viewer, "matters.edit");
  const client = await getClientById(matter.clientId);
  if (!canEditMatterRow(viewer, editCtx, matter, client)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have permission to edit this matter.",
    });
  }

  if (input) {
    const changed = changedScopeDefiningFields(matter, input, MATTER_SCOPE_DEFINING_FIELDS);
    if (changed.length > 0) {
      const assignCtx = await editContextFor(viewer, "matters.assignTeam");
      if (assignCtx.scope === "NONE") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Changing ${changed.join(", ")} requires team-assignment authority (Admin or the responsible Head of Practice).`,
        });
      }
      if (assignCtx.scope === "OWN_PRACTICE") {
        // Resulting state must also remain within the practice: no moving
        // matters (or their team authority) in or out via client/matter-type.
        const newClientId = (input.clientId as number | undefined) ?? matter.clientId;
        const newClient = newClientId === matter.clientId ? client : await getClientById(newClientId);
        if (!newClient) throw new TRPCError({ code: "NOT_FOUND", message: "Client not found." });
        const newEff = effectiveMatterType(
          (input.matterType as string | null | undefined) ?? matter.matterType,
          newClient.matterType,
        );
        const newKey = practiceKey(newClient.city, newEff);
        if (!newKey || !assignCtx.practiceKeys!.has(newKey)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You cannot move a matter outside your own practice (client / matter type).",
          });
        }
      }
    }
  }
  return matter;
}

/** Financial record visible to the viewer? (scoped fetch; overlay-aware). */
export async function getFinancialRecordByIdScoped(id: number, viewer: TaskViewer) {
  const db = getDb();
  const cond = financialViewCondition(viewer);
  const where = cond ? and(eq(financialRecords.id, id), cond) : eq(financialRecords.id, id);
  const [record] = await db.select().from(financialRecords).where(where).limit(1);
  return record ?? null;
}

/** Is this client/matter pair within one of the viewer's practices? */
async function financialTargetInPractice(
  practiceKeys: Set<string>,
  clientId: number,
  clientMatterId: number | null | undefined,
) {
  const client = await getClientById(clientId);
  if (!client) throw new TRPCError({ code: "NOT_FOUND", message: "Client not found." });
  let eff: string | null = client.matterType;
  if (clientMatterId != null) {
    const matter = await getClientMatterById(clientMatterId);
    if (matter) eff = effectiveMatterType(matter.matterType, client.matterType);
  }
  const key = practiceKey(client.city, eff);
  return key != null && practiceKeys.has(key);
}

/** Creating a financial record (BR-06): admin/finance firm-wide, HoP own practice. */
export async function assertCanCreateFinancialRecord(
  viewer: TaskViewer,
  data: { clientId: number; clientMatterId?: number | null },
) {
  const { scope, practiceKeys } = await editContextFor(viewer, "financial.create");
  if (scope === "NONE") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Your role cannot create financial records.",
    });
  }
  if (scope === "OWN_PRACTICE") {
    // Fail closed before any record lookup: a Head of Practice with no
    // configured practice can create nothing (and learns nothing).
    if (practiceKeys!.size === 0) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No practice is configured for your account.",
      });
    }
    if (!(await financialTargetInPractice(practiceKeys!, data.clientId, data.clientMatterId))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You can only create financial records within your own practice.",
      });
    }
  }
}

/**
 * Editing/deleting a financial record. Verifies read visibility first
 * (NOT_FOUND when invisible), then mutation authority. For OWN_PRACTICE
 * editors both the current record AND any re-linked client/matter target must
 * stay within the practice.
 */
export async function assertCanMutateFinancialRecord(
  viewer: TaskViewer,
  recordId: number,
  action: "edit" | "delete",
  input?: Record<string, unknown>,
) {
  const capability = action === "delete" ? "financial.delete" : "financial.edit";
  const scope = scopeFor(viewer.role, capability);
  if (scope === "NONE") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        action === "delete"
          ? "Your role cannot delete financial records."
          : "Your role cannot edit financial records.",
    });
  }
  // Fail closed before any record lookup: OWN_PRACTICE with no configured
  // practice can mutate nothing (and must not probe record existence).
  const ownPracticeKeys = scope === "OWN_PRACTICE" ? await getUserPracticeKeys(viewer.id) : null;
  if (ownPracticeKeys && ownPracticeKeys.size === 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No practice is configured for your account.",
    });
  }

  const record = await getFinancialRecordByIdScoped(recordId, viewer);
  if (!record) throw new TRPCError({ code: "NOT_FOUND", message: "Financial record not found." });

  if (ownPracticeKeys) {
    const practiceKeys = ownPracticeKeys;
    if (!(await financialTargetInPractice(practiceKeys, record.clientId, record.clientMatterId))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You can only modify financial records within your own practice.",
      });
    }
    if (input) {
      const changed = changedScopeDefiningFields(record, input, ["clientId", "clientMatterId"]);
      if (changed.length > 0) {
        const newClientId = (input.clientId as number | undefined) ?? record.clientId;
        const newMatterId =
          input.clientMatterId === undefined
            ? record.clientMatterId
            : (input.clientMatterId as number | null);
        if (!(await financialTargetInPractice(practiceKeys, newClientId, newMatterId))) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You cannot re-link a financial record outside your own practice.",
          });
        }
      }
    }
  }
  return record;
}

/**
 * Logging/updating a client action: allowed for users who may edit the client
 * OR who are on the team of one of the client's matters (operational logging
 * by assigned lawyers). Read-only roles (e.g. Manager) are rejected.
 */
export async function assertCanLogClientAction(viewer: TaskViewer, clientId: number) {
  const client = await getClientByIdScoped(clientId, viewer);
  if (!client) throw new TRPCError({ code: "NOT_FOUND", message: "Client not found." });
  const editCtx = await editContextFor(viewer, "clients.edit");
  if (canEditClientRow(viewer, editCtx, client)) return client;
  if (scopeFor(viewer.role, "matters.edit") !== "NONE") {
    const db = getDb();
    const [m] = await db
      .select({ id: clientMatters.id })
      .from(clientMatters)
      .where(and(eq(clientMatters.clientId, clientId), matterTeamCondition(viewer.id)))
      .limit(1);
    if (m) return client;
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "You do not have permission to log actions for this client.",
  });
}

// ─── Practice Heads (BR-01 ownership map) ─────────────────────────────────────

export async function getPracticeHeads() {
  const db = getDb();
  return db
    .select({
      id: practiceHeads.id,
      city: practiceHeads.city,
      matterType: practiceHeads.matterType,
      headOfPracticeId: practiceHeads.headOfPracticeId,
      headOfPracticeName: users.name,
      headOfPracticeEmail: users.email,
      updatedAt: practiceHeads.updatedAt,
    })
    .from(practiceHeads)
    .leftJoin(users, eq(users.id, practiceHeads.headOfPracticeId))
    .orderBy(practiceHeads.city, practiceHeads.matterType);
}

/** Upsert the responsible Head of Practice for a (city, matter type) practice. */
export async function setPracticeHead(
  data: { city: string; matterType: string; headOfPracticeId: number },
  actorId: number,
) {
  const db = getDb();
  const [u] = await db
    .select({ id: users.id, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, data.headOfPracticeId))
    .limit(1);
  if (!u) throw new TRPCError({ code: "BAD_REQUEST", message: "Selected user does not exist." });
  if (u.status !== "active") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Selected user is not active." });
  }
  // The responsible head must actually hold the Head of Practice role
  // (legacy 'partner' behaves as head_of_practice until remapped).
  if (u.role !== "head_of_practice" && u.role !== "partner" && u.role !== "admin") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The responsible head must have the Head of Practice role.",
    });
  }
  const [row] = await db
    .insert(practiceHeads)
    .values({
      city: data.city as PracticeHeadCity,
      matterType: data.matterType as PracticeHeadMatterType,
      headOfPracticeId: data.headOfPracticeId,
      createdBy: actorId,
    })
    .onConflictDoUpdate({
      target: [practiceHeads.city, practiceHeads.matterType],
      set: { headOfPracticeId: data.headOfPracticeId, updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function removePracticeHead(id: number) {
  const db = getDb();
  await db.delete(practiceHeads).where(eq(practiceHeads.id, id));
}

type PracticeHeadCity = (typeof practiceHeads.$inferInsert)["city"];
type PracticeHeadMatterType = (typeof practiceHeads.$inferInsert)["matterType"];

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
}, viewer?: TaskViewer) {
  const db = getDb();
  const conditions = [];

  // Row-level scope (clients.view): filtered in the SQL query, never in React.
  if (viewer) {
    const scopeCond = clientScopeCondition(viewer, scopeFor(viewer.role, "clients.view"));
    if (scopeCond) conditions.push(scopeCond);
  }

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

  const rows = conditions.length > 0 ? await base.where(and(...conditions)) : await base;

  // Server-computed per-row edit flag so the UI can show edit affordances only
  // where a mutation would succeed (e.g. HoP sees all rows but edits only
  // own-practice ones) without duplicating the policy client-side.
  if (!viewer) return rows;
  const editCtx = await editContextFor(viewer, "clients.edit");
  return rows.map(r => ({ ...r, viewerCanEdit: canEditClientRow(viewer, editCtx, r) }));
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
export async function getRecentLeads(days = 30, limit = 5, viewer?: TaskViewer) {
  const db = getDb();
  const conditions = [
    eq(clients.clientStatus, "Leads"),
    gte(clients.createdAt, sql`NOW() - make_interval(days => ${days})`),
  ];
  if (viewer) {
    const scopeCond = clientScopeCondition(viewer, scopeFor(viewer.role, "clients.view"));
    if (scopeCond) conditions.push(scopeCond);
  }
  return db
    .select()
    .from(clients)
    .where(and(...conditions))
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

export async function getClientStatusCounts(viewer?: TaskViewer) {
  const db = getDb();
  // Counts are computed over the viewer's client scope so aggregates never
  // reveal rows the viewer could not list.
  const scopeCond = viewer
    ? clientScopeCondition(viewer, scopeFor(viewer.role, "clients.view"))
    : undefined;
  const rows = await db
    .select({ status: clients.clientStatus, count: count() })
    .from(clients)
    .where(scopeCond)
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

export type ConversionRange = "month" | "quarter" | "year" | "all";

export type ConversionMarkerRow = {
  clientStatus?: string | null;
  leadCurrentStatus?: string | null;
  leadConversionDate?: string | Date | null;
  leadDetailStatus?: string | null;
  hadLeadToExistingStatusChange?: boolean | null;
};

export const CONVERSION_SOURCE_TABLE = "clients";
export const CONVERSION_COHORT_DATE = "COALESCE(leads.created_at, clients.created_at)";
export const CONVERSION_FORMULA = "Converted Leads / Total Valid Leads * 100";
export const CONVERSION_MARKERS = [
  "clients.client_status = Existing Client",
  "leads.current_status = Converted",
  "leads.conversion_date IS NOT NULL",
  "client_lead_details.lead_status IN (Converted, Existing Client, Won)",
  "audit_logs clientStatus Leads -> Existing Client",
] as const;

const VALID_CANONICAL_LEAD_STATUSES = new Set(["Leads", "Rejected", "Existing Client"]);
const CONVERTED_STATUS_MARKERS = new Set(["Converted", "Existing Client", "Won"]);

export function isValidCanonicalLeadStatus(status: string | null | undefined) {
  return typeof status === "string" && VALID_CANONICAL_LEAD_STATUSES.has(status);
}

export function hasConversionMarker(row: ConversionMarkerRow) {
  return (
    row.clientStatus === "Existing Client" ||
    row.leadCurrentStatus === "Converted" ||
    row.leadConversionDate != null ||
    (typeof row.leadDetailStatus === "string" && CONVERTED_STATUS_MARKERS.has(row.leadDetailStatus)) ||
    row.hadLeadToExistingStatusChange === true
  );
}

export function calculateConversionRate(convertedLeads: number, totalLeads: number) {
  if (!Number.isFinite(totalLeads) || totalLeads <= 0) return 0;
  if (!Number.isFinite(convertedLeads) || convertedLeads <= 0) return 0;
  return Math.round((convertedLeads / totalLeads) * 1000) / 10;
}

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
  if (range === "year") {
    return new Date(now.getFullYear(), 0, 1);
  }
  return null; // all time
}

/**
 * Conversion Rate KPI: the single source of truth for the dashboard card, KPI
 * dashboard, reports, and AI analytics. It reads the canonical Leads Pipeline
 * (`clients`) and joins legacy `leads` only for original lead dates and
 * conversion markers.
 *
 * Formula: Converted Leads / Total Valid Leads * 100.
 *
 * Total valid leads are client rows in a lead lifecycle status: Leads,
 * Rejected, or Existing Client. `converted_from` is retained as a source
 * breakdown, but it is not trusted as an exclusion flag because historical
 * pipeline rows can be misclassified as Direct.
 *
 * Converted leads have any safe marker: Existing Client status, legacy
 * Converted status, legacy conversion date, lead-detail converted/won status,
 * or an audit trail showing Leads -> Existing Client.
 *
 * Cohort filtering uses the original lead creation date: leads.created_at for
 * mirrored enquiries, otherwise clients.created_at.
 */
export async function getClientConversionMetrics(
  // Accepts the full ConversionRange (incl. "year"); conversionRangeStart handles
  // every case. The dashboard router still restricts external input to
  // month/quarter/all via its own zod enum; the AI Assistant uses "year" too.
  range: ConversionRange = "all",
  now: Date = new Date(),
) {
  // Canonical calculation: count distinct clients in lead lifecycle statuses.
  // converted_from is reported as a source breakdown but is not trusted as an
  // exclusion flag because historical pipeline rows may be misclassified Direct.
  const db = getDb();
  const start = conversionRangeStart(range, now);
  const cohortDate = sql`COALESCE(${leads.createdAt}, ${clients.createdAt})`;
  // Bind the lower bound as an ISO string + explicit cast. Passing a raw JS Date
  // into a sql`` template trips the postgres-js driver (ERR_INVALID_ARG_TYPE) when
  // the fragment is reused across several aggregates; a typed string param is safe.
  const inRange = start ? sql`${cohortDate} >= ${start.toISOString()}::timestamptz` : sql`TRUE`;
  const validLead = sql`${clients.clientStatus} IN ('Leads', 'Rejected', 'Existing Client')`;
  const convertedLead = sql`(
    ${clients.clientStatus} = 'Existing Client'
    OR ${leads.currentStatus} = 'Converted'
    OR ${leads.conversionDate} IS NOT NULL
    OR ${clientLeadDetails.leadStatus} IN ('Converted', 'Existing Client', 'Won')
    OR EXISTS (
      SELECT 1
      FROM audit_logs al
      WHERE al.entity_type = 'client'
        AND al.entity_id = ${clients.id}
        AND al.action = 'status_changed'
        AND al.field_name = 'clientStatus'
        AND al.old_value = 'Leads'
        AND al.new_value = 'Existing Client'
    )
  )`;

  const [metricsRow] = await db
    .select({
      totalLeads: sql<string>`COUNT(DISTINCT ${clients.id}) FILTER (WHERE ${validLead} AND ${inRange})`,
      convertedLeads: sql<string>`COUNT(DISTINCT ${clients.id}) FILTER (WHERE ${validLead} AND ${convertedLead} AND ${inRange})`,
      leadOrigin: sql<string>`COUNT(DISTINCT ${clients.id}) FILTER (WHERE ${validLead} AND ${clients.convertedFrom} = 'Lead' AND ${inRange})`,
      enquiryOrigin: sql<string>`COUNT(DISTINCT ${clients.id}) FILTER (WHERE ${validLead} AND ${clients.convertedFrom} = 'Enquiry' AND ${inRange})`,
      directOrigin: sql<string>`COUNT(DISTINCT ${clients.id}) FILTER (WHERE ${validLead} AND ${clients.convertedFrom} = 'Direct' AND ${inRange})`,
    })
    .from(clients)
    .leftJoin(leads, eq(leads.id, clients.sourceLeadId))
    .leftJoin(clientLeadDetails, eq(clientLeadDetails.clientId, clients.id));

  const totalLeads = Number(metricsRow?.totalLeads ?? 0);
  const convertedLeads = Number(metricsRow?.convertedLeads ?? 0);
  const conversionRate = calculateConversionRate(convertedLeads, totalLeads);
  const sourceBreakdown = {
    lead: Number(metricsRow?.leadOrigin ?? 0),
    enquiry: Number(metricsRow?.enquiryOrigin ?? 0),
    direct: Number(metricsRow?.directOrigin ?? 0),
  };

  return {
    range,
    period: range,
    totalLeads,
    convertedLeads,
    convertedClients: convertedLeads,
    converted: convertedLeads,
    totalIntake: totalLeads,
    total: totalLeads,
    totalEnquiries: sourceBreakdown.enquiry,
    sourceBreakdown,
    conversionRate,
    debug: {
      sourceTable: CONVERSION_SOURCE_TABLE,
      joinedTables: ["leads", "client_lead_details", "audit_logs"],
      periodUsed: range,
      cohortDateField: CONVERSION_COHORT_DATE,
      totalLeads,
      convertedLeads,
      conversionRate,
      formula: CONVERSION_FORMULA,
      conversionMarkers: CONVERSION_MARKERS,
    },
  };
}

// ─── Client Matters ───────────────────────────────────────────────────────────

export async function getClientMatters(clientId: number, viewer?: TaskViewer) {
  const db = getDb();
  const conditions = [eq(clientMatters.clientId, clientId)];
  if (viewer) {
    const scopeCond = matterScopeCondition(viewer, scopeFor(viewer.role, "matters.view"));
    if (scopeCond) conditions.push(scopeCond);
  }
  const rows = await db
    .select()
    .from(clientMatters)
    .where(and(...conditions))
    .orderBy(desc(clientMatters.createdAt));
  if (!viewer) return rows;
  const editCtx = await editContextFor(viewer, "matters.edit");
  const client = editCtx.scope === "OWN_PRACTICE" ? await getClientById(clientId) : null;
  return rows.map(m => ({
    ...m,
    viewerCanEdit: canEditMatterRow(viewer, editCtx, m, client),
    viewerIsLeadLawyer: isLeadLawyerOfMatter(m, viewer),
  }));
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
export async function getAllClientMatters(filters: { status?: string } = {}, viewer?: TaskViewer) {
  const db = getDb();
  const status = filters.status?.trim();
  const conditions = [];
  if (status) conditions.push(matterStatusEquals(status));
  if (viewer) {
    const scopeCond = matterScopeCondition(viewer, scopeFor(viewer.role, "matters.view"));
    if (scopeCond) conditions.push(scopeCond);
  }
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
    .where(conditions.length > 0 ? and(...conditions) : undefined)
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

  // Matter Type is authoritative at the matter level (CRM-006): require it,
  // and new matters accept only the supported values (shared/const.ts). The
  // router enforces this via z.enum too; this is defense in depth for internal
  // callers.
  if (!clean.matterType || String(clean.matterType).trim() === "") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Matter Type is required when creating a matter." });
  }
  if (!isSupportedMatterType(String(clean.matterType).trim())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Matter Type must be one of: ${MATTER_TYPES.join(", ")}.`,
    });
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

  // Lawyer assignments as real users (Lead Partner, Support Lead, Attorney
  // Head, Attorney 1–4). Each is validated as active + role-eligible and its
  // name mirrored into the legacy display column. Legacy free-text values
  // remain supported for records without a linked user.
  await applyMatterAssignments(data, clean as Record<string, unknown>);
  assertDistinctAttorneys(clean as Record<string, unknown>);

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

  // Matter Type: change-only validation. A legacy free-text value already on
  // the row may be re-submitted unchanged (so editing other fields on an old
  // matter never blocks or silently rewrites history), but any NEW value must
  // be one of the supported types (shared/const.ts).
  if (clean.matterType !== undefined) {
    const submitted = String(clean.matterType).trim();
    const current = (existing?.matterType ?? "").trim();
    if (submitted !== current && !isSupportedMatterType(submitted)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Matter Type must be one of: ${MATTER_TYPES.join(", ")}.`,
      });
    }
  }

  // Lawyer-assignment user links (Lead Partner, Support Lead, Attorney Head,
  // Attorney 1–4). Change-only validation: unchanged ids are preserved even if
  // the user has since become inactive; new ids must be active + role-eligible;
  // null unlinks and clears the mirrored display name.
  await applyMatterAssignments(data, clean as Record<string, unknown>, existing);
  assertDistinctAttorneys(clean as Record<string, unknown>, existing as Record<string, unknown> | null);

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

// ─── Lawyer assignment (central eligibility service) ──────────────────────────

/**
 * Users eligible for a NEW assignment to the given lawyer field: active users
 * whose role is in the field's eligible set (shared/assignmentEligibility.ts).
 * Filtering is enforced here, not in the frontend. Never exposes password
 * hashes or other sensitive columns.
 */
export async function getEligibleLawyers(field: AssignmentField) {
  const db = getDb();
  const { roles } = ASSIGNMENT_FIELDS[field];
  return db
    .select({
      id: users.id,
      fullName: users.name,
      email: users.email,
      role: users.role,
      status: users.status,
    })
    .from(users)
    .where(and(eq(users.status, "active"), inArray(users.role, [...roles] as any)))
    .orderBy(users.name);
}

/**
 * Fetch + validate a user being NEWLY assigned to a lawyer field. Throws a
 * clear BAD_REQUEST naming the field when the user does not exist, is not
 * active, or lacks an eligible role.
 */
async function resolveEligibleAssignee(field: AssignmentField, userId: number) {
  const { label, roles } = ASSIGNMENT_FIELDS[field];
  const db = getDb();
  const [u] = await db
    .select({ id: users.id, name: users.name, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Selected ${label} does not exist.` });
  }
  if (u.status !== "active") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Selected ${label} is inactive and cannot receive new assignments.` });
  }
  if (!(roles as readonly string[]).includes(u.role)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Selected ${label} does not have an eligible role (${u.role}).` });
  }
  return u;
}

// Attorney 1–4 slots: a user may appear only once across them. The frontend
// hides already-picked users; this is the server-side backstop so a crafted
// request cannot assign the same user to two attorney slots.
const ATTORNEY_SLOT_KEYS = ["attorney1Id", "attorney2Id", "attorney3Id", "attorney4Id"] as const;

function assertDistinctAttorneys(
  clean: Record<string, unknown>,
  existing?: Record<string, unknown> | null,
) {
  const seen = new Map<number, string>();
  for (const key of ATTORNEY_SLOT_KEYS) {
    // Effective post-write value: the submitted one, else the row's current one.
    const effective = clean[key] !== undefined ? clean[key] : existing?.[key];
    if (typeof effective !== "number") continue;
    const prior = seen.get(effective);
    if (prior) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "The same user cannot be assigned to more than one Attorney 1–4 slot.",
      });
    }
    seen.set(effective, key);
  }
}

// Matter lawyer-assignment columns: user FK key → eligibility field + legacy
// free-text display column the linked user's name is mirrored into.
const MATTER_ASSIGNMENT_COLUMNS = [
  { idKey: "leadLawyerId",  field: "leadPartner",  nameKey: "leadPartnerFullName" },
  { idKey: "supportLeadId", field: "supportLead",  nameKey: "supportLead" },
  { idKey: "attorneyHeadId", field: "attorneyHead", nameKey: "attorneyHead" },
  { idKey: "attorney1Id",   field: "attorney1",    nameKey: "attorney1" },
  { idKey: "attorney2Id",   field: "attorney2",    nameKey: "attorney2" },
  { idKey: "attorney3Id",   field: "attorney3",    nameKey: "attorney3" },
  { idKey: "attorney4Id",   field: "attorney4",    nameKey: "attorney4" },
] as const;

/**
 * Apply submitted lawyer-assignment user ids onto a sanitized matter payload.
 * For each FK field present in the raw input:
 *   • number → validated (must exist, be active, have an eligible role) and the
 *     user's name is mirrored into the legacy display column — EXCEPT when the
 *     value equals the row's existing assignment, which is preserved untouched
 *     so historical assignments to now-inactive users survive unrelated edits;
 *   • null → unlinks, and clears the mirrored display name when the row had a
 *     linked user (pure legacy free-text without a link is left alone).
 * Handled off the raw input because the sanitizer drops nulls.
 */
async function applyMatterAssignments(
  data: Record<string, unknown>,
  clean: Record<string, unknown>,
  existing?: Record<string, unknown> | null,
) {
  for (const { idKey, field, nameKey } of MATTER_ASSIGNMENT_COLUMNS) {
    const raw = data[idKey];
    if (raw === undefined) continue;
    if (raw === null) {
      clean[idKey] = null;
      if (existing && existing[idKey] != null) clean[nameKey] = null;
      continue;
    }
    const userId = Number(raw);
    if (!Number.isFinite(userId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid user for ${ASSIGNMENT_FIELDS[field].label}.` });
    }
    if (existing && existing[idKey] === userId) {
      // Unchanged: keep the historical assignment (user may now be inactive).
      clean[idKey] = userId;
      continue;
    }
    const u = await resolveEligibleAssignee(field, userId);
    clean[idKey] = u.id;
    if (u.name) clean[nameKey] = u.name;
  }
}

// ─── Matter Lawyer Rates ──────────────────────────────────────────────────────

// Roles that may be NEWLY assigned as a matter's lead/co-lawyer: the central
// legal-team tier (all lawyer grades incl. trainee; legacy partner/lawyer kept
// for un-migrated accounts). admin/manager were removed from new assignments —
// they are not lawyer positions; historical assignments survive via
// change-only validation.
export const ASSIGNABLE_LAWYER_ROLES = LEGAL_TEAM_ASSIGNMENT_ROLES;

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

/** Single rate row (for authorization checks before mutating). */
export async function getMatterLawyerRateById(id: number) {
  const db = getDb();
  const [rate] = await db
    .select()
    .from(matterLawyerRates)
    .where(eq(matterLawyerRates.id, id))
    .limit(1);
  return rate ?? null;
}

/**
 * Hourly rates are financial mutations: admin/finance firm-wide; Head of
 * Practice only for matters within own practice (resolved via the matter's
 * client city + effective matter type).
 */
export async function assertCanMutateMatterRates(
  viewer: TaskViewer,
  clientMatterId: number,
  action: "create" | "edit",
) {
  const capability = action === "create" ? "financial.create" : "financial.edit";
  const scope = scopeFor(viewer.role, capability);
  if (scope === "NONE") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Your role cannot modify hourly rates." });
  }
  if (scope === "OWN_PRACTICE") {
    const matter = await getClientMatterById(clientMatterId);
    if (!matter) throw new TRPCError({ code: "NOT_FOUND", message: "Matter not found." });
    const practiceKeys = await getUserPracticeKeys(viewer.id);
    if (!(await financialTargetInPractice(practiceKeys, matter.clientId, clientMatterId))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You can only modify rates for matters within your own practice.",
      });
    }
  }
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
  // Lead Lawyer designation uses the leadership eligibility tier (Trainee is
  // NOT eligible — documented spec conflict, least privilege applied).
  const lawyer = await resolveEligibleAssignee("leadPartner", newUserId);
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
}, viewer?: TaskViewer) {
  const db          = getDb();
  const overdueDays = await getOverdueDays();
  const conditions  = [];
  // Row-level scope (financial.view + Lead Lawyer overlay), applied in SQL.
  if (viewer) {
    const scopeCond = financialViewCondition(viewer);
    if (scopeCond) conditions.push(scopeCond);
  }
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
  assertNonNegativeFinancialAmounts(data as Record<string, unknown>);
  // Responsible Lawyer as a real user: validate active + role-eligible and
  // mirror the name into the legacy display column.
  if ((data as any).responsibleLawyerId != null) {
    const lawyer = await resolveEligibleAssignee("responsibleLawyer", Number((data as any).responsibleLawyerId));
    (data as any).responsibleLawyerId = lawyer.id;
    if (lawyer.name) (data as any).responsibleLawyer = lawyer.name;
  }
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

  // Finance amounts (agreedFees, revenue, collectedAmount) must never be negative.
  assertNonNegativeFinancialAmounts(editableData as Record<string, unknown>);

  // CRM-010: if the matter link is being set/changed (and not cleared), it must
  // belong to this record's client. clientId is immutable on update.
  if (editableData.clientMatterId != null) {
    await assertMatterBelongsToClient(editableData.clientMatterId, existing.clientId);
  }

  // Responsible Lawyer user link. Change-only validation: an unchanged id is
  // preserved even if the user has since become inactive; a new id must be
  // active + role-eligible; null unlinks and clears the mirrored display name.
  if ((editableData as any).responsibleLawyerId !== undefined) {
    const submitted = (editableData as any).responsibleLawyerId as number | null;
    if (submitted === null) {
      if (existing.responsibleLawyerId != null) (editableData as any).responsibleLawyer = null;
    } else if (submitted !== existing.responsibleLawyerId) {
      const lawyer = await resolveEligibleAssignee("responsibleLawyer", Number(submitted));
      (editableData as any).responsibleLawyerId = lawyer.id;
      if (lawyer.name) (editableData as any).responsibleLawyer = lawyer.name;
    }
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

export async function getFinancialSummary(viewer?: TaskViewer) {
  const db          = getDb();
  const overdueDays = await getOverdueDays();
  // Aggregates are computed over the viewer's financial scope so totals never
  // include rows the viewer could not list (BR-04/BR-05).
  const scopeCond = viewer ? financialViewCondition(viewer) : undefined;
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
    .from(financialRecords)
    .where(scopeCond);
  return {
    totalRevenue:    Number(row?.totalRevenue    ?? 0),
    totalOutstanding:Number(row?.totalOutstanding?? 0),
    overdueCount:    Number(row?.overdueCount    ?? 0),
    totalToBeBilled: Number(row?.totalToBeBilled ?? 0),
    overdueDays,   // expose so callers can show "X days" in the UI
  };
}

// ─── To Be Billed Breakdown ───────────────────────────────────────────────────

export async function getToBeBilledBreakdown(viewer?: TaskViewer) {
  const db = getDb();

  // Scope every aggregate row to the viewer's financial visibility.
  const scopeCond = viewer ? financialViewCondition(viewer) : undefined;

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
    .where(scopeCond)
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
    .where(scopeCond)
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

export async function getClientActionLogs(clientId?: number, viewer?: TaskViewer) {
  const db = getDb();
  const conditions = [];
  if (clientId) conditions.push(eq(clientActionLogs.clientId, clientId));
  // Action logs follow client visibility: viewers with ASSIGNED client scope
  // only see actions for clients of their matters.
  if (viewer) {
    const clientScope = scopeFor(viewer.role, "clients.view");
    if (clientScope === "NONE") return [];
    if (clientScope === "ASSIGNED") {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM clients c_al
        WHERE c_al.id = ${clientActionLogs.clientId}
          AND EXISTS (
            SELECT 1 FROM client_matters cm_al
            WHERE cm_al.client_id = c_al.id
              AND (cm_al.lead_lawyer_id = ${viewer.id} OR cm_al.support_lead_id = ${viewer.id}
                OR cm_al.attorney_head_id = ${viewer.id} OR cm_al.attorney_1_id = ${viewer.id}
                OR cm_al.attorney_2_id = ${viewer.id} OR cm_al.attorney_3_id = ${viewer.id}
                OR cm_al.attorney_4_id = ${viewer.id})
          )
      )`);
    }
  }
  return db
    .select()
    .from(clientActionLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(clientActionLogs.createdAt));
}

export async function getClientActionLogById(id: number) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(clientActionLogs)
    .where(eq(clientActionLogs.id, id))
    .limit(1);
  return row ?? null;
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

export async function getClientDashboardStats(viewer?: TaskViewer) {
  const [clientCounts, financialSummary, actionsThisWeek] = await Promise.all([
    getClientStatusCounts(viewer),
    getFinancialSummary(viewer),
    getActionsThisWeek(),
  ]);
  // Financial aggregates are omitted entirely for roles without financial
  // visibility (the scoped summary would be all-zeros; omit to avoid implying
  // real values of 0).
  const financialAllowed = !viewer || mayViewAnyFinancial(viewer);
  return {
    ...clientCounts,
    ...(financialAllowed ? financialSummary : {}),
    actionsThisWeek,
  };
}


// ─── AI Assistant audit trail ─────────────────────────────────────────────────

/**
 * Record one AI Assistant question for accountability. The full AI answer is
 * intentionally NOT persisted — only the question + metadata (period, the data
 * scope used, and the model). Never pass the API key or raw CRM payloads here.
 */
export async function createAiAuditLog(entry: {
  userId: number | null;
  question: string;
  period: string;
  dataScopeUsed: string;
  model: string;
}) {
  const db = getDb();
  const [row] = await db
    .insert(aiAuditLogs)
    .values({
      userId: entry.userId,
      question: entry.question.slice(0, 4000),
      period: entry.period,
      dataScopeUsed: entry.dataScopeUsed,
      model: entry.model,
    })
    .returning();
  return row;
}

/** Recent AI Assistant audit rows, newest first (admin-only at the router). */
export async function getAiAuditLogs(limit = 100) {
  const db = getDb();
  return db
    .select()
    .from(aiAuditLogs)
    .orderBy(desc(aiAuditLogs.createdAt))
    .limit(limit);
}
