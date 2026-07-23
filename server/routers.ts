import { systemRouter } from "./_core/systemRouter";
import {
  publicProcedure,
  router,
  protectedProcedure,
  adminProcedure,
  capabilityProcedure,
  anyCapabilityProcedure,
} from "./_core/trpc";
import { AUTH_COOKIE, createSessionToken, verifyPassword, hashPassword, isSecureRequest } from "./_core/auth";
import { TRPCError } from "@trpc/server";
import type { Request } from "express";
import { z } from "zod";
import * as db from "./db";
import { testNvidiaConnection, callNvidiaChat, NVIDIA_UNAVAILABLE_MESSAGE } from "./_core/nvidia";
import {
  gatherCrmData, buildAiMessages, checkAiRateLimit, AI_MODEL_NAME,
} from "./aiAnalytics";
import { USER_STATUSES, MATTER_TYPES, CITY_VALUES, type UserStatus } from "../shared/const";
import { ACCOUNT_ROLES, can, scopeFor } from "../shared/permissions";
import { ASSIGNMENT_FIELD_NAMES, type AssignmentField } from "../shared/assignmentEligibility";
import * as financialReports from "./financialReports";
import { reportFilterSchema, EXPORT_REPORT_TYPES } from "./financialReports";

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

// User Management accepts ONLY the 11 canonical account roles. Legacy values
// (partner, lawyer, staff, viewer) remain readable on existing rows but can no
// longer be assigned; lead_lawyer is a per-matter designation, never a role.
const roleSchema = z.enum(ACCOUNT_ROLES);
const statusSchema = z.enum(USER_STATUSES);

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

type SessionUser = { id: number; role: string };

/**
 * Notes annotate other records; reading/writing a note requires access to the
 * record it is attached to (no secondary-endpoint leaks). Unknown entity
 * types are admin-only.
 */
async function assertNoteEntityAccess(
  user: SessionUser,
  entityType: string,
  entityId: number,
  mode: "view" | "write",
) {
  if (user.role === "admin") return;
  switch (entityType) {
    case "lead": {
      const ok =
        mode === "view"
          ? can(user.role, "enquiries.view") || can(user.role, "enquiries.manage")
          : can(user.role, "enquiries.manage");
      if (!ok) throw new TRPCError({ code: "FORBIDDEN", message: "No access to this enquiry." });
      return;
    }
    case "matter": {
      if (mode === "write") {
        await db.assertCanEditLegacyMatter(user, entityId);
      } else {
        const m = await db.getMatterById(entityId, user);
        if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Matter not found." });
      }
      return;
    }
    case "client_matter": {
      if (mode === "write") {
        await db.assertCanEditClientMatter(user, entityId);
      } else {
        const m = await db.getClientMatterByIdScoped(entityId, user);
        if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Matter not found." });
      }
      return;
    }
    case "task": {
      await db.assertTaskVisible(entityId, user);
      return;
    }
    case "company": {
      const ok =
        mode === "view"
          ? can(user.role, "matters.view") ||
            can(user.role, "enquiries.view") ||
            can(user.role, "enquiries.manage")
          : can(user.role, "enquiries.manage") || can(user.role, "matters.create");
      if (!ok) throw new TRPCError({ code: "FORBIDDEN", message: "No access to this company." });
      return;
    }
    default:
      throw new TRPCError({ code: "FORBIDDEN", message: "No access to this record type." });
  }
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
    stats: capabilityProcedure("dashboard.view").query(async ({ ctx }) => {
      return db.getDashboardStats(ctx.user!);
    }),

    recentActivity: capabilityProcedure("dashboard.view")
      .input(z.object({ limit: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        return db.getRecentActivity(input.limit ?? 20, ctx.user!);
      }),
  }),

  // ─── Leads ────────────────────────────────────────────────────────────────

  // The Enquiries Log (BR-15): Coordinator creates/manages; Head of Practice
  // and Manager view; Admin has full control. Other roles have no access.
  leads: router({
    list: anyCapabilityProcedure(["enquiries.view", "enquiries.manage"])
      .input(z.object({
        channelType: z.string().optional(),
        channelMedium: z.string().optional(),
        status: z.string().optional(),
        search: z.string().optional(),
        assignedTo: z.number().optional(),
      }).optional())
      .query(async ({ input }) => db.getAllLeads(input ?? {})),

    // Distinct channel values for filter dropdowns.
    channelOptions: anyCapabilityProcedure(["enquiries.view", "enquiries.manage"]).query(async () => db.getLeadChannelOptions()),

    get: anyCapabilityProcedure(["enquiries.view", "enquiries.manage"])
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => db.getLeadById(input.id)),

    create: capabilityProcedure("enquiries.manage")
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

    update: capabilityProcedure("enquiries.manage")
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

    // Deleting enquiries is Admin-only (Excel matrix: Full = Admin;
    // Coordinator holds create/edit only).
    delete: capabilityProcedure("enquiries.delete")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteLead(input.id);
        return { success: true };
      }),

    statusSummary: anyCapabilityProcedure(["enquiries.view", "enquiries.manage"]).query(async () => db.getLeadStatusSummary()),
  }),

  // ─── Matters ──────────────────────────────────────────────────────────────

  // Legacy standalone matters module (`matters` table, single assigned_to FK).
  // Same capability set as client matters; legacy rows carry no city/matter
  // type, so OWN_PRACTICE (Head of Practice) cannot be resolved and resolves
  // to "no practice" — view-all, but no create/edit on this legacy module.
  matters: router({
    list: capabilityProcedure("matters.view").query(async ({ ctx }) => db.getAllMatters(ctx.user!)),

    get: capabilityProcedure("matters.view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => db.getMatterById(input.id, ctx.user!)),

    create: capabilityProcedure("matters.create")
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
        if (ctx.authzScope === "OWN_PRACTICE") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Legacy matters carry no practice (city + matter type); own-practice roles cannot create them.",
          });
        }
        // Assignment is an authorization-defining field: validate the assignee
        // is a real, active user (initial assignment at creation is allowed).
        if (input.assignedTo != null) await db.assertActiveUser(input.assignedTo, "assignee");
        return db.createMatter(input, ctx.user!.id);
      }),

    update: capabilityProcedure("matters.edit")
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
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        const existing = await db.assertCanEditLegacyMatter(ctx.user!, id);
        // Changing the assignee re-scopes who may access the matter: requires
        // firm-wide team-assignment authority (legacy rows have no practice).
        if (data.assignedTo !== undefined && data.assignedTo !== existing.assignedTo) {
          if (scopeFor(ctx.user!.role, "matters.assignTeam") !== "ALL") {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Changing the assigned lawyer requires team-assignment authority.",
            });
          }
          if (data.assignedTo != null) await db.assertActiveUser(data.assignedTo, "assignee");
        }
        return db.updateMatter(id, data);
      }),

    delete: capabilityProcedure("matters.delete")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteMatter(input.id);
        return { success: true };
      }),
  }),

  // ─── Tasks ────────────────────────────────────────────────────────────────

  tasks: router({
    list: capabilityProcedure("tasks.view")
      .input(z.object({
        matterId: z.number().optional(),
        assignedTo: z.number().optional(),
        status: z.string().optional(),
        clientId: z.number().optional(),
        clientMatterId: z.number().optional(),
      }).optional())
      // Visibility is enforced server-side from the session user (role + id).
      .query(async ({ input, ctx }) => db.getAllTasks(input ?? {}, ctx.user!)),

    get: capabilityProcedure("tasks.view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => db.getTaskById(input.id, ctx.user!)),

    create: capabilityProcedure("tasks.update")
      .input(z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        matterId: z.number().optional(),
        leadId: z.number().optional(),
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
        // Rejected clients are locked: no new tasks under them.
        await db.assertClientNotRejected(input.clientId);
        // BR-10: assigning to ANOTHER user requires tasks.assign (or the Lead
        // Lawyer overlay for this matter's tasks); assignee validated as an
        // active user.
        await db.assertTaskAssignmentAllowed(ctx.user!, {
          assignedTo: input.assignedTo,
          clientMatterId: input.clientMatterId,
        });
        return db.createTask(input, ctx.user!.id);
      }),

    update: capabilityProcedure("tasks.update")
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        matterId: z.number().optional(),
        clientMatterId: z.number().nullable().optional(),
        assignedTo: z.number().optional(),
        dueDate: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        // Can only modify a task the viewer is allowed to see.
        const existing = await db.assertTaskVisible(id, ctx.user!);
        // Re-assigning to another user requires assignment authority.
        if (data.assignedTo !== undefined && data.assignedTo !== existing.assignedTo) {
          await db.assertTaskAssignmentAllowed(ctx.user!, {
            assignedTo: data.assignedTo,
            clientMatterId: data.clientMatterId !== undefined ? data.clientMatterId : existing.clientMatterId,
          });
        }
        return db.updateTask(id, data);
      }),

    // Deleting tasks is Admin-only (Excel matrix: tasks are Edit for all other
    // task-capable roles, Full only for Admin).
    delete: capabilityProcedure("tasks.delete")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.assertTaskVisible(input.id, ctx.user!);
        await db.deleteTask(input.id);
        return { success: true };
      }),
  }),

  // ─── Notes ────────────────────────────────────────────────────────────────

  notes: router({
    // Notes follow the visibility of the entity they annotate; private notes
    // are author-only (admin excepted) — both enforced in db.getNotesByEntity
    // and assertNoteEntityAccess.
    byEntity: protectedProcedure
      .input(z.object({ entityType: z.string(), entityId: z.number() }))
      .query(async ({ input, ctx }) => {
        await assertNoteEntityAccess(ctx.user!, input.entityType, input.entityId, "view");
        return db.getNotesByEntity(input.entityType, input.entityId, ctx.user!);
      }),

    create: protectedProcedure
      .input(z.object({
        content: z.string().min(1),
        entityType: z.string(),
        entityId: z.number(),
        matterId: z.number().optional(),
        leadId: z.number().optional(),
        isPrivate: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await assertNoteEntityAccess(ctx.user!, input.entityType, input.entityId, "write");
        return db.createNote({ ...input, createdBy: ctx.user.id });
      }),

    // Author-or-admin only (enforced in db.deleteNote).
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.deleteNote(input.id, ctx.user!);
        return { success: true };
      }),
  }),

  // ─── Payments ─────────────────────────────────────────────────────────────

  // Payments are financial data linked to enquiries (no matter link exists on
  // this legacy table): reads require FIRM-WIDE financial visibility
  // (assigned-matter financial scopes cannot be resolved for lead-level rows);
  // writes require firm-wide financial edit rights (admin, finance). This also
  // fixes the pre-existing gap where a *view* permission gated the mutations.
  payments: router({
    list: capabilityProcedure("financial.view").query(async ({ ctx }) => {
      if (ctx.authzScope !== "ALL") {
        throw new TRPCError({ code: "FORBIDDEN", message: "No firm-wide financial access." });
      }
      return db.getAllPayments();
    }),

    getByLead: capabilityProcedure("financial.view")
      .input(z.object({ leadId: z.number() }))
      .query(async ({ input, ctx }) => {
        if (ctx.authzScope !== "ALL") {
          throw new TRPCError({ code: "FORBIDDEN", message: "No firm-wide financial access." });
        }
        return db.getPaymentByLeadId(input.leadId);
      }),

    create: capabilityProcedure("financial.edit")
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
      .mutation(async ({ input, ctx }) => {
        if (ctx.authzScope !== "ALL") {
          throw new TRPCError({ code: "FORBIDDEN", message: "No firm-wide financial access." });
        }
        return db.createPayment(input);
      }),

    update: capabilityProcedure("financial.edit")
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
      .mutation(async ({ input, ctx }) => {
        if (ctx.authzScope !== "ALL") {
          throw new TRPCError({ code: "FORBIDDEN", message: "No firm-wide financial access." });
        }
        const { id, ...data } = input;
        return db.updatePayment(id, data);
      }),
  }),

  // ─── Companies ────────────────────────────────────────────────────────────

  // Companies back the enquiry/legacy-matter forms: reads for roles that can
  // view matters or the enquiries log; writes for intake managers and matter
  // creators (was: any active user — pre-existing gap).
  companies: router({
    list: anyCapabilityProcedure(["matters.view", "enquiries.view", "enquiries.manage"])
      .query(async () => db.getAllCompanies()),

    create: anyCapabilityProcedure(["enquiries.manage", "matters.create"])
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
        return db.createCompany({ ...input, createdBy: ctx.user.id });
      }),

    update: anyCapabilityProcedure(["enquiries.manage", "matters.create"])
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

    // Active users who may be assigned to a matter as lead/co-lawyers.
    // Directory-only data (name/role) for populating user pickers; available
    // to matter viewers (no free-text names anywhere).
    assignableLawyers: capabilityProcedure("matters.view")
      .query(async () => db.getAssignableLawyers()),

    // Active Lead-Lawyer-eligible users for the "Suggested Lead Lawyer" dropdown.
    leadLawyers: anyCapabilityProcedure(["enquiries.view", "enquiries.manage"])
      .query(async () => db.getLeadLawyers()),

    // Users eligible for a NEW assignment to a specific lawyer field (Matter
    // forms, Financial Records). Active + role-eligible only, filtered
    // server-side per shared/assignmentEligibility.ts. matters.view so every
    // role that can open these forms (incl. finance) can populate dropdowns.
    eligibleLawyers: capabilityProcedure("matters.view")
      .input(z.object({
        field: z.enum(ASSIGNMENT_FIELD_NAMES as [AssignmentField, ...AssignmentField[]]),
      }))
      .query(async ({ input }) => db.getEligibleLawyers(input.field)),

    // Active users a task can be assigned to; only for roles that can assign
    // tasks to others (BR-10) or that lead at least one matter (overlay).
    assignees: capabilityProcedure("tasks.view")
      .query(async ({ ctx }) => {
        if (!can(ctx.user!.role, "tasks.assign") && !(await db.userLeadsAnyMatter(ctx.user!))) {
          return [];
        }
        return db.getActiveAssignableUsers();
      }),

    create: adminProcedure
      .input(z.object({
        name: z.string().trim().min(1, "Name is required").max(120),
        email: emailSchema,
        password: passwordSchema,
        role: roleSchema.default("trainee"),
        status: statusSchema.default("active"),
        reportsToId: z.number().nullable().optional(), // supervising Head of Practice
      }))
      .mutation(async ({ input, ctx }) => {
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

    // Self or admin only: no probing other users' activity by arbitrary id.
    activityStats: protectedProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input, ctx }) => {
        if (input.userId !== ctx.user.id && ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only view your own activity stats." });
        }
        return db.getUserActivityStats(input.userId);
      }),
  }),

  // ─── Audit Logs ───────────────────────────────────────────────────────────

  auditLogs: router({
    // Change history is as sensitive as the record itself: access requires the
    // corresponding view authority on the underlying entity (record-scoped).
    byEntity: protectedProcedure
      .input(z.object({ entityType: z.string(), entityId: z.number() }))
      .query(async ({ input, ctx }) => {
        return db.getAuditLogsByEntityScoped(input.entityType, input.entityId, ctx.user!);
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
    // Rows are filtered to the viewer's clients.view scope IN SQL; each row
    // carries a server-computed viewerCanEdit flag for the UI.
    list: capabilityProcedure("clients.view").input(z.object({
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

    // Scoped fetch: returns null (not the record) when out of the viewer's
    // scope, so record existence is never revealed by id probing.
    get: capabilityProcedure("clients.view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => db.getClientByIdScoped(input.id, ctx.user!)),

    create: capabilityProcedure("clients.create")
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
        // HoP: only within own practice (city + matter type).
        await db.assertCanCreateClient(ctx.user!, input);
        return db.createClient(input as any, ctx.user!.id);
      }),

    update: capabilityProcedure("clients.edit")
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
        // Re-fetches the record and verifies edit authority + practice bounds
        // on the authorization-defining fields (city, matter type).
        await db.assertCanEditClient(ctx.user!, id, data);
        return db.updateClient(id, data as any, ctx.user!.id);
      }),

    // Deleting clients is Admin-only (Excel matrix: Full = Admin only).
    delete: capabilityProcedure("clients.delete")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteClient(input.id);
        return { success: true };
      }),

    statusCounts: capabilityProcedure("dashboard.view").query(async ({ ctx }) => db.getClientStatusCounts(ctx.user!)),

    dashboardStats: capabilityProcedure("dashboard.view").query(async ({ ctx }) => db.getClientDashboardStats(ctx.user!)),

    conversionMetrics: capabilityProcedure("dashboard.view")
      .input(z.object({ range: z.enum(["month", "quarter", "all"]).default("all") }).optional())
      .query(async ({ input, ctx }) => {
        // Conversion KPIs aggregate the firm-wide intake funnel; they require
        // firm-wide/registry client visibility (matrix: Dashboard V(Asgn)
        // covers own-scope data only).
        const clientScope = scopeFor(ctx.user!.role, "clients.view");
        if (clientScope !== "ALL" && clientScope !== "REGISTRY") {
          return {
            range: input?.range ?? "all",
            period: input?.range ?? "all",
            totalLeads: 0, convertedLeads: 0, convertedClients: 0, converted: 0,
            totalIntake: 0, total: 0, totalEnquiries: 0,
            sourceBreakdown: { lead: 0, enquiry: 0, direct: 0 },
            conversionRate: 0,
            restricted: true,
          };
        }
        return db.getClientConversionMetrics(input?.range ?? "all");
      }),

    // Recent Lead-status clients within the last N days (default 30), newest first.
    // Powers the dashboard "Recent Leads" widget; date window uses the DB clock.
    recentLeads: capabilityProcedure("clients.view")
      .input(z.object({
        days: z.number().int().positive().max(365).default(30),
        limit: z.number().int().positive().max(50).default(5),
      }).optional())
      .query(async ({ input, ctx }) => db.getRecentLeads(input?.days ?? 30, input?.limit ?? 5, ctx.user!)),

    // Lead details sub-resource (registry data; follows client visibility).
    getLeadDetail: capabilityProcedure("clients.view")
      .input(z.object({ clientId: z.number() }))
      .query(async ({ input, ctx }) => {
        const client = await db.getClientByIdScoped(input.clientId, ctx.user!);
        if (!client) return null;
        return db.getClientLeadDetail(input.clientId);
      }),

    upsertLeadDetail: capabilityProcedure("clients.edit")
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
      .mutation(async ({ input, ctx }) => {
        const { clientId, ...data } = input;
        await db.assertCanEditClient(ctx.user!, clientId);
        db.validateChannel(data.channelType, data.channelMedium, { requireType: false });
        // assignedLawyerId is an assignment field: validate it references an
        // active, lead-lawyer-eligible user (never trusted raw).
        if (data.assignedLawyerId != null) await db.assertLeadLawyer(data.assignedLawyerId);
        return db.upsertClientLeadDetail(clientId, data as any);
      }),

    // Rejected details sub-resource
    getRejectedDetail: capabilityProcedure("clients.view")
      .input(z.object({ clientId: z.number() }))
      .query(async ({ input, ctx }) => {
        const client = await db.getClientByIdScoped(input.clientId, ctx.user!);
        if (!client) return null;
        return db.getRejectedClientDetail(input.clientId);
      }),

    upsertRejectedDetail: capabilityProcedure("clients.edit")
      .input(z.object({
        clientId: z.number(),
        rejectionReasonSource: z.enum(["Client", "Us"]).optional(),
        rejectionNotes: z.string().optional(),
        rejectedBy: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { clientId, ...data } = input;
        await db.assertCanEditClient(ctx.user!, clientId);
        return db.upsertRejectedClient(clientId, data as any);
      }),

    // Conflict-of-interest search spans the whole firm by nature; restricted
    // to roles that intake clients/matters (client or matter creators).
    conflictCheck: anyCapabilityProcedure(["clients.create", "matters.create"])
      .input(z.object({ query: z.string().min(1).max(255) }))
      .query(async ({ input }) => db.searchConflicts(input.query)),
  }),

  // ─── Client Matters ────────────────────────────────────────────────────────

  clientMatters: router({
    // Matters for one client, filtered to the viewer's matters.view scope in
    // SQL. Each row carries server-computed viewerCanEdit/viewerIsLeadLawyer.
    list: capabilityProcedure("matters.view")
      .input(z.object({ clientId: z.number() }))
      .query(async ({ input, ctx }) => db.getClientMatters(input.clientId, ctx.user!)),

    // Lead + co-lawyers billable on a matter, each with their effective hourly
    // rate. Rate amounts are financial data: firm-wide financial viewers, plus
    // the matter team (lead/assigned lawyers see their own matter's rates).
    billableLawyers: capabilityProcedure("matters.view")
      .input(z.object({ clientMatterId: z.number() }))
      .query(async ({ input, ctx }) => {
        const matter = await db.getClientMatterByIdScoped(input.clientMatterId, ctx.user!);
        if (!matter) throw new TRPCError({ code: "NOT_FOUND", message: "Matter not found." });
        return db.getMatterBillableLawyers(input.clientMatterId);
      }),

    // Controlled "Reassign Lead Lawyer" action. Lead Lawyer is an
    // authorization-defining designation: requires matters.assignTeam (Admin
    // firm-wide; Head of Practice within own practice — enforced via the
    // field-level guard on leadLawyerId).
    reassignLeadLawyer: capabilityProcedure("matters.assignTeam")
      .input(z.object({ clientMatterId: z.number(), userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.assertMatterClientNotRejected(input.clientMatterId);
        await db.assertCanEditClientMatter(ctx.user!, input.clientMatterId, {
          leadLawyerId: input.userId,
        });
        return db.reassignLeadLawyer(input.clientMatterId, input.userId, ctx.user!.id);
      }),

    // Conflict check for a (prospective) matter — by matter name and/or opposing
    // party. Used by the Create Matter form before submitting.
    checkConflicts: anyCapabilityProcedure(["clients.create", "matters.create"])
      .input(z.object({
        matterName: z.string().optional(),
        opposingParty: z.string().optional(),
        // Owning client of the prospective matter — scopes out cross-client
        // Matter Reference matches (different clients may reuse a reference).
        clientId: z.number().optional(),
      }))
      .query(async ({ input }) =>
        db.checkMatterConflicts({
          matterName: input.matterName,
          opposingParty: input.opposingParty,
          clientId: input.clientId,
        }),
      ),

    listAll: capabilityProcedure("matters.view")
      .input(z.object({ status: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => db.getAllClientMatters(input ?? {}, ctx.user!)),

    get: capabilityProcedure("matters.view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => db.getClientMatterByIdScoped(input.id, ctx.user!)),

    create: capabilityProcedure("matters.create")
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
        // HoP may only create matters within own practice (client city +
        // matter type). Initial team assignment at creation is permitted for
        // any creator; assignees are validated as active + role-eligible.
        await db.assertCanCreateClientMatter(ctx.user!, matterInput);
        // Rejected clients are locked: no new matters.
        await db.assertClientNotRejected(matterInput.clientId);
        // Backend enforcement (defense in depth): re-run the conflict check and
        // refuse to create unless the user has acknowledged any matches.
        const conflicts = await db.checkMatterConflicts({
          matterName: matterInput.matterReference,
          opposingParty: matterInput.opposingParty,
          clientId: matterInput.clientId,
        });
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

    update: capabilityProcedure("matters.edit")
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
        // Rejected clients are locked: existing matters are read-only.
        await db.assertMatterClientNotRejected(id);
        // Re-fetch + verify: edit authority on THIS matter, and field-level
        // authorization for the scope-defining fields (lead lawyer, team FKs,
        // matter type) — "edit matter details" never includes those.
        await db.assertCanEditClientMatter(ctx.user!, id, data);
        return db.updateClientMatter(id, data as any, ctx.user!.id);
      }),

    // Deleting matters is Admin-only (Excel matrix: Full = Admin only).
    delete: capabilityProcedure("matters.delete")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.assertMatterClientNotRejected(input.id);
        await db.deleteClientMatter(input.id);
        return { success: true };
      }),
  }),

  // ─── Matter Lawyer Rates ───────────────────────────────────────────────────

  // Hourly rates are financial data tied to a matter: reads follow financial
  // visibility (with the Lead Lawyer overlay for the led matter); writes are
  // financial mutations (admin/finance firm-wide, HoP own practice).
  matterLawyerRates: router({
    list: capabilityProcedure("financial.view", { allowLeadLawyerOverlay: true })
      .input(z.object({ clientMatterId: z.number() }))
      .query(async ({ input, ctx }) => {
        const matter = await db.getClientMatterByIdScoped(input.clientMatterId, ctx.user!);
        if (!matter) throw new TRPCError({ code: "NOT_FOUND", message: "Matter not found." });
        if (ctx.authzScope === "NONE") {
          // Overlay path: only the matter's designated Lead Lawyer.
          if (!(await db.hasLeadLawyerAuthority(ctx.user!, input.clientMatterId))) {
            throw new TRPCError({ code: "FORBIDDEN", message: "No financial access to this matter." });
          }
        }
        return db.getMatterLawyerRates(input.clientMatterId);
      }),

    create: capabilityProcedure("financial.create")
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
        await db.assertCanMutateMatterRates(ctx.user!, input.clientMatterId, "create");
        return db.createMatterLawyerRate(input as any, ctx.user!.id);
      }),

    update: capabilityProcedure("financial.edit")
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
        const rate = await db.getMatterLawyerRateById(id);
        if (!rate) throw new TRPCError({ code: "NOT_FOUND", message: "Rate not found." });
        await db.assertCanMutateMatterRates(ctx.user!, rate.clientMatterId, "edit");
        return db.updateMatterLawyerRate(id, data as any, ctx.user!.id);
      }),

    // Rate deletion follows financial.delete (admin, finance — pre-existing
    // financial delete surface; no new delete rights invented).
    delete: capabilityProcedure("financial.delete")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.assertRateClientNotRejected(input.id);
        await db.deleteMatterLawyerRate(input.id);
        return { success: true };
      }),
  }),

  // ─── Financial Records ─────────────────────────────────────────────────────

  financial: router({
    // Reads allow the Lead Lawyer overlay (an eligible lawyer designated Lead
    // Lawyer sees the led matter's records read-only, BR-04); rows are always
    // filtered to the viewer's financial scope in SQL.
    list: capabilityProcedure("financial.view", { allowLeadLawyerOverlay: true })
      .input(z.object({
        clientId: z.number().optional(),
        clientMatterId: z.number().optional(),
        collectionStatus: z.string().optional(),
      }).optional())
      .query(async ({ input, ctx }) => db.getFinancialRecords(input ?? {}, ctx.user!)),

    get: capabilityProcedure("financial.view", { allowLeadLawyerOverlay: true })
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => db.getFinancialRecordByIdScoped(input.id, ctx.user!)),

    create: capabilityProcedure("financial.create")
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
        // BR-06: admin/finance firm-wide; Head of Practice own practice only.
        await db.assertCanCreateFinancialRecord(ctx.user!, input);
        // Rejected clients are locked: no new financial records.
        await db.assertClientNotRejected(input.clientId);
        return db.createFinancialRecord(input as any, ctx.user!.id);
      }),

    update: capabilityProcedure("financial.edit")
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
        // Re-fetch + verify edit authority (HoP: own practice, incl. re-link
        // targets). Lead Lawyer authority NEVER grants financial mutations.
        await db.assertCanMutateFinancialRecord(ctx.user!, id, "edit", data);
        return db.updateFinancialRecord(id, data as any, ctx.user!.id);
      }),

    // Pre-existing financial delete surface: admin + finance (Excel F-codes).
    delete: capabilityProcedure("financial.delete")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.assertFinancialRecordClientNotRejected(input.id);
        await db.assertCanMutateFinancialRecord(ctx.user!, input.id, "delete");
        await db.deleteFinancialRecord(input.id);
        return { success: true };
      }),

    summary: capabilityProcedure("financial.view", { allowLeadLawyerOverlay: true })
      .query(async ({ ctx }) => db.getFinancialSummary(ctx.user!)),

    toBeBilledBreakdown: capabilityProcedure("financial.view", { allowLeadLawyerOverlay: true })
      .query(async ({ ctx }) => db.getToBeBilledBreakdown(ctx.user!)),

    // Read-only audit trail for a specific financial record — visible only
    // when the record itself is within the viewer's scope.
    auditLog: capabilityProcedure("financial.view", { allowLeadLawyerOverlay: true })
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const record = await db.getFinancialRecordByIdScoped(input.id, ctx.user!);
        if (!record) return [];
        return db.getFinancialAuditLogs(input.id);
      }),
  }),

  // ─── Financial Reporting (central service, shared filter schema) ────────────
  // Every endpoint accepts the SAME filter object and aggregates from the SAME
  // one-row-per-financial-record dataset (server/financialReports.ts), so KPI
  // cards, grouped reports, detail tables, and exports always reconcile.
  // Gated by financialReports.view: Admin, Manager, Head of Practice (BR-14)
  // and Finance (BR-12). Coordinator's read-only financial access does NOT
  // extend to reports (matrix: Financial reports — Coordinator = no access).

  financialReports: router({
    summary: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getReportSummary(input)),

    byLawyer: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getRevenueByLawyer(input)),

    byLeadPartner: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getRevenueByLeadPartner(input)),

    byHeadOfPractice: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getRevenueByHeadOfPractice(input)),

    byClient: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getRevenueByClient(input)),

    byMatter: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getRevenueByMatter(input)),

    outstandingByLawyer: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getOutstandingByLawyer(input)),

    toBeBilledByLawyer: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getToBeBilledByLawyer(input)),

    collectedByLawyer: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getCollectedByLawyer(input)),

    discountReport: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getDiscountReport(input)),

    invoiceStatus: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getInvoiceStatusReport(input)),

    overdue: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema)
      .query(async ({ input }) => financialReports.getOverdueReport(input)),

    details: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema.extend({
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().positive().max(200).default(25),
      }))
      .query(async ({ input }) => {
        const { page, pageSize, ...filters } = input;
        return financialReports.getReportDetails(filters, page, pageSize);
      }),

    // CSV export — same filters + same calculation functions as the screen.
    export: capabilityProcedure("financialReports.view")
      .input(reportFilterSchema.extend({
        reportType: z.enum(EXPORT_REPORT_TYPES),
      }))
      .mutation(async ({ input }) => {
        const { reportType, ...filters } = input;
        return financialReports.exportReportCsv(reportType, filters);
      }),
  }),

  // ─── System Settings ───────────────────────────────────────────────────────
  // getOverdueDays: readable by any financial:view user (needed for UI copy).
  // update: admin-only to prevent non-admins from changing business thresholds.

  settings: router({
    getOverdueDays: capabilityProcedure("financial.view", { allowLeadLawyerOverlay: true })
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

  // ─── Client Action Logs ────────────────────────────────────────────────────

  clientActions: router({
    // Action logs follow client visibility (rows filtered in SQL for
    // ASSIGNED-scope viewers); reading requires client view access.
    list: capabilityProcedure("clients.view")
      .input(z.object({ clientId: z.number().optional() }).optional())
      .query(async ({ input, ctx }) => db.getClientActionLogs(input?.clientId, ctx.user!)),

    // Logging actions: users who can edit the client OR are on the team of one
    // of its matters (assigned lawyers keep operational logging); Manager and
    // other read-only roles are rejected.
    create: capabilityProcedure("clients.view")
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
        await db.assertCanLogClientAction(ctx.user!, input.clientId);
        // Rejected clients are locked: no new actions/tasks under them.
        await db.assertClientNotRejected(input.clientId);
        return db.createClientActionLog(input as any, ctx.user!.id);
      }),

    update: capabilityProcedure("clients.view")
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
        const action = await db.getClientActionLogById(id);
        if (!action) throw new TRPCError({ code: "NOT_FOUND", message: "Action not found." });
        await db.assertCanLogClientAction(ctx.user!, action.clientId);
        await db.assertActionClientNotRejected(id);
        return db.updateClientActionLog(id, data as any, ctx.user!.id);
      }),

    // Deleting action-log entries is Admin-only (matrix F-codes).
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.assertActionClientNotRejected(input.id);
        await db.deleteClientActionLog(input.id);
        return { success: true };
      }),
  }),

  // ─── Excel Import ──────────────────────────────────────────────────────────
  // Bulk import writes clients firm-wide: admin + finance only.

  import: router({
    clients: capabilityProcedure("import.clients")
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
  // Website contact submissions are intake data: enquiry viewers read them,
  // enquiry managers work them (was: any active user — pre-existing gap).

  chat: router({
    list: anyCapabilityProcedure(["enquiries.view", "enquiries.manage"])
      .query(async () => db.getAllChatSubmissions()),

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

    updateStatus: capabilityProcedure("enquiries.manage")
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
    // ai.use (admin/manager/head_of_practice/lawyer grades/finance). The model
    // receives ONLY role-scoped structured JSON from safe read-only analytics —
    // never the database, never SQL, never the API key.
    ask: capabilityProcedure("ai.use")
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

  // ─── Practice Heads (BR-01 ownership map) ────────────────────────────────────
  // Admin-managed mapping (city, matter type) → responsible Head of Practice.
  // This map is what OWN_PRACTICE scoping resolves against. Listing is exposed
  // to authenticated users (names of responsible heads are internal directory
  // data); mutations are settings-level (admin only).

  practices: router({
    list: protectedProcedure.query(async () => db.getPracticeHeads()),

    set: adminProcedure
      .input(z.object({
        city: z.enum(CITY_VALUES),
        matterType: z.enum(MATTER_TYPES),
        headOfPracticeId: z.number().int().positive(),
      }))
      .mutation(async ({ input, ctx }) => db.setPracticeHead(input, ctx.user!.id)),

    remove: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.removePracticeHead(input.id);
        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
