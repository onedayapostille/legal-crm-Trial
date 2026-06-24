import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure, adminProcedure, permissionProcedure } from "./_core/trpc";
import { AUTH_COOKIE, createSessionToken, verifyPassword, hashPassword, isSecureRequest } from "./_core/auth";
import { TRPCError } from "@trpc/server";
import type { Request } from "express";
import { z } from "zod";
import * as db from "./db";
import { testNvidiaConnection, callNvidiaChat, NVIDIA_UNAVAILABLE_MESSAGE } from "./_core/nvidia";
import {
  gatherCrmData, buildAiMessages, checkAiRateLimit, AI_MODEL_NAME,
} from "./aiAnalytics";
import { USER_ROLES, USER_STATUSES, type UserRole, type UserStatus } from "../shared/const";

function formatDbError(err: any) {
  const messages = [err?.message, err?.cause?.message]
    .filter((message): message is string => Boolean(message));
  const code = err?.code ?? err?.cause?.code;
  if (code) messages.push(`code: ${code}`);
  return messages.join(" | ") || String(err);
}

const roleSchema = z.enum(USER_ROLES);
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
      return db.getDashboardStats(ctx.user!);
    }),

    recentActivity: permissionProcedure("dashboard:view")
      .input(z.object({ limit: z.number().optional() }))
      .query(async ({ input }) => {
        return db.getRecentActivity(input.limit ?? 20);
      }),
  }),

  // ─── Leads ────────────────────────────────────────────────────────────────

  leads: router({
    list: permissionProcedure("leads:manage")
      .input(z.object({
        channelType: z.string().optional(),
        channelMedium: z.string().optional(),
        status: z.string().optional(),
        search: z.string().optional(),
        assignedTo: z.number().optional(),
      }).optional())
      .query(async ({ input }) => db.getAllLeads(input ?? {})),

    // Distinct channel values for filter dropdowns.
    channelOptions: permissionProcedure("leads:manage").query(async () => db.getLeadChannelOptions()),

    get: permissionProcedure("leads:manage")
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => db.getLeadById(input.id)),

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
    kpiMetrics: permissionProcedure("analytics:view").query(async ({ ctx }) => db.getLeadKpiMetrics(ctx.user!)),
    pipelineForecast: permissionProcedure("analytics:view").query(async () => db.getPipelineForecast()),
  }),

  // ─── Matters ──────────────────────────────────────────────────────────────

  matters: router({
    list: permissionProcedure("matters:manage").query(async () => db.getAllMatters()),

    get: permissionProcedure("matters:manage")
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => db.getMatterById(input.id)),

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
    list: permissionProcedure("tasks:manage")
      .input(z.object({
        matterId: z.number().optional(),
        assignedTo: z.number().optional(),
        status: z.string().optional(),
        clientId: z.number().optional(),
        clientMatterId: z.number().optional(),
      }).optional())
      // Visibility is enforced server-side from the session user (role + id).
      .query(async ({ input, ctx }) => db.getAllTasks(input ?? {}, ctx.user!)),

    get: permissionProcedure("tasks:manage")
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => db.getTaskById(input.id, ctx.user!)),

    create: permissionProcedure("tasks:manage")
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
        return db.createTask(input, ctx.user!.id);
      }),

    update: permissionProcedure("tasks:manage")
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
        await db.assertTaskVisible(id, ctx.user!);
        return db.updateTask(id, data);
      }),

    delete: permissionProcedure("tasks:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.assertTaskVisible(input.id, ctx.user!);
        await db.deleteTask(input.id);
        return { success: true };
      }),
  }),

  // ─── Notes ────────────────────────────────────────────────────────────────

  notes: router({
    byEntity: protectedProcedure
      .input(z.object({ entityType: z.string(), entityId: z.number() }))
      .query(async ({ input }) => db.getNotesByEntity(input.entityType, input.entityId)),

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
        return db.createNote({ ...input, createdBy: ctx.user.id });
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteNote(input.id);
        return { success: true };
      }),
  }),

  // ─── Payments ─────────────────────────────────────────────────────────────

  payments: router({
    list: permissionProcedure("payments:view").query(async () => db.getAllPayments()),

    getByLead: permissionProcedure("payments:view")
      .input(z.object({ leadId: z.number() }))
      .query(async ({ input }) => db.getPaymentByLeadId(input.leadId)),

    create: permissionProcedure("payments:view")
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

    update: permissionProcedure("payments:view")
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

    create: protectedProcedure
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

    update: protectedProcedure
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

    // Active Partners/Lawyers for the "Suggested Lead Lawyer" dropdown.
    leadLawyers: permissionProcedure("leads:manage")
      .query(async () => db.getLeadLawyers()),

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

    activityStats: protectedProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => db.getUserActivityStats(input.userId)),
  }),

  // ─── Audit Logs ───────────────────────────────────────────────────────────

  auditLogs: router({
    byEntity: protectedProcedure
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
    list: permissionProcedure("clients:view").input(z.object({
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
    }).optional()).query(async ({ input }) => db.getAllClients(input ?? {})),

    get: permissionProcedure("clients:view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => db.getClientById(input.id)),

    create: permissionProcedure("clients:manage")
      .input(z.object({
        clientName: z.string().min(1),
        clientStatus: z.enum(["Existing Client", "Leads", "Rejected"]).default("Leads"),
        convertedFrom: z.enum(["Lead", "Enquiry", "Direct"]).optional(),
        clientNumber: z.string().optional(),
        fileNumber: z.string().optional(),
        city: z.enum(["Riyadh", "Dammam", "Jeddah"]).optional(),
        matterType: z.enum(["Corporate", "Litigation"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => db.createClient(input as any, ctx.user!.id)),

    update: permissionProcedure("clients:manage")
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
        return db.updateClient(id, data as any, ctx.user!.id);
      }),

    delete: permissionProcedure("clients:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteClient(input.id);
        return { success: true };
      }),

    statusCounts: permissionProcedure("dashboard:view").query(async () => db.getClientStatusCounts()),

    dashboardStats: permissionProcedure("dashboard:view").query(async () => db.getClientDashboardStats()),

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

    conflictCheck: permissionProcedure("clients:view")
      .input(z.object({ query: z.string().min(1).max(255) }))
      .query(async ({ input }) => db.searchConflicts(input.query)),
  }),

  // ─── Client Matters ────────────────────────────────────────────────────────

  clientMatters: router({
    list: permissionProcedure("clients:view")
      .input(z.object({ clientId: z.number() }))
      .query(async ({ input }) => db.getClientMatters(input.clientId)),

    // Lead + co-lawyers billable on a matter, each with their effective hourly
    // rate. The source of truth for the Hourly Rate section and billing logic.
    billableLawyers: permissionProcedure("clients:view")
      .input(z.object({ clientMatterId: z.number() }))
      .query(async ({ input }) => db.getMatterBillableLawyers(input.clientMatterId)),

    // Controlled "Reassign Lead Lawyer" action — restricted to Admin/Partner via
    // the matters:assign_lawyer permission. The name is derived from the user.
    reassignLeadLawyer: permissionProcedure("matters:assign_lawyer")
      .input(z.object({ clientMatterId: z.number(), userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.assertMatterClientNotRejected(input.clientMatterId);
        return db.reassignLeadLawyer(input.clientMatterId, input.userId, ctx.user!.id);
      }),

    // Conflict check for a (prospective) matter — by matter name and/or opposing
    // party. Used by the Create Matter form before submitting.
    checkConflicts: permissionProcedure("clients:view")
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

    listAll: permissionProcedure("clients:view")
      .input(z.object({ status: z.string().optional() }).optional())
      .query(async ({ input }) => db.getAllClientMatters(input ?? {})),

    get: permissionProcedure("clients:view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => db.getClientMatterById(input.id)),

    create: permissionProcedure("clients:manage")
      .input(z.object({
        clientId: z.number(),
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
        ]).optional(),
        // Lead Partner as a real user (validated server-side). leadPartner* text
        // remain accepted for legacy/free-text entry.
        leadLawyerId: z.number().int().positive().optional(),
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

    update: permissionProcedure("clients:manage")
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
        // Lead Partner user link: number assigns/validates, null unlinks.
        leadLawyerId: z.number().int().positive().nullable().optional(),
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
        return db.updateClientMatter(id, data as any, ctx.user!.id);
      }),

    delete: permissionProcedure("clients:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.assertMatterClientNotRejected(input.id);
        await db.deleteClientMatter(input.id);
        return { success: true };
      }),
  }),

  // ─── Matter Lawyer Rates ───────────────────────────────────────────────────

  matterLawyerRates: router({
    list: permissionProcedure("clients:view")
      .input(z.object({ clientMatterId: z.number() }))
      .query(async ({ input }) => db.getMatterLawyerRates(input.clientMatterId)),

    create: permissionProcedure("clients:manage")
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
        return db.createMatterLawyerRate(input as any, ctx.user!.id);
      }),

    update: permissionProcedure("clients:manage")
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
        return db.updateMatterLawyerRate(id, data as any, ctx.user!.id);
      }),

    delete: permissionProcedure("clients:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.assertRateClientNotRejected(input.id);
        await db.deleteMatterLawyerRate(input.id);
        return { success: true };
      }),
  }),

  // ─── Financial Records ─────────────────────────────────────────────────────

  financial: router({
    list: permissionProcedure("financial:view")
      .input(z.object({
        clientId: z.number().optional(),
        clientMatterId: z.number().optional(),
        collectionStatus: z.string().optional(),
      }).optional())
      .query(async ({ input }) => db.getFinancialRecords(input ?? {})),

    get: permissionProcedure("financial:view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => db.getFinancialRecordById(input.id)),

    create: permissionProcedure("financial:manage")
      .input(z.object({
        clientId: z.number(),
        clientMatterId: z.number().optional(),
        feeType: z.enum(["Billable Hours", "Fixed / Project-Based Fees", "Retainers", "Success Fees", "Advisory / Special Mandates", "Blended"]).optional(),
        agreedFees: z.string().optional(),
        discountApproval: z.enum(["N/A", "P&L Head Lawyers", "CEO", "Board"]).default("N/A"),
        // discountPercentage, discountAmount, netFees are server-computed from discountApproval.
        // Revenue is the single active amount field. billed_amount is NOT written
        // (legacy/read-only, CRM-012) and is NOT mirrored to revenue — see
        // applyDiscountRules and FINANCIAL_FORMULAS.md.
        revenue: z.string().optional(),
        collectedAmount: z.string().optional(),
        // outstandingAmount is server-computed; remainingAdvanced is legacy/read-only.
        collectionStatus: z.enum(["Not Billed", "Partially Billed", "Billed", "Partially Collected", "Fully Collected", "Overdue"]).default("Not Billed"),
        billingDate: z.string().optional(),
        paymentDate: z.string().optional(),
        invoiceNumber: z.string().optional(),
        responsibleLawyer: z.string().optional(),
        financeNotes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // Rejected clients are locked: no new financial records.
        await db.assertClientNotRejected(input.clientId);
        return db.createFinancialRecord(input as any, ctx.user!.id);
      }),

    update: permissionProcedure("financial:manage")
      .input(z.object({
        id: z.number(),
        clientMatterId: z.number().nullable().optional(), // null = unlink matter
        feeType: z.enum(["Billable Hours", "Fixed / Project-Based Fees", "Retainers", "Success Fees", "Advisory / Special Mandates", "Blended"]).optional(),
        agreedFees: z.string().optional(),
        discountApproval: z.enum(["N/A", "P&L Head Lawyers", "CEO", "Board"]).optional(),
        // discountPercentage, discountAmount, netFees are server-computed.
        // Revenue is the single active amount field. billed_amount stays legacy/
        // read-only (CRM-012) — never mirrored. See FINANCIAL_FORMULAS.md.
        revenue: z.string().optional(),
        collectedAmount: z.string().optional(),
        // outstandingAmount is server-computed; remainingAdvanced is legacy/read-only.
        collectionStatus: z.enum(["Not Billed", "Partially Billed", "Billed", "Partially Collected", "Fully Collected", "Overdue"]).optional(),
        billingDate: z.string().optional(),
        paymentDate: z.string().optional(),
        invoiceNumber: z.string().optional(),
        responsibleLawyer: z.string().optional(),
        financeNotes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        // Rejected clients are locked: existing financial records are read-only.
        await db.assertFinancialRecordClientNotRejected(id);
        return db.updateFinancialRecord(id, data as any, ctx.user!.id);
      }),

    delete: permissionProcedure("financial:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.assertFinancialRecordClientNotRejected(input.id);
        await db.deleteFinancialRecord(input.id);
        return { success: true };
      }),

    summary: permissionProcedure("financial:view").query(async () => db.getFinancialSummary()),

    toBeBilledBreakdown: permissionProcedure("financial:view").query(async () => db.getToBeBilledBreakdown()),

    // Read-only audit trail for a specific financial record.
    // Returns entries in chronological order (oldest first).
    auditLog: permissionProcedure("financial:view")
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => db.getFinancialAuditLogs(input.id)),
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

  // ─── Client Action Logs ────────────────────────────────────────────────────

  clientActions: router({
    list: permissionProcedure("actions:manage")
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

  chat: router({
    list: protectedProcedure.query(async () => db.getAllChatSubmissions()),

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

    updateStatus: protectedProcedure
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
