import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure, adminProcedure, permissionProcedure, capabilityProcedure } from "./_core/trpc";
import { AUTH_COOKIE, createSessionToken, verifyPassword, hashPassword, isSecureRequest } from "./_core/auth";
import { TRPCError } from "@trpc/server";
import type { Request } from "express";
import { z } from "zod";
import * as db from "./db";
import { testNvidiaConnection, callNvidiaChat, NVIDIA_UNAVAILABLE_MESSAGE } from "./_core/nvidia";
import {
  gatherCrmData, buildAiMessages, checkAiRateLimit, AI_MODEL_NAME,
} from "./aiAnalytics";
import { USER_ROLES, USER_STATUSES, MATTER_TYPES, hasPermission, NOT_ADMIN_ERR_MSG, type UserRole, type UserStatus } from "../shared/const";
import { ASSIGNMENT_FIELD_NAMES, type AssignmentField } from "../shared/assignmentEligibility";
import * as financialReports from "./financialReports";
import { reportFilterSchema, EXPORT_REPORT_TYPES } from "./financialReports";
import { assertOwnPracticeWrite, getClientPracticeClassification, financialRecordPracticeKey } from "./practices";
import { authorize, ACCOUNT_ROLE_VALUES } from "@shared/policy";

/**
 * Coordinator payment-status projection (§B/§G).
 *
 * This is deliberately an allowlist: adding a column to financial_records cannot
 * accidentally disclose it to a Coordinator. The compatibility cast preserves
 * the existing tRPC client shape until the frontend-alignment PR consumes the
 * restricted DTO; it does not add the omitted properties at runtime.
 */
function toPaymentStatusDTO<T extends Record<string, any>>(r: T): T {
  return {
    id: r.id,
    clientId: r.clientId,
    clientMatterId: r.clientMatterId,
    collectionStatus: r.collectionStatus,
    billingDate: r.billingDate,
    paymentDate: r.paymentDate,
    invoiceNumber: r.invoiceNumber,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  } as unknown as T;
}

// Money input validation (Finance / Invoicing). A monetary string must be a
// finite, NON-NEGATIVE number. Negative fees, revenue, or collected amounts are
// never valid — a refund/adjustment is modelled by lowering the amount, not by a
// negative value. An empty string means "leave unset" and is allowed. A failing
// refine surfaces to the client as a tRPC BAD_REQUEST (HTTP 400).
const nonNegativeMoney = z.string().refine(
  v => v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0),
  { message: "Amount must be a valid non-negative number (e.g. 10000)." },
);

function formatDbError(err: any) {
  const messages = [err?.message, err?.cause?.message]
    .filter((message): message is string => Boolean(message));
  const code = err?.code ?? err?.cause?.code;
  if (code) messages.push(`code: ${code}`);
  return messages.join(" | ") || String(err);
}

// Phase 10: User Management may now assign the approved TARGET account roles, so
// the write schema accepts every persistable account role (legacy + target). The
// UI offers only the 11 approved roles for NEW assignment; legacy values remain
// accepted so existing legacy accounts can be re-saved unchanged (coexistence).
// This is per-user re-grading via the admin UI, NOT the bulk account migration.
const roleSchema = z.enum(ACCOUNT_ROLE_VALUES);

// Phase 10 (temporary): target Finance activation is unavailable until an additive
// legacy/target policy-era discriminator exists. `authorize()` resolves the
// `finance` string to LEGACY finance, so User Management must NOT create a Finance
// account or transition another role INTO Finance — doing so would represent it as
// the approved target Finance role without the enforcement that implies. An
// EXISTING Finance account may remain Finance (unchanged) and stays fully editable.
// Remove this guard once policy convergence lands.
const FINANCE_TRANSITION_BLOCKED_MSG =
  "Assigning the Finance role is unavailable pending policy convergence: target " +
  "Finance activation requires the legacy/target policy-era discriminator, which " +
  "is not implemented yet. Existing Finance accounts are unaffected.";

/** Reject creating a Finance account or transitioning a non-Finance role into Finance. */
function assertFinanceAssignmentAllowed(proposedRole: string, currentRole?: string | null) {
  if (proposedRole === "finance" && currentRole !== "finance") {
    throw new TRPCError({ code: "CONFLICT", message: FINANCE_TRANSITION_BLOCKED_MSG });
  }
}
const statusSchema = z.enum(USER_STATUSES);

// Lead Lawyer overlay — the ONLY client_matters fields a designated Lead Lawyer
// may edit via the overlay (§G). Derived from the exclusion rule: no assignment
// (lead/support/attorney*), practice (matterType), financial (billingType), or
// identifier (matterReference/originalSerial) fields — those need base authority.
const LEAD_LAWYER_EDITABLE_FIELDS: readonly string[] = [
  "matterDescription", "matterStatus", "balanceWorkLeft",
  "achievementPercentage", "achievementStatus", "priority", "opposingParty",
];

// ─── Task authorization helpers (Phase 8) ─────────────────────────────────────

type TaskActor = { id: number; role: string; status: string };

/**
 * Does the actor hold `capability` for THIS task — via base role, or the Lead
 * Lawyer overlay of the task's matter (which grants tasks:view/edit/assign for the
 * led matter)? Called only AFTER visibility is confirmed, so a base grant is
 * already scope-bounded by the rows the actor can see.
 */
async function taskCapabilityForMatter(
  actor: TaskActor,
  capability: "tasks:edit" | "tasks:assign",
  clientMatterId: number | null,
): Promise<boolean> {
  if (authorize({ id: actor.id, role: actor.role, status: actor.status }, capability).allowed) return true;
  if (clientMatterId != null) return db.isLeadLawyerOfMatter(actor.id, clientMatterId);
  return false;
}

/**
 * Validate + authorize assigning `assigneeId` to a task on (clientId, clientMatterId).
 * The caller must already have confirmed the actor holds tasks:assign for the task.
 * The assignee must already be able to access the task's client/matter,
 * independently of the assigner's scope. Assignment never creates target access.
 */
async function enforceTaskAssignment(
  assigneeId: number,
  clientId: number | null,
  clientMatterId: number | null,
): Promise<void> {
  const assignee = await db.resolveTaskAssignee(assigneeId); // exists / active / eligible or throws
  if (!(await db.assigneeCanAccessTaskTarget(assignee, clientId, clientMatterId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Cannot assign this task to a user who cannot access its client/matter.",
    });
  }
}

const passwordSchema = z.string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Za-z]/, "Password must include at least one letter")
  .regex(/[0-9]/, "Password must include at least one number");

const emailSchema = z.string().trim().email("Enter a valid email address").transform(value => db.normalizeEmail(value));

function safeUser<T extends { passwordHash?: string | null }>(user: T) {
  const { passwordHash: _ph, ...safe } = user;
  return safe;
}

function getCookieOptions(ctx: { req: Request }) {
  const secureCookie = isSecureRequest(ctx.req);
  return {
    httpOnly: true,
    path: "/",
    sameSite: secureCookie ? "none" as const : "lax" as const,
    secure: secureCookie,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

async function assertCanRemoveActiveAdmin(targetUserId: number) {
  const target = await db.getUserById(targetUserId);
  if (!target) {
    throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
  }
  if (target.role === "admin" && target.status === "active") {
    const remainingActiveAdmins = await db.countActiveAdmins(targetUserId);
    if (remainingActiveAdmins < 1) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "At least one active admin must remain" });
    }
  }
  return target;
}

export const appRouter = router({
  system: systemRouter,

  // ─── Auth ─────────────────────────────────────────────────────────────────

  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user ? safeUser(opts.ctx.user) : null),

    login: publicProcedure
      .input(z.object({
        email: emailSchema,
        password: z.string().min(1),
      }))
      .mutation(async ({ input, ctx }) => {
        let user: Awaited<ReturnType<typeof db.getUserByEmail>>;
        try {
          user = await db.getUserByEmail(input.email);
        } catch (err: any) {
          const msg = formatDbError(err);
          console.error("[Auth] DB error during login:", msg);
          throw new Error(`DB: ${msg}`);
        }
        if (!user || !user.passwordHash) {
          throw new Error("Invalid email or password");
        }
        if (user.status !== "active") {
          throw new Error("Account is not active");
        }
        const valid = await verifyPassword(input.password, user.passwordHash);
        if (!valid) {
          throw new Error("Invalid email or password");
        }

        await db.updateLastLogin(user.id);
        const token = await createSessionToken(user.id, user.email);
        const cookieOptions = getCookieOptions(ctx);

        ctx.res.cookie(AUTH_COOKIE, token, cookieOptions);
        console.log("[Auth] Login success:", {
          email: user.email,
          secureCookie: cookieOptions.secure,
          protocol: ctx.req.protocol,
          forwardedProto: ctx.req.headers["x-forwarded-proto"] ?? null,
        });
        return { success: true, user: safeUser(user) };
      }),

    logout: publicProcedure.mutation(({ ctx }) => {
      ctx.res.clearCookie(AUTH_COOKIE, {
        httpOnly: true,
        path: "/",
        sameSite: isSecureRequest(ctx.req) ? "none" : "lax",
        secure: isSecureRequest(ctx.req),
        maxAge: -1,
      });
      return { success: true };
    }),
  }),

  // ─── Dashboard ────────────────────────────────────────────────────────────

  dashboard: router({
    stats: permissionProcedure("dashboard:view").query(async ({ ctx }) => {
      const stats = await db.getDashboardStats(ctx.user!);
      // Firm-wide revenue is financial data. Callers without financial viewing
      // authority get 0, which also keeps the revenue KPI card hidden in the UI.
      if (!hasPermission(ctx.user!.role, "financial:view")) {
        return { ...stats, totalRevenue: 0 };
      }
      return stats;
    }),

    // The activity feed is an unscoped firm-wide audit trail, not dashboard
    // decoration — restricted to roles with audit visibility.
    recentActivity: capabilityProcedure("audit:view")
      .input(z.object({ limit: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        return db.getRecentActivity(input.limit ?? 20, ctx.user!);
      }),
  }),

  // ─── Leads ────────────────────────────────────────────────────────────────

  leads: router({
    list: capabilityProcedure("leads:view")
      .input(z.object({
        channelType: z.string().optional(),
        channelMedium: z.string().optional(),
        status: z.string().optional(),
        search: z.string().optional(),
        assignedTo: z.number().optional(),
      }).optional())
      .query(async ({ input, ctx }) => db.getAllLeads(input ?? {}, ctx.user!)),

    // Distinct channel values for filter dropdowns.
    channelOptions: capabilityProcedure("leads:view").query(async () => db.getLeadChannelOptions()),

    get: capabilityProcedure("leads:view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => db.getLeadById(input.id, ctx.user!)),

    create: permissionProcedure("leads:manage")
      .input(z.object({
        dateOfEnquiry: z.string(),
        clientName: z.string().min(1),
        time: z.string().optional(),
        // Canonical UTC instant (ISO 8601) + the browser timezone captured at entry.
        enquiryAt: z.string().datetime().optional(),
        enquiryTimezone: z.string().optional(),
        // Two-level communication channel
        channelType: z.string().optional(),
        channelMedium: z.string().optional(),
        communicationChannel: z.string().optional(),
        receivedBy: z.string().optional(),
        clientType: z.string().optional(),
        nationality: z.string().optional(),
        email: z.string().email().optional().or(z.literal("")),
        phoneNumber: z.string().optional(),
        preferredContactMethod: z.string().optional(),
        languagePreference: z.string().optional(),
        companyId: z.number().optional(),
        serviceRequested: z.string().optional(),
        shortDescription: z.string().optional(),
        urgencyLevel: z.string().optional(),
        clientBudget: z.string().optional(),
        potentialValueRange: z.string().optional(),
        expectedTimeline: z.string().optional(),
        referralSourceName: z.string().optional(),
        competitorInvolvement: z.string().optional(),
        competitorName: z.string().optional(),
        assignedDepartment: z.string().optional(),
        assignedTo: z.number().optional(),
        suggestedLeadLawyer: z.string().optional(),
        currentStatus: z.string().optional(),
        nextAction: z.string().optional(),
        deadline: z.string().optional(),
        internalNotes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        db.validateChannel(input.channelType, input.channelMedium, { requireType: true });
        return db.createLead(input, ctx.user!.id);
      }),

    update: permissionProcedure("leads:manage")
      .input(z.object({
        id: z.number(),
        dateOfEnquiry: z.string().optional(),
        clientName: z.string().optional(),
        time: z.string().optional(),
        enquiryAt: z.string().datetime().optional(),
        enquiryTimezone: z.string().optional(),
        channelType: z.string().optional(),
        channelMedium: z.string().optional(),
        communicationChannel: z.string().optional(),
        receivedBy: z.string().optional(),
        clientType: z.string().optional(),
        nationality: z.string().optional(),
        email: z.string().optional(),
        phoneNumber: z.string().optional(),
        preferredContactMethod: z.string().optional(),
        languagePreference: z.string().optional(),
        companyId: z.number().optional(),
        serviceRequested: z.string().optional(),
        shortDescription: z.string().optional(),
        urgencyLevel: z.string().optional(),
        clientBudget: z.string().optional(),
        potentialValueRange: z.string().optional(),
        expectedTimeline: z.string().optional(),
        referralSourceName: z.string().optional(),
        competitorInvolvement: z.string().optional(),
        competitorName: z.string().optional(),
        assignedDepartment: z.string().optional(),
        assignedTo: z.number().optional(),
        suggestedLeadLawyer: z.string().optional(),
        currentStatus: z.string().optional(),
        nextAction: z.string().optional(),
        deadline: z.string().optional(),
        firstResponseDate: z.string().optional(),
        meetingDate: z.string().optional(),
        proposalSentDate: z.string().optional(),
        proposalValue: z.string().optional(),
        followUpCount: z.number().optional(),
        lastContactDate: z.string().optional(),
        conversionDate: z.string().optional(),
        engagementLetterDate: z.string().optional(),
        matterCode: z.string().optional(),
        paymentStatus: z.string().optional(),
        invoiceNumber: z.string().optional(),
        lostReason: z.string().optional(),
        internalNotes: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        db.validateChannel(data.channelType, data.channelMedium, { requireType: false });
        return db.updateLead(id, data);
      }),

    delete: permissionProcedure("leads:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteLead(input.id);
        return { success: true };
      }),

    statusSummary: permissionProcedure("analytics:view").query(async () => db.getLeadStatusSummary()),
  }),

  // ─── Matters ──────────────────────────────────────────────────────────────

  matters: router({
    list: capabilityProcedure("matters:view").query(async ({ ctx }) => db.getAllMatters(ctx.user!)),

    get: capabilityProcedure("matters:view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => db.getMatterById(input.id, ctx.user!)),

    create: permissionProcedure("matters:manage")
      .input(z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        clientName: z.string().min(1),
        clientEmail: z.string().email().optional().or(z.literal("")),
        clientPhone: z.string().optional(),
        companyId: z.number().optional(),
        leadId: z.number().optional(),
        practiceArea: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        assignedTo: z.number().optional(),
        openDate: z.string().optional(),
        estimatedValue: z.string().optional(),
        billingType: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        return db.createMatter(input, ctx.user!.id);
      }),

    update: permissionProcedure("matters:manage")
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        clientName: z.string().optional(),
        clientEmail: z.string().optional(),
        clientPhone: z.string().optional(),
        companyId: z.number().optional(),
        practiceArea: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        assignedTo: z.number().optional(),
        openDate: z.string().optional(),
        closeDate: z.string().optional(),
        nextHearingDate: z.string().optional(),
        estimatedValue: z.string().optional(),
        actualValue: z.string().optional(),
        billingType: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return db.updateMatter(id, data);
      }),

    delete: permissionProcedure("matters:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteMatter(input.id);
        return { success: true };
      }),
  }),

  // ─── Tasks ────────────────────────────────────────────────────────────────

  tasks: router({
    list: capabilityProcedure("tasks:view")
      .input(z.object({
        matterId: z.number().optional(),
        assignedTo: z.number().optional(),
        status: z.string().optional(),
        clientId: z.number().optional(),
        clientMatterId: z.number().optional(),
      }).optional())
      // Visibility is enforced server-side from the session user (role + id).
      .query(async ({ input, ctx }) => db.getAllTasks(input ?? {}, ctx.user!)),

    get: capabilityProcedure("tasks:view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => db.getTaskById(input.id, ctx.user!)),

    create: capabilityProcedure("tasks:create")
      .input(z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        // Client context is REQUIRED — every task must belong to a client (no
        // orphan tasks). A matter-scoped task additionally carries clientMatterId.
        clientId: z.number(),
        clientMatterId: z.number().optional(),
        // Provenance: where the task was created from (Action Log, Call, Meeting,
        // Email, Follow-up, Financial Review). clientActionLogId additionally links
        // the concrete action-log row so the detail view can jump back to it.
        sourceType: z.string().optional(),
        sourceId: z.number().optional(),
        clientActionLogId: z.number().optional(),
        assignedTo: z.number().optional(),
        dueDate: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const client = await db.getClientById(input.clientId, ctx.user!);
        if (!client) throw new TRPCError({ code: "NOT_FOUND", message: "Client not found." });
        if (input.clientMatterId != null) {
          const matter = await db.getClientMatterById(input.clientMatterId, ctx.user!);
          if (!matter) throw new TRPCError({ code: "NOT_FOUND", message: "Matter not found." });
          if (matter.clientId !== input.clientId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "The selected matter does not belong to the selected client." });
          }
        }
        if (input.sourceType != null || input.sourceId != null || input.clientActionLogId != null) {
          if (
            input.sourceType !== "action_log" ||
            input.sourceId == null ||
            input.clientActionLogId == null ||
            input.sourceId !== input.clientActionLogId
          ) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Task source references are invalid." });
          }
          const source = await db.getTaskActionLogSource(input.clientActionLogId);
          if (
            !source ||
            source.clientId !== input.clientId ||
            (source.clientMatterId != null && source.clientMatterId !== (input.clientMatterId ?? null))
          ) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Task source does not belong to the selected client/matter." });
          }
        }
        // Rejected clients are locked: no new tasks under them.
        await db.assertClientNotRejected(input.clientId);
        // Assigning a NEW task to ANOTHER user requires tasks:assign (base, or the
        // Lead Lawyer overlay of the task's matter) + assignee validation (§G).
        // Assigning to oneself is covered by tasks:create alone.
        if (input.assignedTo != null && input.assignedTo !== ctx.user!.id) {
          if (!(await taskCapabilityForMatter(ctx.user!, "tasks:assign", input.clientMatterId ?? null))) {
            throw new TRPCError({ code: "FORBIDDEN", message: "You do not have authority to assign tasks to other users." });
          }
          await enforceTaskAssignment(input.assignedTo, input.clientId, input.clientMatterId ?? null);
        }
        const task = await db.createTask(input, ctx.user!.id);
        if (input.assignedTo != null && input.assignedTo !== ctx.user!.id) {
          await db.auditTaskAssignment(task.id, null, input.assignedTo, ctx.user!.id);
        }
        return task;
      }),

    // Content/status update needs tasks:edit; REASSIGNMENT (changing assignedTo)
    // needs tasks:assign — a user who may edit their task never gains reassign or
    // delete rights (§G). clientId, clientMatterId, matterId, source ids and
    // createdBy are PROTECTED (not accepted here), so a task can't be moved onto a
    // different client/matter to escape scope. Gate is tasks:view; the mutation
    // authority is checked per-operation inside (Manager therefore mutates nothing).
    update: capabilityProcedure("tasks:view")
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        assignedTo: z.number().nullable().optional(), // null = unassign
        dueDate: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, assignedTo, ...content } = input;
        const wantsContent = Object.values(content).some(v => v !== undefined);
        const wantsReassign = assignedTo !== undefined;
        if (!wantsContent && !wantsReassign) {
          return db.assertTaskVisible(id, ctx.user!); // no-op read (still scoped)
        }
        // Resolve the task under the actor's visibility (null = missing OR invisible).
        // A Lead Lawyer gains edit/assign for tasks OF the matter they lead.
        const existing = await db.getTaskById(id, ctx.user!);
        const leadsMatter =
          !!existing && existing.clientMatterId != null &&
          (await db.isLeadLawyerOfMatter(ctx.user!.id, existing.clientMatterId));
        const editOK = authorize({ id: ctx.user!.id, role: ctx.user!.role, status: ctx.user!.status }, "tasks:edit").allowed || leadsMatter;
        const assignOK = authorize({ id: ctx.user!.id, role: ctx.user!.role, status: ctx.user!.status }, "tasks:assign").allowed || leadsMatter;
        // Authorization is checked BEFORE existence so a role with no mutation
        // authority (e.g. Manager) is denied FORBIDDEN, never NOT_FOUND (§G).
        if (wantsContent && !editOK) throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
        if (wantsReassign && !assignOK) throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
        // Authorized in principle — now require the task to exist and be visible.
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found." });

        const reassign = assignedTo !== undefined && assignedTo !== existing.assignedTo;
        if (reassign && assignedTo != null) {
          await enforceTaskAssignment(assignedTo, existing.clientId, existing.clientMatterId);
        }
        const updated = await db.updateTask(id, { ...content, ...(reassign ? { assignedTo } : {}) });
        if (reassign) await db.auditTaskAssignment(id, existing.assignedTo, assignedTo ?? null, ctx.user!.id);
        return updated;
      }),

    // Deletion is a DISTINCT authority (tasks:delete) — Admin only among target
    // roles (legacy partner/lawyer/staff retain it). Visibility still required.
    delete: capabilityProcedure("tasks:delete")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.assertTaskVisible(input.id, ctx.user!);
        await db.deleteTask(input.id);
        return { success: true };
      }),
  }),

  // ─── Notes ────────────────────────────────────────────────────────────────

  notes: router({
    byEntity: permissionProcedure("notes:view")
      .input(z.object({ entityType: z.string(), entityId: z.number() }))
      .query(async ({ input }) => db.getNotesByEntity(input.entityType, input.entityId)),

    create: permissionProcedure("notes:manage")
      .input(z.object({
        content: z.string().min(1),
        entityType: z.string(),
        entityId: z.number(),
        matterId: z.number().optional(),
        leadId: z.number().optional(),
        isPrivate: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        return db.createNote({ ...input, createdBy: ctx.user!.id });
      }),

    delete: permissionProcedure("notes:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteNote(input.id);
        return { success: true };
      }),
  }),

  // ─── Payments ─────────────────────────────────────────────────────────────

  payments: router({
    list: capabilityProcedure("payments:view").query(async () => db.getAllPayments()),

    getByLead: capabilityProcedure("payments:view")
      .input(z.object({ leadId: z.number() }))
      .query(async ({ input }) => db.getPaymentByLeadId(input.leadId)),

    // Recording or editing money is a mutation authority (payments:create /
    // payments:edit) — payments:view alone must never authorize a write.
    create: capabilityProcedure("payments:create")
      .input(z.object({
        leadId: z.number(),
        matterCode: z.string(),
        paymentTerms: z.string().optional(),
        paymentStatus: z.string().optional(),
        totalAmount: z.string().optional(),
        amountPaid: z.string().optional(),
        amountOutstanding: z.string().optional(),
        retainerPaidDate: z.string().optional(),
        retainerAmount: z.string().optional(),
        midPaymentDate: z.string().optional(),
        midPaymentAmount: z.string().optional(),
        finalPaymentDate: z.string().optional(),
        finalPaymentAmount: z.string().optional(),
        paymentNotes: z.string().optional(),
      }))
      .mutation(async ({ input }) => db.createPayment(input)),

    update: capabilityProcedure("payments:edit")
      .input(z.object({
        id: z.number(),
        paymentTerms: z.string().optional(),
        paymentStatus: z.string().optional(),
        totalAmount: z.string().optional(),
        amountPaid: z.string().optional(),
        amountOutstanding: z.string().optional(),
        retainerPaidDate: z.string().optional(),
        retainerAmount: z.string().optional(),
        midPaymentDate: z.string().optional(),
        midPaymentAmount: z.string().optional(),
        finalPaymentDate: z.string().optional(),
        finalPaymentAmount: z.string().optional(),
        paymentNotes: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return db.updatePayment(id, data);
      }),
  }),

  // ─── Companies ────────────────────────────────────────────────────────────

  companies: router({
    list: protectedProcedure.query(async () => db.getAllCompanies()),

    // Companies are client/lead intake records — mutating them requires the same
    // authority as managing clients (read stays broad for form dropdowns).
    create: permissionProcedure("clients:manage")
      .input(z.object({
        name: z.string().min(1),
        industry: z.string().optional(),
        website: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().email().optional().or(z.literal("")),
        address: z.string().optional(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        return db.createCompany({ ...input, createdBy: ctx.user!.id });
      }),

    update: permissionProcedure("clients:manage")
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        industry: z.string().optional(),
        website: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        address: z.string().optional(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return db.updateCompany(id, data);
      }),
  }),

  // ─── Users ────────────────────────────────────────────────────────────────

  users: router({
    list: adminProcedure.query(async () => {
      const all = await db.getAllUsers();
      return all.map(safeUser);
    }),

    // Active users who may be assigned to a matter as lead/co-lawyers. Available
    // to anyone who can view clients so the Hourly Rate section can populate its
    // user pickers (no free-text names).
    assignableLawyers: permissionProcedure("clients:view")
      .query(async () => db.getAssignableLawyers()),

    // Active Partners/Lawyers for the "Suggested Lead Lawyer" dropdown and the
    // Enquiries Log assignee filter (names/ids only — leads:view is sufficient).
    leadLawyers: permissionProcedure("leads:view")
      .query(async () => db.getLeadLawyers()),

    // Users eligible for a NEW assignment to a specific lawyer field (Matter
    // forms, Financial Records). Active + role-eligible only, filtered
    // server-side per shared/assignmentEligibility.ts. clients:view so every
    // role that can open these forms (incl. finance) can populate dropdowns.
    eligibleLawyers: permissionProcedure("clients:view")
      .input(z.object({
        field: z.enum(ASSIGNMENT_FIELD_NAMES as [AssignmentField, ...AssignmentField[]]),
      }))
      .query(async ({ input }) => db.getEligibleLawyers(input.field)),

    create: adminProcedure
      .input(z.object({
        name: z.string().trim().min(1, "Name is required").max(120),
        email: emailSchema,
        password: passwordSchema,
        role: roleSchema.default("staff"),
        status: statusSchema.default("active"),
        reportsToId: z.number().nullable().optional(), // supervising partner
      }))
      .mutation(async ({ input, ctx }) => {
        // No new account may be created as Finance until policy convergence.
        assertFinanceAssignmentAllowed(input.role);

        const existing = await db.getUserByEmail(input.email);
        if (existing) {
          throw new TRPCError({ code: "CONFLICT", message: "A user with this email already exists" });
        }

        const passwordHash = await hashPassword(input.password);
        const user = await db.createUser({
          name: input.name,
          email: input.email,
          passwordHash,
          role: input.role,
          status: input.status,
          reportsToId: input.reportsToId ?? null,
        });

        await db.createAuditLog({
          entityType: "user",
          entityId: user.id,
          userId: ctx.user.id,
          action: "created",
          description: `User ${user.email} created`,
        });

        return safeUser(user);
      }),

    update: adminProcedure
      .input(z.object({
        userId: z.number(),
        name: z.string().trim().min(1, "Name is required").max(120),
        email: emailSchema,
        role: roleSchema,
        status: statusSchema,
        reportsToId: z.number().nullable().optional(), // supervising partner
      }))
      .mutation(async ({ input, ctx }) => {
        const target = await db.getUserById(input.userId);
        if (!target) {
          throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
        }

        // Existing Finance may remain Finance; no OTHER role may transition into it.
        assertFinanceAssignmentAllowed(input.role, target.role);

        const emailOwner = await db.getUserByEmail(input.email);
        if (emailOwner && emailOwner.id !== input.userId) {
          throw new TRPCError({ code: "CONFLICT", message: "A user with this email already exists" });
        }

        if (
          target.role === "admin" &&
          target.status === "active" &&
          (input.role !== "admin" || input.status !== "active")
        ) {
          await assertCanRemoveActiveAdmin(input.userId);
        }

        if (input.userId === ctx.user.id && (input.role !== "admin" || input.status !== "active")) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot remove your own active admin access" });
        }

        const updated = await db.updateUser(input.userId, {
          name: input.name,
          email: input.email,
          role: input.role,
          status: input.status,
          ...(input.reportsToId !== undefined ? { reportsToId: input.reportsToId } : {}),
        });

        if (target.role !== input.role) {
          await db.createAuditLog({
            entityType: "user",
            entityId: input.userId,
            userId: ctx.user.id,
            action: "role_changed",
            fieldName: "role",
            oldValue: target.role,
            newValue: input.role,
            description: `Role changed for ${input.email}`,
          });
        }

        if (target.status !== input.status) {
          await db.createAuditLog({
            entityType: "user",
            entityId: input.userId,
            userId: ctx.user.id,
            action: "status_changed",
            fieldName: "status",
            oldValue: target.status,
            newValue: input.status,
            description: `Status changed for ${input.email}`,
          });
        }

        return safeUser(updated);
    }),

    updateRole: adminProcedure
      .input(z.object({ userId: z.number(), role: roleSchema }))
      .mutation(async ({ input, ctx }) => {
        const target = await assertCanRemoveActiveAdmin(input.userId);
        // Existing Finance may remain Finance; no OTHER role may transition into it.
        assertFinanceAssignmentAllowed(input.role, target.role);
        if (input.userId === ctx.user.id && input.role !== "admin") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot remove your own admin role" });
        }
        await db.updateUserRole(input.userId, input.role);
        if (target.role !== input.role) {
          await db.createAuditLog({
            entityType: "user",
            entityId: input.userId,
            userId: ctx.user.id,
            action: "role_changed",
            fieldName: "role",
            oldValue: target.role,
            newValue: input.role,
            description: `Role changed for ${target.email}`,
          });
        }
        return { success: true };
      }),

    updateStatus: adminProcedure
      .input(z.object({ userId: z.number(), status: statusSchema }))
      .mutation(async ({ input, ctx }) => {
        const target = await assertCanRemoveActiveAdmin(input.userId);
        if (input.userId === ctx.user.id && input.status !== "active") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot deactivate your own account" });
        }
        await db.updateUserStatus(input.userId, input.status);
        if (target.status !== input.status) {
          await db.createAuditLog({
            entityType: "user",
            entityId: input.userId,
            userId: ctx.user.id,
            action: "status_changed",
            fieldName: "status",
            oldValue: target.status,
            newValue: input.status,
            description: `Status changed for ${target.email}`,
          });
        }
        return { success: true };
      }),

    resetPassword: adminProcedure
      .input(z.object({ userId: z.number(), password: passwordSchema }))
      .mutation(async ({ input, ctx }) => {
        const target = await db.getUserById(input.userId);
        if (!target) {
          throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
        }
        const passwordHash = await hashPassword(input.password);
        await db.updateUser(input.userId, { passwordHash });
        await db.createAuditLog({
          entityType: "user",
          entityId: input.userId,
          userId: ctx.user.id,
          action: "password_reset",
          description: `Password reset for ${target.email}`,
        });
        return { success: true };
      }),

    delete: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        if (input.userId === ctx.user.id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot delete your own account" });
        }
        const target = await assertCanRemoveActiveAdmin(input.userId);
        await db.deleteUser(input.userId);
        await db.createAuditLog({
          entityType: "user",
          entityId: input.userId,
          userId: ctx.user.id,
          action: "deleted",
          description: `User ${target.email} deleted`,
        });
        return { success: true };
      }),

    updatePassword: protectedProcedure
      .input(z.object({ currentPassword: z.string(), newPassword: passwordSchema }))
      .mutation(async ({ input, ctx }) => {
        const user = await db.getUserById(ctx.user.id);
        if (!user?.passwordHash) throw new Error("No password set");
        const valid = await verifyPassword(input.currentPassword, user.passwordHash);
        if (!valid) throw new Error("Current password is incorrect");
        const hash = await hashPassword(input.newPassword);
        await db.updateUser(ctx.user.id, { passwordHash: hash });
        await db.createAuditLog({
          entityType: "user",
          entityId: ctx.user.id,
          userId: ctx.user.id,
          action: "password_reset",
          description: "Own password changed",
        });
        return { success: true };
      }),

    // Per-user activity metrics are oversight data — not open to every session.
    activityStats: permissionProcedure("audit:view")
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => db.getUserActivityStats(input.userId)),
  }),

  // ─── Audit Logs ───────────────────────────────────────────────────────────

  auditLogs: router({
    byEntity: permissionProcedure("audit:view")
      .input(z.object({ entityType: z.string(), entityId: z.number() }))
      .query(async ({ input }) => {
        return db.getAuditLogsByEntity(input.entityType, input.entityId);
      }),
  }),

  // ─── In-app Notifications (current user) ───────────────────────────────────

  notifications: router({
    list: protectedProcedure
      .input(z.object({ limit: z.number().int().positive().max(50).default(20) }).optional())
      .query(async ({ input, ctx }) => db.getUserNotifications(ctx.user!.id, input?.limit ?? 20)),

    unreadCount: protectedProcedure
      .query(async ({ ctx }) => db.getUnreadNotificationCount(ctx.user!.id)),

    markRead: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => db.markNotificationRead(input.id, ctx.user!.id)),

    markAllRead: protectedProcedure
      .mutation(async ({ ctx }) => db.markAllNotificationsRead(ctx.user!.id)),
  }),

  // ─── Clients ──────────────────────────────────────────────────────────────

  clients: router({
    list: capabilityProcedure("clients:view").input(z.object({
      clientStatus: z.string().optional(),
      city: z.string().optional(),
      matterType: z.string().optional(),
      search: z.string().optional(),
      // Unified intake filters
      convertedFrom: z.enum(["Lead", "Enquiry", "Direct"]).optional(),
      assignedLawyerId: z.number().optional(),
      createdFrom: z.string().optional(),
      createdTo: z.string().optional(),
      channelType: z.string().optional(),
      channelMedium: z.string().optional(),
    }).optional()).query(async ({ input, ctx }) => db.getAllClients(input ?? {}, ctx.user!)),

    get: capabilityProcedure("clients:view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => db.getClientById(input.id, ctx.user!)),

    create: capabilityProcedure("clients:create")
      .input(z.object({
        clientName: z.string().min(1),
        clientStatus: z.enum(["Existing Client", "Leads", "Rejected"]).default("Leads"),
        convertedFrom: z.enum(["Lead", "Enquiry", "Direct"]).optional(),
        clientNumber: z.string().optional(),
        fileNumber: z.string().optional(),
        city: z.enum(["Riyadh", "Dammam", "Jeddah"]).optional(),
        matterType: z.enum(["Corporate", "Litigation"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // OWN_PRACTICE (Phase 5): a Head of Practice may create only within their
        // own practice (city + matter type). ALL-scope writers are unrestricted;
        // null/unclassified practice fails closed.
        await assertOwnPracticeWrite(ctx.user!, "clients:create", { location: input.city, matterType: input.matterType });
        return db.createClient(input as any, ctx.user!.id);
      }),

    update: capabilityProcedure("clients:edit")
      .input(z.object({
        id: z.number(),
        clientName: z.string().optional(),
        clientStatus: z.enum(["Existing Client", "Leads", "Rejected"]).optional(),
        convertedFrom: z.enum(["Lead", "Enquiry", "Direct"]).optional(),
        clientNumber: z.string().optional(),
        fileNumber: z.string().optional(),
        city: z.enum(["Riyadh", "Dammam", "Jeddah"]).optional(),
        matterType: z.enum(["Corporate", "Litigation"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        // Scope guard (IDOR): you can only edit a client you can see (HoP reads
        // are ALL, so this returns the row). Out-of-scope → NOT_FOUND.
        const existing = await db.getClientById(id, ctx.user!);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
        }
        // OWN_PRACTICE: validate BOTH the current and the proposed (city, matter
        // type) — prevents self-claiming a record or moving it into another head's
        // practice via the scope-defining fields. Unspecified fields keep current.
        await assertOwnPracticeWrite(
          ctx.user!,
          "clients:edit",
          { location: input.city ?? existing.city, matterType: input.matterType ?? existing.matterType },
          { location: existing.city, matterType: existing.matterType },
        );
        return db.updateClient(id, data as any, ctx.user!.id);
      }),

    delete: capabilityProcedure("clients:delete")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        if (!(await db.getClientById(input.id, ctx.user!))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
        }
        await db.deleteClient(input.id);
        return { success: true };
      }),

    statusCounts: permissionProcedure("dashboard:view").query(async () => db.getClientStatusCounts()),

    dashboardStats: permissionProcedure("dashboard:view").query(async ({ ctx }) => {
      const stats = await db.getClientDashboardStats();
      // The financial aggregates (from getFinancialSummary) are only for callers
      // with financial viewing authority; everyone else gets zeroed values while
      // keeping the client counts and payload shape.
      if (!hasPermission(ctx.user!.role, "financial:view")) {
        return { ...stats, totalRevenue: 0, totalOutstanding: 0, overdueCount: 0, totalToBeBilled: 0 };
      }
      return stats;
    }),

    conversionMetrics: permissionProcedure("dashboard:view")
      .input(z.object({ range: z.enum(["month", "quarter", "all"]).default("all") }).optional())
      .query(async ({ input }) => db.getClientConversionMetrics(input?.range ?? "all")),

    // Recent Lead-status clients within the last N days (default 30), newest first.
    // Powers the dashboard "Recent Leads" widget; date window uses the DB clock.
    recentLeads: permissionProcedure("clients:view")
      .input(z.object({
        days: z.number().int().positive().max(365).default(30),
        limit: z.number().int().positive().max(50).default(5),
      }).optional())
      .query(async ({ input }) => db.getRecentLeads(input?.days ?? 30, input?.limit ?? 5)),

    // Lead details sub-resource
    getLeadDetail: permissionProcedure("clients:view")
      .input(z.object({ clientId: z.number() }))
      .query(async ({ input }) => db.getClientLeadDetail(input.clientId)),

    upsertLeadDetail: permissionProcedure("clients:manage")
      .input(z.object({
        clientId: z.number(),
        clientSource: z.string().optional(),
        nextActionDate: z.string().optional(),
        nextActionDate2: z.string().optional(),
        nextActionOwner: z.string().optional(),
        assignedLawyerId: z.number().nullable().optional(),
        channelType: z.string().optional(),
        channelMedium: z.string().optional(),
        nextAction: z.string().optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        leadStatus: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { clientId, ...data } = input;
        db.validateChannel(data.channelType, data.channelMedium, { requireType: false });
        return db.upsertClientLeadDetail(clientId, data as any);
      }),

    // Rejected details sub-resource
    getRejectedDetail: permissionProcedure("clients:view")
      .input(z.object({ clientId: z.number() }))
      .query(async ({ input }) => db.getRejectedClientDetail(input.clientId)),

    upsertRejectedDetail: permissionProcedure("clients:manage")
      .input(z.object({
        clientId: z.number(),
        rejectionReasonSource: z.enum(["Client", "Us"]).optional(),
        rejectionNotes: z.string().optional(),
        rejectedBy: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { clientId, ...data } = input;
        return db.upsertRejectedClient(clientId, data as any);
      }),

    conflictCheck: capabilityProcedure("clients:view")
      .input(z.object({ query: z.string().min(1).max(255) }))
      .query(async ({ input, ctx }) => db.searchConflicts(input.query, ctx.user!)),
  }),

  // ─── Client Matters ────────────────────────────────────────────────────────

  clientMatters: router({
    list: capabilityProcedure("clients:view")
      .input(z.object({ clientId: z.number() }))
      .query(async ({ input, ctx }) => db.getClientMatters(input.clientId, ctx.user!)),

    // Lead + co-lawyers billable on a matter, each with their effective hourly
    // rate. The source of truth for the Hourly Rate section and billing logic.
    // Exposes hourly rates → it is rate data (rates:view), and ASSIGNED-scope
    // holders (Senior Associate) may read it only for a matter they are assigned to.
    billableLawyers: capabilityProcedure("rates:view")
      .input(z.object({ clientMatterId: z.number() }))
      .query(async ({ input, ctx }) => {
        if (authorize({ id: ctx.user!.id, role: ctx.user!.role, status: ctx.user!.status }, "rates:view").scope !== "ALL"
            && !(await db.isActorAssignedToMatter(ctx.user!.id, input.clientMatterId))) {
          return { lead: null, coLawyers: [], all: [] };
        }
        return db.getMatterBillableLawyers(input.clientMatterId);
      }),

    // Controlled "Reassign Lead Lawyer" action — restricted to Admin/Partner via
    // the matters:assign_lawyer permission. The name is derived from the user.
    reassignLeadLawyer: permissionProcedure("matters:assign_lawyer")
      .input(z.object({ clientMatterId: z.number(), userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.assertMatterClientNotRejected(input.clientMatterId);
        return db.reassignLeadLawyer(input.clientMatterId, input.userId, ctx.user!.id);
      }),

    // Lead Lawyer overlay (Phase 6): READ-ONLY, matter-filtered financial records
    // for a single matter. Allowed for base financial viewers OR the designated
    // Lead Lawyer of THIS matter (e.g. an Executive Associate who otherwise has no
    // financial visibility). Never grants financial mutation, and never exposes
    // other matters' records — the query is filtered to clientMatterId.
    matterFinancials: protectedProcedure
      .input(z.object({ clientMatterId: z.number() }))
      .query(async ({ input, ctx }) => {
        const decision = authorize(
          { id: ctx.user!.id, role: ctx.user!.role, status: ctx.user!.status },
          "financial:view",
        );
        const isLead = await db.isLeadLawyerOfMatter(ctx.user!.id, input.clientMatterId);
        if (!decision.allowed && !isLead) {
          throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
        }
        // The Lead Lawyer overlay and ALL-scope viewers see every record on THIS
        // matter. ASSIGNED-scope viewers (Senior Associate) must be filtered to
        // their own assigned matters: pass the actor so financialScopeWhere yields
        // this matter's rows only when they are assigned to it (otherwise an empty
        // set), closing cross-matter financial leakage through this nested endpoint.
        const actor = (isLead || decision.scope === "ALL") ? undefined : ctx.user!;
        const rows = await db.getFinancialRecords({ clientMatterId: input.clientMatterId }, actor);
        return ctx.user!.role === "coordinator" ? rows.map(toPaymentStatusDTO) : rows;
      }),

    // Conflict check for a (prospective) matter — by matter name and/or opposing
    // party. Used by the Create Matter form before submitting.
    checkConflicts: capabilityProcedure("clients:view")
      .input(z.object({
        matterName: z.string().optional(),
        opposingParty: z.string().optional(),
        // Owning client of the prospective matter — scopes out cross-client
        // Matter Reference matches (different clients may reuse a reference).
        clientId: z.number().optional(),
      }))
      .query(async ({ input, ctx }) =>
        db.checkMatterConflicts({
          matterName: input.matterName,
          opposingParty: input.opposingParty,
          clientId: input.clientId,
        }, ctx.user!),
      ),

    listAll: capabilityProcedure("clients:view")
      .input(z.object({ status: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => db.getAllClientMatters(input ?? {}, ctx.user!)),

    get: capabilityProcedure("clients:view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => db.getClientMatterById(input.id, ctx.user!)),

    create: permissionProcedure("clients:manage")
      .input(z.object({
        clientId: z.number(),
        originalSerial: z.string().max(50).optional(),
        matterReference: z.string().optional(),
        // New matters accept only the supported values (shared/const.ts).
        // Legacy free-text values live only on pre-existing rows.
        matterType: z.enum(MATTER_TYPES, {
          message: `Matter Type must be one of: ${MATTER_TYPES.join(", ")}.`,
        }),
        billingType: z.enum([
          "Billable Hours",
          "Fixed / Project-Based Fees",
          "Retainers",
          "Success Fees",
          "Advisory / Special Mandates",
          "Blended",
        ]).optional(),
        // Lawyer assignments as real users (validated server-side: must exist,
        // be active, and hold an eligible role). The free-text fields below
        // remain accepted for legacy entry/back-compat.
        leadLawyerId: z.number().int().positive().optional(),
        supportLeadId: z.number().int().positive().nullable().optional(),
        attorneyHeadId: z.number().int().positive().nullable().optional(),
        attorney1Id: z.number().int().positive().nullable().optional(),
        attorney2Id: z.number().int().positive().nullable().optional(),
        attorney3Id: z.number().int().positive().nullable().optional(),
        attorney4Id: z.number().int().positive().nullable().optional(),
        leadPartner: z.string().optional(),
        leadPartnerFullName: z.string().optional(),
        supportLead: z.string().optional(),
        attorneyHead: z.string().optional(),
        attorney1: z.string().optional(),
        attorney2: z.string().optional(),
        attorney3: z.string().optional(),
        attorneyFullName: z.string().optional(),
        matterDescription: z.string().optional(),
        opposingParty: z.string().max(255).optional(),
        matterStatus: z.string().max(100).optional(),
        balanceWorkLeft: z.string().optional(),
        achievementPercentage: z.string().optional(),
        achievementStatus: z.string().max(100).optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        // When true, the user has reviewed the conflict check and chosen to
        // proceed despite potential matches. Not persisted as a matter column.
        acknowledgeConflicts: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { acknowledgeConflicts, ...matterInput } = input;
        // Lead Lawyer designation on CREATE is a privileged assignment
        // (matters:assign_lawyer) — it must NOT be self-granted through the
        // generic create input (§G: prevent self-designation).
        if (matterInput.leadLawyerId != null && !hasPermission(ctx.user!.role, "matters:assign_lawyer")) {
          throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
        }
        // Rejected clients are locked: no new matters.
        await db.assertClientNotRejected(matterInput.clientId);
        // Backend enforcement (defense in depth): re-run the conflict check and
        // refuse to create unless the user has acknowledged any matches.
        const conflicts = await db.checkMatterConflicts({
          matterName: matterInput.matterReference,
          opposingParty: matterInput.opposingParty,
          clientId: matterInput.clientId,
        }, ctx.user!);
        if (conflicts.length > 0 && !acknowledgeConflicts) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              `Potential conflict(s) found (${conflicts.length}). Review the conflict ` +
              `check and acknowledge before creating this matter.`,
          });
        }
        return db.createClientMatter(matterInput as any, ctx.user!.id, conflicts);
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        originalSerial: z.string().max(50).optional(),
        matterReference: z.string().optional(),
        matterType: z.string().optional(),
        billingType: z.enum([
          "Billable Hours",
          "Fixed / Project-Based Fees",
          "Retainers",
          "Success Fees",
          "Advisory / Special Mandates",
          "Blended",
        ]).optional().nullable(),
        // Lawyer-assignment user links: number assigns/validates, null unlinks.
        // Unchanged ids are preserved even if the user is now inactive.
        leadLawyerId: z.number().int().positive().nullable().optional(),
        supportLeadId: z.number().int().positive().nullable().optional(),
        attorneyHeadId: z.number().int().positive().nullable().optional(),
        attorney1Id: z.number().int().positive().nullable().optional(),
        attorney2Id: z.number().int().positive().nullable().optional(),
        attorney3Id: z.number().int().positive().nullable().optional(),
        attorney4Id: z.number().int().positive().nullable().optional(),
        leadPartner: z.string().optional(),
        leadPartnerFullName: z.string().optional(),
        supportLead: z.string().optional(),
        attorneyHead: z.string().optional(),
        attorney1: z.string().optional(),
        attorney2: z.string().optional(),
        attorney3: z.string().optional(),
        attorneyFullName: z.string().optional(),
        matterDescription: z.string().optional(),
        opposingParty: z.string().max(255).optional(),
        matterStatus: z.string().max(100).optional(),
        balanceWorkLeft: z.string().optional(),
        achievementPercentage: z.string().optional(),
        achievementStatus: z.string().max(100).optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        // Authorization FIRST (before any record lookup, so a caller with no edit
        // authority gets a consistent FORBIDDEN, not a NOT_FOUND). Base matter/
        // client managers edit freely; otherwise the ONLY path is the Lead Lawyer
        // overlay — the actor must be THIS matter's designated Lead Lawyer and may
        // change ONLY allowlisted detail fields.
        const canBaseEdit =
          hasPermission(ctx.user!.role, "clients:manage") || hasPermission(ctx.user!.role, "matters:manage");
        if (!canBaseEdit) {
          if (!(await db.isLeadLawyerOfMatter(ctx.user!.id, id))) {
            throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
          }
          const changed = Object.keys(data).filter(k => (data as Record<string, unknown>)[k] !== undefined);
          const disallowed = changed.filter(k => !LEAD_LAWYER_EDITABLE_FIELDS.includes(k));
          if (disallowed.length > 0) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: `Lead Lawyer may edit only matter details; not: ${disallowed.join(", ")}.`,
            });
          }
        }
        // Rejected clients are locked: existing matters are read-only.
        await db.assertMatterClientNotRejected(id);
        // Scope guard (IDOR): re-fetch the matter under the caller's scope. An
        // out-of-scope (or missing) matter → NOT_FOUND, non-enumerating. This
        // `existing` also drives the lead-lawyer change check below.
        const existing = await db.getClientMatterById(id, ctx.user!);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Matter not found." });
        }
        // Lead Lawyer assignment is a separately privileged action
        // (matters:assign_lawyer). The generic update may re-submit the UNCHANGED
        // value (forms send every field), but a change — including unlinking via
        // null — is rejected unless the actor holds the assignment capability.
        if (data.leadLawyerId !== undefined) {
          const changed = (data.leadLawyerId ?? null) !== (existing.leadLawyerId ?? null);
          if (changed && !hasPermission(ctx.user!.role, "matters:assign_lawyer")) {
            throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
          }
        }
        return db.updateClientMatter(id, data as any, ctx.user!.id);
      }),

    delete: permissionProcedure("clients:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.assertMatterClientNotRejected(input.id);
        if (!(await db.getClientMatterById(input.id, ctx.user!))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Matter not found." });
        }
        await db.deleteClientMatter(input.id);
        return { success: true };
      }),
  }),

  // ─── Matter Lawyer Rates ───────────────────────────────────────────────────

  // Hourly rates are a financial sub-resource with their OWN capabilities
  // (rates:view/create/edit/delete), separate from financial records and payments.
  // View is ASSIGNED-scoped (a Senior Associate sees only their matters' rates);
  // create/edit are OWN_PRACTICE-bound for a Head of Practice (delete is not a
  // HoP grant — only ALL-scope Finance/Admin). Legacy roles hold these at scope
  // ALL, so the migration off the deprecated bridge is behavior-preserving.
  matterLawyerRates: router({
    list: capabilityProcedure("rates:view")
      .input(z.object({ clientMatterId: z.number() }))
      .query(async ({ input, ctx }) => {
        // ASSIGNED-scope viewers may read only a matter they are assigned to.
        if (authorize({ id: ctx.user!.id, role: ctx.user!.role, status: ctx.user!.status }, "rates:view").scope !== "ALL"
            && !(await db.isActorAssignedToMatter(ctx.user!.id, input.clientMatterId))) {
          return [];
        }
        return db.getMatterLawyerRates(input.clientMatterId);
      }),

    create: capabilityProcedure("rates:create")
      .input(z.object({
        clientMatterId: z.number(),
        // A rate must reference an assigned user. lawyerName is NOT accepted from
        // the client — the server derives it from the user (no free-text names).
        userId: z.number(),
        role: z.string().optional(),
        hourlyRate: z.string().refine(v => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 0;
        }, "Hourly rate must be a number ≥ 0"),
        currency: z.string().default("SAR"),
        isActive: z.boolean().default(true),
        effectiveDate: z.string().optional(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.assertMatterClientNotRejected(input.clientMatterId);
        // OWN_PRACTICE: a Head of Practice may set rates only on matters in their
        // own practice; ALL-scope writers (Finance/Admin) are unrestricted; an
        // unknown/unclassified matter fails closed.
        const matter = await db.getClientMatterById(input.clientMatterId);
        await assertOwnPracticeWrite(
          ctx.user!, "rates:create",
          matter ? await financialRecordPracticeKey(matter.clientId, input.clientMatterId)
                 : { location: null, matterType: null },
        );
        return db.createMatterLawyerRate(input as any, ctx.user!.id);
      }),

    update: capabilityProcedure("rates:edit")
      .input(z.object({
        id: z.number(),
        // lawyerName is intentionally absent — only the linked user (userId) can
        // change a rate's lawyer, and the name is re-derived server-side.
        userId: z.number().optional(),
        role: z.string().optional(),
        hourlyRate: z.string().refine(v => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 0;
        }, "Hourly rate must be a number ≥ 0").optional(),
        currency: z.string().optional(),
        isActive: z.boolean().optional(),
        effectiveDate: z.string().optional().nullable(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        await db.assertRateClientNotRejected(id);
        // OWN_PRACTICE: the rate's matter must be in the actor's practice. The
        // update never moves the rate to another matter, so existing == proposed.
        const rate = await db.getMatterLawyerRateById(id);
        if (!rate) throw new TRPCError({ code: "NOT_FOUND", message: "Rate not found." });
        const matter = await db.getClientMatterById(rate.clientMatterId);
        const key = matter
          ? await financialRecordPracticeKey(matter.clientId, rate.clientMatterId)
          : { location: null, matterType: null };
        await assertOwnPracticeWrite(ctx.user!, "rates:edit", key, key);
        return db.updateMatterLawyerRate(id, data as any, ctx.user!.id);
      }),

    delete: capabilityProcedure("rates:delete")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.assertRateClientNotRejected(input.id);
        await db.deleteMatterLawyerRate(input.id);
        return { success: true };
      }),
  }),

  // ─── Financial Records ─────────────────────────────────────────────────────

  financial: router({
    list: capabilityProcedure("financial:view")
      .input(z.object({
        clientId: z.number().optional(),
        clientMatterId: z.number().optional(),
        collectionStatus: z.string().optional(),
      }).optional())
      .query(async ({ input, ctx }) => {
        const rows = await db.getFinancialRecords(input ?? {}, ctx.user!);
        // Coordinator sees a RESTRICTED payment-status projection only — no fees,
        // revenue, amounts, rates, notes, or audit details (§B/§G).
        if (ctx.user!.role === "coordinator") return rows.map(toPaymentStatusDTO);
        return rows;
      }),

    get: capabilityProcedure("financial:view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const rec = await db.getFinancialRecordById(input.id, ctx.user!);
        if (!rec) return null; // out-of-scope / missing — non-enumerating
        if (ctx.user!.role === "coordinator") return toPaymentStatusDTO(rec);
        return rec;
      }),

    create: capabilityProcedure("financial:create")
      .input(z.object({
        clientId: z.number(),
        clientMatterId: z.number().optional(),
        feeType: z.enum(["Billable Hours", "Fixed / Project-Based Fees", "Retainers", "Success Fees", "Advisory / Special Mandates", "Blended"]).optional(),
        agreedFees: nonNegativeMoney.optional(),
        discountApproval: z.enum(["N/A", "P&L Head Lawyers", "CEO", "Board"]).default("N/A"),
        // discountPercentage, discountAmount, netFees are server-computed from discountApproval.
        // Revenue is the single active amount field. billed_amount is NOT written
        // (legacy/read-only, CRM-012) and is NOT mirrored to revenue — see
        // applyDiscountRules and FINANCIAL_FORMULAS.md.
        revenue: nonNegativeMoney.optional(),
        collectedAmount: nonNegativeMoney.optional(),
        // outstandingAmount is server-computed; remainingAdvanced is legacy/read-only.
        collectionStatus: z.enum(["Not Billed", "Partially Billed", "Billed", "Partially Collected", "Fully Collected", "Overdue"]).default("Not Billed"),
        billingDate: z.string().optional(),
        paymentDate: z.string().optional(),
        invoiceNumber: z.string().optional(),
        responsibleLawyer: z.string().optional(),
        // Responsible Lawyer as a real user (validated server-side); the text
        // field above remains accepted for legacy entry.
        responsibleLawyerId: z.number().int().positive().nullable().optional(),
        financeNotes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // Rejected clients are locked: no new financial records.
        await db.assertClientNotRejected(input.clientId);
        // OWN_PRACTICE (Phase 7): a Head of Practice may create financial records
        // only within their own practice; ALL-scope writers (finance/admin) are
        // unrestricted; null/unclassified practice fails closed.
        await assertOwnPracticeWrite(
          ctx.user!, "financial:create",
          await financialRecordPracticeKey(input.clientId, input.clientMatterId),
        );
        return db.createFinancialRecord(input as any, ctx.user!.id);
      }),

    update: capabilityProcedure("financial:edit")
      .input(z.object({
        id: z.number(),
        clientMatterId: z.number().nullable().optional(), // null = unlink matter
        feeType: z.enum(["Billable Hours", "Fixed / Project-Based Fees", "Retainers", "Success Fees", "Advisory / Special Mandates", "Blended"]).optional(),
        agreedFees: nonNegativeMoney.optional(),
        discountApproval: z.enum(["N/A", "P&L Head Lawyers", "CEO", "Board"]).optional(),
        // discountPercentage, discountAmount, netFees are server-computed.
        // Revenue is the single active amount field. billed_amount stays legacy/
        // read-only (CRM-012) — never mirrored. See FINANCIAL_FORMULAS.md.
        revenue: nonNegativeMoney.optional(),
        collectedAmount: nonNegativeMoney.optional(),
        // outstandingAmount is server-computed; remainingAdvanced is legacy/read-only.
        collectionStatus: z.enum(["Not Billed", "Partially Billed", "Billed", "Partially Collected", "Fully Collected", "Overdue"]).optional(),
        billingDate: z.string().optional(),
        paymentDate: z.string().optional(),
        invoiceNumber: z.string().optional(),
        responsibleLawyer: z.string().optional(),
        // Responsible Lawyer user link: number assigns/validates, null unlinks.
        responsibleLawyerId: z.number().int().positive().nullable().optional(),
        financeNotes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        // Rejected clients are locked: existing financial records are read-only.
        await db.assertFinancialRecordClientNotRejected(id);
        // OWN_PRACTICE: validate BOTH the current and the proposed practice — a
        // HoP cannot edit another practice's record, nor move a record into/out of
        // their practice via clientMatterId. Fetch the record under scope first.
        const existing = await db.getFinancialRecordById(id, ctx.user!);
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Financial record not found." });
        const proposedMatterId = data.clientMatterId !== undefined ? data.clientMatterId : existing.clientMatterId;
        await assertOwnPracticeWrite(
          ctx.user!, "financial:edit",
          await financialRecordPracticeKey(existing.clientId, proposedMatterId),
          await financialRecordPracticeKey(existing.clientId, existing.clientMatterId),
        );
        return db.updateFinancialRecord(id, data as any, ctx.user!.id);
      }),

    delete: capabilityProcedure("financial:delete")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.assertFinancialRecordClientNotRejected(input.id);
        const existing = await db.getFinancialRecordById(input.id, ctx.user!);
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Financial record not found." });
        await assertOwnPracticeWrite(
          ctx.user!, "financial:delete",
          await financialRecordPracticeKey(existing.clientId, existing.clientMatterId),
        );
        await db.deleteFinancialRecord(input.id);
        return { success: true };
      }),

    summary: capabilityProcedure("financial:view").query(async ({ ctx }) => {
      if (ctx.user!.role === "coordinator") {
        throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
      }
      return db.getFinancialSummary(ctx.user!);
    }),

    toBeBilledBreakdown: capabilityProcedure("financial:view").query(async ({ ctx }) => {
      if (ctx.user!.role === "coordinator") {
        throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
      }
      return db.getToBeBilledBreakdown(ctx.user!);
    }),

    // Read-only audit trail for a specific financial record — only if the caller
    // can see the underlying record (same scope as detail).
    auditLog: capabilityProcedure("financial:view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        if (!(await db.getFinancialRecordById(input.id, ctx.user!))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Financial record not found." });
        }
        return db.getFinancialAuditLogs(input.id);
      }),
  }),

  // ─── Financial Reporting (central service, shared filter schema) ────────────
  // Every endpoint accepts the SAME filter object and aggregates from the SAME
  // one-row-per-financial-record dataset (server/financialReports.ts), so KPI
  // cards, grouped reports, detail tables, and exports always reconcile.
  // Gated by financial:view — identical exposure to the existing financial
  // module (admin / manager / partner / finance). Not widened.

  financialReports: router({
    summary: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getReportSummary(input, ctx.user!)),

    byLawyer: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getRevenueByLawyer(input, ctx.user!)),

    byLeadPartner: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getRevenueByLeadPartner(input, ctx.user!)),

    byHeadOfPractice: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getRevenueByHeadOfPractice(input, ctx.user!)),

    byClient: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getRevenueByClient(input, ctx.user!)),

    byMatter: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getRevenueByMatter(input, ctx.user!)),

    outstandingByLawyer: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getOutstandingByLawyer(input, ctx.user!)),

    toBeBilledByLawyer: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getToBeBilledByLawyer(input, ctx.user!)),

    collectedByLawyer: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getCollectedByLawyer(input, ctx.user!)),

    discountReport: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getDiscountReport(input, ctx.user!)),

    invoiceStatus: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getInvoiceStatusReport(input, ctx.user!)),

    overdue: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema)
      .query(async ({ input, ctx }) => financialReports.getOverdueReport(input, ctx.user!)),

    details: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema.extend({
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().positive().max(200).default(25),
      }))
      .query(async ({ input, ctx }) => {
        const { page, pageSize, ...filters } = input;
        return financialReports.getReportDetails(filters, page, pageSize, ctx.user!);
      }),

    // CSV export — same filters + same calculation functions as the screen, and
    // the SAME actor scope (so an export never contains rows the screen hides).
    export: capabilityProcedure("financialReports:view")
      .input(reportFilterSchema.extend({
        reportType: z.enum(EXPORT_REPORT_TYPES),
      }))
      .mutation(async ({ input, ctx }) => {
        const { reportType, ...filters } = input;
        return financialReports.exportReportCsv(reportType, filters, ctx.user!);
      }),
  }),

  // ─── System Settings ───────────────────────────────────────────────────────
  // getOverdueDays: readable by any financial:view user (needed for UI copy).
  // update: admin-only to prevent non-admins from changing business thresholds.

  settings: router({
    getOverdueDays: permissionProcedure("financial:view")
      .query(async () => db.getOverdueDays()),

    update: adminProcedure
      .input(z.object({
        key:   z.string().min(1).max(100),
        value: z.string().min(1).max(500),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.upsertSystemSetting(input.key, input.value, ctx.user!.id);
        return { success: true };
      }),
  }),

  // ─── Practices (Head-of-Practice model — Phase 5) ──────────────────────────
  // Read-only classification report: which client rows map to a practice with an
  // appointed head (writable under OWN_PRACTICE) vs. unclassified (read-only until
  // a controlled step appoints a head). Admin-only ops view; no rows are modified.
  practices: router({
    classification: adminProcedure.query(async () => getClientPracticeClassification()),
  }),

  // ─── Client Action Logs ────────────────────────────────────────────────────

  clientActions: router({
    list: permissionProcedure("actions:view")
      .input(z.object({ clientId: z.number().optional() }).optional())
      .query(async ({ input }) => db.getClientActionLogs(input?.clientId)),

    create: permissionProcedure("actions:manage")
      .input(z.object({
        clientId: z.number(),
        clientMatterId: z.number().optional(),
        actionOwner: z.string().optional(),
        nextStep: z.string().optional(),
        actionDate: z.string().optional(),
        actionType: z.string().optional(),
        actionDetails: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // Rejected clients are locked: no new actions/tasks under them.
        await db.assertClientNotRejected(input.clientId);
        return db.createClientActionLog(input as any, ctx.user!.id);
      }),

    update: permissionProcedure("actions:manage")
      .input(z.object({
        id: z.number(),
        actionOwner: z.string().optional(),
        nextStep: z.string().optional(),
        actionDate: z.string().optional(),
        actionType: z.string().optional(),
        actionDetails: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        await db.assertActionClientNotRejected(id);
        return db.updateClientActionLog(id, data as any, ctx.user!.id);
      }),

    delete: permissionProcedure("actions:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.assertActionClientNotRejected(input.id);
        await db.deleteClientActionLog(input.id);
        return { success: true };
      }),
  }),

  // ─── Excel Import ──────────────────────────────────────────────────────────

  import: router({
    clients: permissionProcedure("clients:manage")
      .input(z.object({
        rows: z.array(z.object({
          clientNumber: z.string().optional(),
          fileNumber: z.string().optional(),
          clientName: z.string().optional(),
          clientStatus: z.string().optional(),
          city: z.string().optional(),
          matterType: z.string().optional(),
        })),
      }))
      .mutation(async ({ input, ctx }) => db.importClients(input.rows, ctx.user!.id)),
  }),

  // ─── Contact / Chat Submissions ───────────────────────────────────────────

  // Chat submissions are inbound enquiries: reading follows lead visibility and
  // working them (status changes) follows lead management.
  chat: router({
    list: permissionProcedure("leads:view").query(async () => db.getAllChatSubmissions()),

    submit: publicProcedure
      .input(z.object({
        name: z.string().min(1),
        email: z.string().email().optional().or(z.literal("")),
        phone: z.string().optional(),
        subject: z.string().optional(),
        message: z.string().min(1),
      }))
      .mutation(async ({ input }) => {
        return db.createChatSubmission(input);
      }),

    updateStatus: permissionProcedure("leads:manage")
      .input(z.object({
        id: z.number(),
        status: z.enum(["new", "read", "replied", "converted"]),
      }))
      .mutation(async ({ input }) => {
        await db.updateChatSubmissionStatus(input.id, input.status);
        return { success: true };
      }),
  }),

  // ─── AI Assistant (NVIDIA NIM) ──────────────────────────────────────────────
  // The full management assistant (ai.ask) is added in the next phase. For now,
  // an admin-only connectivity check verifies the server-side key works before
  // we build the UI. Equivalent to the requested POST /api/ai/test-nvidia, but
  // expressed as a tRPC procedure (this project's API layer is tRPC at
  // /api/trpc). adminProcedure enforces admin-only access; the result reports
  // success/failure and NEVER includes the API key.
  ai: router({
    // Admin-only connectivity check (POST /api/ai/test-nvidia equivalent).
    testNvidia: adminProcedure.mutation(async () => testNvidiaConnection()),

    // Management AI Assistant (POST /api/ai/ask equivalent). RBAC-gated by
    // "ai:assistant" (admin/manager/partner/lawyer/finance). The model receives
    // ONLY role-scoped structured JSON from safe read-only analytics — never the
    // database, never SQL, never the API key.
    ask: permissionProcedure("ai:assistant")
      .input(z.object({
        question: z.string().trim().min(1).max(2000),
        period: z.enum(["month", "quarter", "year", "all"]).default("month"),
      }))
      .mutation(async ({ input, ctx }) => {
        const user = ctx.user!;

        // Rate limit per user to prevent abuse.
        const rl = checkAiRateLimit(user.id);
        if (!rl.allowed) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Too many AI requests. Please wait a moment and try again.",
          });
        }

        // Gather only the data this role may use. The AI cannot reach anything else.
        const { data, scope } = await gatherCrmData({ id: user.id, role: user.role }, input.period);

        // Audit the question + scope used (NOT the answer, NOT the raw payload).
        await db.createAiAuditLog({
          userId: user.id,
          question: input.question,
          period: input.period,
          dataScopeUsed: scope.sections.join(","),
          model: AI_MODEL_NAME,
        }).catch(() => { /* never block the request on audit write */ });

        // Call NVIDIA; ANY failure (incl. missing key / timeout) → safe fallback.
        let answer: string;
        let ok = true;
        try {
          const result = await callNvidiaChat({
            messages: buildAiMessages(input.question, data, input.period),
            maxTokens: 4096,
            temperature: 0.2,
            topP: 0.95,
            timeoutMs: 30_000,
          });
          answer = (result.content ?? "").trim() || NVIDIA_UNAVAILABLE_MESSAGE;
          if (answer === NVIDIA_UNAVAILABLE_MESSAGE) ok = false;
        } catch (err: any) {
          ok = false;
          answer = NVIDIA_UNAVAILABLE_MESSAGE;
          // Key-safe diagnostic in server logs (status + redacted detail, no key).
          const status = err?.status ?? "n/a";
          const detail = String(err?.detail ?? err?.message ?? "").slice(0, 200);
          console.warn(`[AI] ask failed (status=${status}): ${detail}`);
        }

        // dataScope lists section NAMES only (no raw values leave the server here).
        return { ok, answer, period: input.period, dataScope: scope.sections };
      }),

    // Admin-only access to the AI audit trail (access control on stored records).
    auditLog: adminProcedure
      .input(z.object({ limit: z.number().int().positive().max(500).default(100) }).optional())
      .query(async ({ input }) => db.getAiAuditLogs(input?.limit ?? 100)),
  }),
});

export type AppRouter = typeof appRouter;
