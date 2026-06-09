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

export const userRoleEnum = pgEnum("user_role", ["admin", "manager", "partner", "lawyer", "finance", "staff", "viewer"]);
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
  clientId: integer("client_id"),
  clientMatterId: integer("client_matter_id"),
  clientActionLogId: integer("client_action_log_id"),
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

// ─── AlGhazzawi Clients Module ────────────────────────────────────────────────

export const clientStatusEnum = pgEnum("client_status", [
  "Existing Client",
  "Leads",
  "Rejected",
]);

// Intake channel a client originated from. Drives the Conversion Rate KPI:
//   Lead / Enquiry  → part of the intake funnel (denominator)
//   Direct          → walked in already a client; not part of the funnel
export const clientConvertedFromEnum = pgEnum("client_converted_from", [
  "Lead",
  "Enquiry",
  "Direct",
]);

export const cityEnum = pgEnum("city", ["Riyadh", "Dammam", "Jeddah"]);

export const clientMatterTypeEnum = pgEnum("client_matter_type", [
  "Corporate",
  "Litigation",
]);

export const feeTypeEnum = pgEnum("fee_type", [
  "Billable Hours",
  "Fixed / Project-Based Fees",
  "Retainers",
  "Success Fees",
  "Advisory / Special Mandates",
  "Blended",
]);

export const discountApprovalEnum = pgEnum("discount_approval", [
  "N/A",
  "P&L Head Lawyers",
  "CEO",
  "Board",
]);

export const collectionStatusEnum = pgEnum("collection_status", [
  "Not Billed",
  "Partially Billed",
  "Billed",
  "Partially Collected",
  "Fully Collected",
  "Overdue",
]);

export const rejectionReasonEnum = pgEnum("rejection_reason", ["Client", "Us"]);

// ─── Clients (master entity replacing Excel Client List) ──────────────────────

export const clients = pgTable("clients", {
  id: serial("id").primaryKey(),
  clientNumber: varchar("client_number", { length: 50 }).unique(),
  fileNumber: varchar("file_number", { length: 50 }).unique(),
  clientName: varchar("client_name", { length: 255 }).notNull(),
  clientStatus: clientStatusEnum("client_status").notNull().default("Leads"),
  convertedFrom: clientConvertedFromEnum("converted_from").notNull().default("Lead"),
  city: cityEnum("city"),
  matterType: clientMatterTypeEnum("matter_type"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Client = typeof clients.$inferSelect;
export type InsertClient = typeof clients.$inferInsert;

// ─── Client Matters (rich matter records linked to clients) ───────────────────

export const clientMatters = pgTable("client_matters", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  originalSerial: varchar("original_serial", { length: 50 }),
  matterReference: varchar("matter_reference", { length: 100 }),
  matterType: varchar("matter_type", { length: 100 }),
  billingType: feeTypeEnum("billing_type"),
  leadPartner: varchar("lead_partner", { length: 100 }),
  leadPartnerFullName: varchar("lead_partner_full_name", { length: 255 }),
  supportLead: varchar("support_lead", { length: 100 }),
  attorneyHead: varchar("attorney_head", { length: 100 }),
  attorney1: varchar("attorney_1", { length: 100 }),
  attorney2: varchar("attorney_2", { length: 100 }),
  attorney3: varchar("attorney_3", { length: 100 }),
  attorneyFullName: varchar("attorney_full_name", { length: 255 }),
  matterDescription: text("matter_description"),
  matterStatus: varchar("matter_status", { length: 100 }),
  balanceWorkLeft: decimal("balance_work_left", { precision: 5, scale: 2 }),
  achievementPercentage: decimal("achievement_percentage", { precision: 5, scale: 2 }),
  achievementStatus: varchar("achievement_status", { length: 100 }),
  priority: priorityEnum("priority").default("medium"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ClientMatter = typeof clientMatters.$inferSelect;
export type InsertClientMatter = typeof clientMatters.$inferInsert;

// ─── Matter Lawyer Rates (hourly rates per lawyer per matter) ─────────────────

export const matterLawyerRates = pgTable("matter_lawyer_rates", {
  id: serial("id").primaryKey(),
  clientMatterId: integer("client_matter_id").notNull().references(() => clientMatters.id, { onDelete: "cascade" }),
  lawyerName: varchar("lawyer_name", { length: 255 }).notNull(),
  role: varchar("role", { length: 100 }),
  hourlyRate: decimal("hourly_rate", { precision: 15, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 10 }).notNull().default("SAR"),
  isActive: boolean("is_active").notNull().default(true),
  effectiveDate: date("effective_date"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type MatterLawyerRate = typeof matterLawyerRates.$inferSelect;
export type InsertMatterLawyerRate = typeof matterLawyerRates.$inferInsert;

// ─── Client Lead Details (pipeline data for Leads-status clients) ─────────────

export const clientLeadDetails = pgTable("client_lead_details", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().unique().references(() => clients.id, { onDelete: "cascade" }),
  clientSource: varchar("client_source", { length: 255 }),
  nextActionDate: date("next_action_date"),
  nextActionDate2: date("next_action_date_2"),
  nextActionOwner: varchar("next_action_owner", { length: 255 }),
  nextAction: text("next_action"),
  priority: priorityEnum("priority").default("medium"),
  leadStatus: varchar("lead_status", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ClientLeadDetail = typeof clientLeadDetails.$inferSelect;
export type InsertClientLeadDetail = typeof clientLeadDetails.$inferInsert;

// ─── Rejected Clients ─────────────────────────────────────────────────────────

export const rejectedClients = pgTable("rejected_clients", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().unique().references(() => clients.id, { onDelete: "cascade" }),
  rejectionReasonSource: rejectionReasonEnum("rejection_reason_source"),
  rejectionNotes: text("rejection_notes"),
  rejectedBy: varchar("rejected_by", { length: 255 }),
  rejectedAt: timestamp("rejected_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type RejectedClient = typeof rejectedClients.$inferSelect;
export type InsertRejectedClient = typeof rejectedClients.$inferInsert;

// ─── Financial Records ────────────────────────────────────────────────────────

export const financialRecords = pgTable("financial_records", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  clientMatterId: integer("client_matter_id").references(() => clientMatters.id),
  feeType: feeTypeEnum("fee_type"),
  agreedFees: decimal("agreed_fees", { precision: 15, scale: 2 }),
  discountApproval: discountApprovalEnum("discount_approval").default("N/A"),
  discountPercentage: decimal("discount_percentage", { precision: 5, scale: 2 }),
  discountAmount: decimal("discount_amount", { precision: 15, scale: 2 }),
  netFees: decimal("net_fees", { precision: 15, scale: 2 }),
  billedAmount: decimal("billed_amount", { precision: 15, scale: 2 }),
  revenue: decimal("revenue", { precision: 15, scale: 2 }),
  collectedAmount: decimal("collected_amount", { precision: 15, scale: 2 }),
  remainingAdvanced: decimal("remaining_advanced", { precision: 15, scale: 2 }),
  outstandingAmount: decimal("outstanding_amount", { precision: 15, scale: 2 }),
  collectionStatus: collectionStatusEnum("collection_status").default("Not Billed"),
  billingDate: date("billing_date"),
  paymentDate: date("payment_date"),
  invoiceNumber: varchar("invoice_number", { length: 100 }),
  responsibleLawyer: varchar("responsible_lawyer", { length: 255 }),
  financeNotes: text("finance_notes"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type FinancialRecord = typeof financialRecords.$inferSelect;
export type InsertFinancialRecord = typeof financialRecords.$inferInsert;

// ─── Client Action Log ────────────────────────────────────────────────────────

export const clientActionLogs = pgTable("client_action_logs", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  clientMatterId: integer("client_matter_id").references(() => clientMatters.id),
  actionOwner: varchar("action_owner", { length: 255 }),
  nextStep: text("next_step"),
  actionDate: date("action_date"),
  actionType: varchar("action_type", { length: 100 }),
  actionDetails: text("action_details"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ClientActionLog = typeof clientActionLogs.$inferSelect;
export type InsertClientActionLog = typeof clientActionLogs.$inferInsert;

// ─── System Settings ──────────────────────────────────────────────────────────
// Key-value store for configurable application parameters (e.g. overdue_invoice_days).

export const systemSettings = pgTable("system_settings", {
  key:         varchar("key",   { length: 100 }).primaryKey(),
  value:       text("value").notNull(),
  description: text("description"),
  updatedBy:   integer("updated_by").references(() => users.id),
  updatedAt:   timestamp("updated_at").defaultNow().notNull(),
});

export type SystemSetting       = typeof systemSettings.$inferSelect;
export type InsertSystemSetting = typeof systemSettings.$inferInsert;
