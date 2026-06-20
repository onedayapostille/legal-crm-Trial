import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };

  return { ctx };
}

describe("payments.create", () => {
  it("creates a payment record for a converted enquiry", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // Create and convert an enquiry
    const enquiry = await caller.leads.create({
      dateOfEnquiry: "2025-01-15",
      clientName: "Payment Test Client " + Date.now(),
      channelType: "Walk-in",
    });

    await caller.leads.update({
      id: enquiry.id,
      conversionDate: "2025-01-20",
      currentStatus: "Converted",
    });

    const updatedEnquiry = await caller.leads.get({ id: enquiry.id });

    // Create payment record
    const payment = await caller.payments.create({
      enquiryId: enquiry.id,
      matterCode: updatedEnquiry?.matterCode || "MAT-2025-001",
      totalAmount: "50000",
      paymentStatus: "Not Started",
    });

    expect(payment).toHaveProperty("id");
    expect(typeof payment.id).toBe("number");
  });

  it("creates payment with milestone details", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const enquiry = await caller.leads.create({
      dateOfEnquiry: "2025-01-15",
      clientName: "Milestone Test Client " + Date.now(),
      channelType: "Walk-in",
    });

    await caller.leads.update({
      id: enquiry.id,
      conversionDate: "2025-01-20",
      currentStatus: "Converted",
    });

    const updatedEnquiry = await caller.leads.get({ id: enquiry.id });

    const payment = await caller.payments.create({
      enquiryId: enquiry.id,
      matterCode: updatedEnquiry?.matterCode || "MAT-2025-002",
      totalAmount: "100000",
      retainerAmount: "30000",
      retainerPaidDate: "2025-01-25",
      midPaymentAmount: "40000",
      finalPaymentAmount: "30000",
      paymentStatus: "Retainer Paid",
    });

    expect(payment).toHaveProperty("id");
  });
});

describe("payments.update", () => {
  it("updates payment status and amounts", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const enquiry = await caller.leads.create({
      dateOfEnquiry: "2025-01-15",
      clientName: "Update Test Client " + Date.now(),
      channelType: "Walk-in",
    });

    await caller.leads.update({
      id: enquiry.id,
      conversionDate: "2025-01-20",
      currentStatus: "Converted",
    });

    const updatedEnquiry = await caller.leads.get({ id: enquiry.id });

    const payment = await caller.payments.create({
      enquiryId: enquiry.id,
      matterCode: updatedEnquiry?.matterCode || "MAT-2025-003",
      totalAmount: "50000",
      paymentStatus: "Not Started",
    });

    const updated = await caller.payments.update({
      id: payment.id,
      paymentStatus: "Partially Paid",
      amountPaid: "25000",
      amountOutstanding: "25000",
    });

    expect(updated).not.toBeNull();
  });
});

describe("payments.getByEnquiry", () => {
  it("retrieves payment by enquiry ID", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const enquiry = await caller.leads.create({
      dateOfEnquiry: "2025-01-15",
      clientName: "Retrieve Test Client " + Date.now(),
      channelType: "Walk-in",
    });

    await caller.leads.update({
      id: enquiry.id,
      conversionDate: "2025-01-20",
      currentStatus: "Converted",
    });

    const updatedEnquiry = await caller.leads.get({ id: enquiry.id });

    await caller.payments.create({
      enquiryId: enquiry.id,
      matterCode: updatedEnquiry?.matterCode || "MAT-2025-004",
      totalAmount: "75000",
      paymentStatus: "Not Started",
    });

    const retrieved = await caller.payments.getByEnquiry({ enquiryId: enquiry.id });

    expect(retrieved).not.toBeNull();
    expect(retrieved?.enquiryId).toBe(enquiry.id);
  });
});

describe("payments.list", () => {
  it("returns all payment records", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const list = await caller.payments.list();

    expect(Array.isArray(list)).toBe(true);
    list.forEach(payment => {
      expect(payment).toHaveProperty("id");
      expect(payment).toHaveProperty("enquiryId");
      expect(payment).toHaveProperty("matterCode");
      expect(payment).toHaveProperty("paymentStatus");
    });
  });
});
