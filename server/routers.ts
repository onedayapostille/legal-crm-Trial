import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure, adminProcedure, permissionProcedure } from "./_core/trpc";
import { AUTH_COOKIE, createSessionToken, verifyPassword, hashPassword, isSecureRequest } from "./_core/auth";
import { TRPCError } from "@trpc/server";
import type { Request } from "express";
import { z } from "zod";
import * as db from "./db";
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
    stats: permissionProcedure("dashboard:view").query(async () => {
      return db.getDashboardStats();
    }),

    recentActivity: permissionProcedure("dashboard:view")
      .input(z.object({ limit: z.number().optional() }))
      .query(async ({ input }) => {
        return db.getRecentActivity(input.limit ?? 20);
      }),
  }),

  // ─── Leads ────────────────────────────────────────────────────────────────

  leads: router({
    list: permissionProcedure("leads:manage").query(async () => db.getAllLeads()),

    get: permissionProcedure("leads:manage")
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => db.getLeadById(input.id)),

    create: permissionProcedure("leads:manage")
      .input(z.object({
        dateOfEnquiry: z.string(),
        clientName: z.string().min(1),
        time: z.string().optional(),
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
        return db.createLead(input, ctx.user!.id);
      }),

    update: permissionProcedure("leads:manage")
      .input(z.object({
        id: z.number(),
        dateOfEnquiry: z.string().optional(),
        clientName: z.string().optional(),
        time: z.string().optional(),
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
        return db.updateLead(id, data);
      }),

    delete: permissionProcedure("leads:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteLead(input.id);
        return { success: true };
      }),

    statusSummary: permissionProcedure("analytics:view").query(async () => db.getLeadStatusSummary()),
    kpiMetrics: permissionProcedure("analytics:view").query(async () => db.getLeadKpiMetrics()),
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
      }).optional())
      .query(async ({ input }) => db.getAllTasks(input ?? {})),

    get: permissionProcedure("tasks:manage")
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => db.getTaskById(input.id)),

    create: permissionProcedure("tasks:manage")
      .input(z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        matterId: z.number().optional(),
        leadId: z.number().optional(),
        assignedTo: z.number().optional(),
        dueDate: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
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
        assignedTo: z.number().optional(),
        dueDate: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return db.updateTask(id, data);
      }),

    delete: permissionProcedure("tasks:manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
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

    create: adminProcedure
      .input(z.object({
        name: z.string().trim().min(1, "Name is required").max(120),
        email: emailSchema,
        password: passwordSchema,
        role: roleSchema.default("staff"),
        status: statusSchema.default("active"),
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
});

export type AppRouter = typeof appRouter;
