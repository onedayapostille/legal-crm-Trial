import {
  boolean,
  decimal,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
  date,
} from "drizzle-orm/pg-core";

// ─── Enums ───────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["admin", "manager", "lawyer", "staff", "viewer"]);
export const userStatusEnum = pgEnum("user_status", ["active", "inactive", "suspended"]);

export const leadStatusEnum = pgEnum("lead_status", [
  "New",
  "Contacted",
  "Meeting Scheduled",
  "Proposal Sent",
  "Converted",
  "Lost",
  "On Hold",
]);

export const matterStatusEnum = pgEnum("matter_status", [
  "active",
  "pending",
  "closed",
  "on_hold",
  "archived",
]);

export const priorityEnum = pgEnum("priority", ["low", "medium", "high", "urgent"]);

export const taskStatusEnum = pgEnum("task_status", [
  "todo",
  "in_progress",
  "done",
  "cancelled",
]);

export const documentEntityEnum = pgEnum("document_entity", [
  "lead",
  "matter",
  "company",
  "general",
]);

export const chatStatusEnum = pgEnum("chat_status", [
  "new",
  "read",
  "replied",
  "converted",
]);

export const auditActionEnum = pgEnum("audit_action", [
  "created",
  "updated",
  "deleted",
  "status_changed",
  "role_changed",
  "password_reset",
  "assigned",
]);

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  role: userRoleEnum("role").default("staff").notNull(),
  status: userStatusEnum("status").default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at"),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Companies ───────────────────────────────────────────────────────────────

export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  industry: varchar("industry", { length: 100 }),
  website: varchar("website", { length: 500 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 320 }),
  address: text("address"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Company = typeof companies.$inferSelect;
export type InsertCompany = typeof companies.$inferInsert;

// ─── Leads (Enquiries) ────────────────────────────────────────────────────────

export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  leadCode: varchar("lead_code", { length: 20 }).notNull().unique(), // ENQ-0001 or LEAD-0001

  // Basic info
  dateOfEnquiry: date("date_of_enquiry").notNull(),
  time: varchar("time", { length: 10 }),
  communicationChannel: varchar("communication_channel", { length: 50 }),
  receivedBy: varchar("received_by", { length: 100 }),

  // Client details
  clientName: varchar("client_name", { length: 255 }).notNull(),
  clientType: varchar("client_type", { length: 50 }),
  nationality: varchar("nationality", { length: 100 }),
  email: varchar("email", { length: 320 }),
  phoneNumber: varchar("phone_number", { length: 50 }),
  preferredContactMethod: varchar("preferred_contact_method", { length: 50 }),
  languagePreference: varchar("language_preference", { length: 50 }),
  companyId: integer("company_id").references(() => companies.id),

  // Service details
  serviceRequested: varchar("service_requested", { length: 255 }),
  shortDescription: text("short_description"),
  urgencyLevel: varchar("urgency_level", { length: 20 }),
  clientBudget: decimal("client_budget", { precision: 15, scale: 2 }),
  potentialValueRange: varchar("potential_value_range", { length: 50 }),
  expectedTimeline: varchar("expected_timeline", { length: 100 }),

  // Referral and competition
  referralSourceName: varchar("referral_source_name", { length: 255 }),
  competitorInvolvement: varchar("competitor_involvement", { length: 20 }),
  competitorName: varchar("competitor_name", { length: 255 }),

  // Assignment
  assignedDepartment: varchar("assigned_department", { length: 100 }),
  assignedTo: integer("assigned_to").references(() => users.id),
  suggestedLeadLawyer: varchar("suggested_lead_lawyer", { length: 100 }),

  // Status tracking
  currentStatus: leadStatusEnum("current_status").default("New").notNull(),
  nextAction: text("next_action"),
  deadline: date("deadline"),

  // Response tracking
  firstResponseDate: date("first_response_date"),
  firstResponseTimeHours: decimal("first_response_time_hours", { precision: 10, scale: 2 }),
  meetingDate: date("meeting_date"),
  proposalSentDate: date("proposal_sent_date"),
  proposalValue: decimal("proposal_value", { precision: 15, scale: 2 }),
  followUpCount: integer("follow_up_count").default(0),
  lastContactDate: date("last_contact_date"),

  // Conversion
  conversionDate: date("conversion_date"),
  engagementLetterDate: date("engagement_letter_date"),
  matterCode: varchar("matter_code", { length: 20 }), // links to matter

  // Payment
  paymentStatus: varchar("payment_status", { length: 50 }),
  invoiceNumber: varchar("invoice_number", { length: 100 }),

  // Loss tracking
  lostReason: text("lost_reason"),

  // Notes
  internalNotes: text("internal_notes"),

  // Metadata
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Lead = typeof leads.$inferSelect;
export type InsertLead = typeof leads.$inferInsert;

// ─── Matters / Cases ─────────────────────────────────────────────────────────

export const matters = pgTable("matters", {
  id: serial("id").primaryKey(),
  matterCode: varchar("matter_code", { length: 20 }).notNull().unique(), // MAT-2025-001
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"),

  // Client info
  clientName: varchar("client_name", { length: 255 }).notNull(),
  clientEmail: varchar("client_email", { length: 320 }),
  clientPhone: varchar("client_phone", { length: 50 }),
  companyId: integer("company_id").references(() => companies.id),
  leadId: integer("lead_id").references(() => leads.id),

  // Case details
  practiceArea: varchar("practice_area", { length: 100 }),
  status: matterStatusEnum("status").default("pending").notNull(),
  priority: priorityEnum("priority").default("medium").notNull(),
  assignedTo: integer("assigned_to").references(() => users.id),

  // Dates
  openDate: date("open_date"),
  closeDate: date("close_date"),
  nextHearingDate: date("next_hearing_date"),

  // Financial
  estimatedValue: decimal("estimated_value", { precision: 15, scale: 2 }),
  actualValue: decimal("actual_value", { precision: 15, scale: 2 }),
  billingType: varchar("billing_type", { length: 50 }),

  // Metadata
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Matter = typeof matters.$inferSelect;
export type InsertMatter = typeof matters.$inferInsert;

// ─── Tasks ────────────────────────────────────────────────────────────────────

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"),
  status: taskStatusEnum("status").default("todo").notNull(),
  priority: priorityEnum("priority").default("medium").notNull(),
  matterId: integer("matter_id").references(() => matters.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").references(() => leads.id),
  assignedTo: integer("assigned_to").references(() => users.id),
  dueDate: date("due_date"),
  completedAt: timestamp("completed_at"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Task = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;

// ─── Notes ────────────────────────────────────────────────────────────────────

export const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(),
  entityType: varchar("entity_type", { length: 50 }).notNull(), // 'lead' | 'matter' | 'task' | 'company'
  entityId: integer("entity_id").notNull(),
  isPrivate: boolean("is_private").default(false),
  matterId: integer("matter_id").references(() => matters.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").references(() => leads.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Note = typeof notes.$inferSelect;
export type InsertNote = typeof notes.$inferInsert;

// ─── Documents ────────────────────────────────────────────────────────────────

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 500 }).notNull(),
  originalName: varchar("original_name", { length: 500 }),
  mimeType: varchar("mime_type", { length: 100 }),
  fileSize: integer("file_size"),
  storageKey: varchar("storage_key", { length: 1000 }),
  entityType: documentEntityEnum("entity_type").default("general").notNull(),
  entityId: integer("entity_id"),
  matterId: integer("matter_id").references(() => matters.id),
  leadId: integer("lead_id").references(() => leads.id),
  uploadedBy: integer("uploaded_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Document = typeof documents.$inferSelect;
export type InsertDocument = typeof documents.$inferInsert;

// ─── Payments ─────────────────────────────────────────────────────────────────

export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull().references(() => leads.id),
  matterCode: varchar("matter_code", { length: 20 }).notNull(),
  paymentTerms: text("payment_terms"),
  paymentStatus: varchar("payment_status", { length: 50 }).notNull().default("Not Started"),
  totalAmount: decimal("total_amount", { precision: 15, scale: 2 }),
  amountPaid: decimal("amount_paid", { precision: 15, scale: 2 }).default("0"),
  amountOutstanding: decimal("amount_outstanding", { precision: 15, scale: 2 }),
  retainerPaidDate: date("retainer_paid_date"),
  retainerAmount: decimal("retainer_amount", { precision: 15, scale: 2 }),
  midPaymentDate: date("mid_payment_date"),
  midPaymentAmount: decimal("mid_payment_amount", { precision: 15, scale: 2 }),
  finalPaymentDate: date("final_payment_date"),
  finalPaymentAmount: decimal("final_payment_amount", { precision: 15, scale: 2 }),
  paymentNotes: text("payment_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Payment = typeof payments.$inferSelect;
export type InsertPayment = typeof payments.$inferInsert;

// ─── Activity Logs ────────────────────────────────────────────────────────────

export const activityLogs = pgTable("activity_logs", {
  id: serial("id").primaryKey(),
  entityType: varchar("entity_type", { length: 50 }).notNull(), // 'lead' | 'matter' | 'task' | 'user'
  entityId: integer("entity_id").notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  description: text("description"),
  metadata: jsonb("metadata"),
  performedBy: integer("performed_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ActivityLog = typeof activityLogs.$inferSelect;
export type InsertActivityLog = typeof activityLogs.$inferInsert;

// ─── Audit Logs (change tracking) ────────────────────────────────────────────

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  entityType: varchar("entity_type", { length: 50 }).notNull().default("lead"),
  entityId: integer("entity_id").notNull(),
  userId: integer("user_id").references(() => users.id),
  action: auditActionEnum("action").notNull(),
  fieldName: varchar("field_name", { length: 100 }),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

// ─── Chat / Contact Form Submissions ─────────────────────────────────────────

export const chatSubmissions = pgTable("chat_submissions", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 50 }),
  subject: varchar("subject", { length: 500 }),
  message: text("message"),
  status: chatStatusEnum("status").default("new").notNull(),
  assignedTo: integer("assigned_to").references(() => users.id),
  convertedToLeadId: integer("converted_to_lead_id").references(() => leads.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ChatSubmission = typeof chatSubmissions.$inferSelect;
export type InsertChatSubmission = typeof chatSubmissions.$inferInsert;
