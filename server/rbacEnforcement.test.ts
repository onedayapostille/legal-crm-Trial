import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";

/**
 * RBAC enforcement — integration tests over the real router + DB.
 *
 * Builds TWO practices (Riyadh/Litigation → hop1, Jeddah/Corporate → hop2),
 * clients in each, matters with real user-FK teams, matter-linked AND
 * client-level financial records, and tasks — then verifies the capability ×
 * scope matrix, the Lead Lawyer overlay, Head-of-Practice practice bounds,
 * field-level (team) authorization, and IDOR-safe reads for every role.
 *
 * Runs against DATABASE_URL (locally the `app` database — never production).
 * All fixtures are created up front and deleted in afterAll.
 */

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function callerForUser(user: { id: number; role: string }) {
  return appRouter.createCaller({
    user: {
      id: user.id,
      email: `${user.role}.${user.id}@example.com`,
      name: user.role,
      role: user.role,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as AuthenticatedUser,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}

const admin = () => callerForUser({ id: 1, role: "admin" });

const stamp = Date.now();
const ids = {
  users: {} as Record<string, number>,
  clients: {} as Record<string, number>,
  matters: {} as Record<string, number>,
  financial: {} as Record<string, number>,
  tasks: [] as number[],
  practices: [] as number[],
  leads: [] as number[],
  extraClients: [] as number[],
  extraFinancial: [] as number[],
};

async function createUser(key: string, role: string) {
  const u = await admin().users.create({
    name: `RBAC ${key}`,
    email: `rbac.${key}.${stamp}@example.com`,
    password: "Rbac12345",
    role: role as any,
    status: "active",
  });
  ids.users[key] = u.id;
  return u.id;
}

const caller = (key: string, role: string) => callerForUser({ id: ids.users[key], role });

beforeAll(async () => {
  // ── Users (one per role under test) ────────────────────────────────────────
  await createUser("hop1", "head_of_practice");
  await createUser("hop2", "head_of_practice");
  await createUser("manager", "manager");
  await createUser("senior", "senior_associate");
  await createUser("exec", "executive_associate"); // designated Lead Lawyer on matterA1
  await createUser("exec2", "executive_associate"); // NO designation
  await createUser("assoc", "associate");
  await createUser("paralegal", "paralegal");
  await createUser("finance", "finance");
  await createUser("coordinator", "coordinator");
  await createUser("trainee", "trainee");

  // Legacy lawyer (not assignable via users.create — insert directly, as an
  // un-migrated account would exist in the DB).
  const legacy = await db.createUser({
    name: `RBAC legacy lawyer`,
    email: `rbac.legacylawyer.${stamp}@example.com`,
    passwordHash: "x",
    role: "lawyer" as any,
    status: "active",
  } as any);
  ids.users.legacyLawyer = legacy.id;

  // ── Practices (BR-01 map) ──────────────────────────────────────────────────
  const p1 = await admin().practices.set({
    city: "Riyadh", matterType: "Litigation", headOfPracticeId: ids.users.hop1,
  });
  const p2 = await admin().practices.set({
    city: "Jeddah", matterType: "Corporate", headOfPracticeId: ids.users.hop2,
  });
  ids.practices.push(p1.id, p2.id);

  // ── Clients: one per practice + a Leads-status client ─────────────────────
  const clientA = await admin().clients.create({
    clientName: `RBAC Client A ${stamp}`, clientStatus: "Existing Client",
    city: "Riyadh", matterType: "Litigation",
  });
  const clientB = await admin().clients.create({
    clientName: `RBAC Client B ${stamp}`, clientStatus: "Existing Client",
    city: "Jeddah", matterType: "Corporate",
  });
  const clientLead = await admin().clients.create({
    clientName: `RBAC Lead Client ${stamp}`, clientStatus: "Leads",
    city: "Riyadh", matterType: "Litigation",
  });
  ids.clients.A = clientA.id;
  ids.clients.B = clientB.id;
  ids.clients.lead = clientLead.id;

  // ── Matters with real user-FK teams ───────────────────────────────────────
  // matterA1 (practice 1): exec is the designated Lead Lawyer; senior + assoc
  // are team members. matterB1 (practice 2): hop2 leads; none of the practice-1
  // lawyers are on the team.
  const matterA1 = await admin().clientMatters.create({
    clientId: ids.clients.A,
    matterReference: `RBAC-A1-${stamp}`,
    matterType: "Litigation",
    leadLawyerId: ids.users.exec,
    attorney1Id: ids.users.senior,
    attorney2Id: ids.users.assoc,
    matterStatus: "Active",
  });
  const matterB1 = await admin().clientMatters.create({
    clientId: ids.clients.B,
    matterReference: `RBAC-B1-${stamp}`,
    matterType: "Corporate",
    leadLawyerId: ids.users.hop2,
    matterStatus: "Active",
  });
  ids.matters.A1 = matterA1.id;
  ids.matters.B1 = matterB1.id;

  // ── Financial records: matter-linked (both practices) + client-level ──────
  const finA1 = await admin().financial.create({
    clientId: ids.clients.A, clientMatterId: ids.matters.A1, revenue: "10000",
  });
  const finB1 = await admin().financial.create({
    clientId: ids.clients.B, clientMatterId: ids.matters.B1, revenue: "20000",
  });
  const finClientLevel = await admin().financial.create({
    clientId: ids.clients.A, revenue: "5000", // NO matter link
  });
  ids.financial.A1 = finA1.id;
  ids.financial.B1 = finB1.id;
  ids.financial.clientLevel = finClientLevel.id;

  // ── Tasks ──────────────────────────────────────────────────────────────────
  const taskAssoc = await admin().tasks.create({
    title: `RBAC task for assoc ${stamp}`, clientId: ids.clients.A,
    clientMatterId: ids.matters.A1, assignedTo: ids.users.assoc,
  });
  const taskMatterA1 = await admin().tasks.create({
    title: `RBAC task on A1 (unassigned lawyer) ${stamp}`, clientId: ids.clients.A,
    clientMatterId: ids.matters.A1, assignedTo: ids.users.hop1,
  });
  const taskOther = await admin().tasks.create({
    title: `RBAC unrelated task ${stamp}`, clientId: ids.clients.B,
    clientMatterId: ids.matters.B1, assignedTo: ids.users.hop2,
  });
  ids.tasks.push(taskAssoc.id, taskMatterA1.id, taskOther.id);
}, 60_000);

afterAll(async () => {
  const a = admin();
  // The coordinator's enquiry mirrors a canonical client — find and remove it
  // (the mirror is created by leads.create, not tracked above).
  try {
    const mirrors = await a.clients.list({ search: `RBAC Coordinator Enquiry ${stamp}` });
    for (const m of mirrors) ids.extraClients.push(m.id);
  } catch {
    /* ignore */
  }
  for (const id of ids.tasks) await a.tasks.delete({ id }).catch(() => {});
  for (const id of ids.extraFinancial) await a.financial.delete({ id }).catch(() => {});
  for (const key of Object.keys(ids.financial)) {
    await a.financial.delete({ id: ids.financial[key] }).catch(() => {});
  }
  for (const key of Object.keys(ids.matters)) {
    await a.clientMatters.delete({ id: ids.matters[key] }).catch(() => {});
  }
  for (const id of ids.extraClients) await a.clients.delete({ id }).catch(() => {});
  for (const key of Object.keys(ids.clients)) {
    await a.clients.delete({ id: ids.clients[key] }).catch(() => {});
  }
  for (const id of ids.leads) await a.leads.delete({ id }).catch(() => {});
  for (const id of ids.practices) await a.practices.remove({ id }).catch(() => {});
  for (const key of Object.keys(ids.users)) {
    await a.users.delete({ userId: ids.users[key] }).catch(() => {});
  }
}, 60_000);

// ─── Manager: read everything, mutate nothing (BR-08) ─────────────────────────

describe("Manager is read-only across the CRM", () => {
  const m = () => caller("manager", "manager");

  it("views all clients, matters and financial records firm-wide", async () => {
    const clients = await m().clients.list({});
    const clientIds = clients.map(c => c.id);
    expect(clientIds).toContain(ids.clients.A);
    expect(clientIds).toContain(ids.clients.B);

    const matters = await m().clientMatters.listAll({});
    const matterIds = matters.map(x => x.id);
    expect(matterIds).toContain(ids.matters.A1);
    expect(matterIds).toContain(ids.matters.B1);

    const fins = await m().financial.list({});
    const finIds = fins.map(f => f.id);
    expect(finIds).toContain(ids.financial.A1);
    expect(finIds).toContain(ids.financial.B1);
    expect(finIds).toContain(ids.financial.clientLevel);
  });

  it("every mutation is rejected server-side", async () => {
    await expect(m().clients.create({ clientName: "x" } as any)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m().clients.update({ id: ids.clients.A, clientName: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m().clients.delete({ id: ids.clients.A })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m().clientMatters.update({ id: ids.matters.A1, matterDescription: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m().financial.create({ clientId: ids.clients.A, revenue: "1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m().financial.update({ id: ids.financial.A1, revenue: "1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m().tasks.create({ title: "x", clientId: ids.clients.A })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m().tasks.update({ id: ids.tasks[0], title: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m().leads.create({ dateOfEnquiry: "2026-01-01", clientName: "x", channelType: "Walk-in" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m().payments.create({ leadId: 1, matterCode: "X" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m().users.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m().settings.update({ key: "overdue_invoice_days", value: "30" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─── Head of Practice: view all, edit own practice only (BR-02) ───────────────

describe("Head of Practice practice bounds", () => {
  const h1 = () => caller("hop1", "head_of_practice");

  it("views all records firm-wide", async () => {
    const clients = await h1().clients.list({});
    expect(clients.map(c => c.id)).toContain(ids.clients.B);
    const fins = await h1().financial.list({});
    expect(fins.map(f => f.id)).toContain(ids.financial.B1);
  });

  it("list rows carry server-computed viewerCanEdit only for own practice", async () => {
    const clients = await h1().clients.list({});
    const a = clients.find(c => c.id === ids.clients.A);
    const b = clients.find(c => c.id === ids.clients.B);
    expect(a?.viewerCanEdit).toBe(true);
    expect(b?.viewerCanEdit).toBe(false);
  });

  it("edits an own-practice client but not an outside-practice client", async () => {
    await expect(
      h1().clients.update({ id: ids.clients.A, clientName: `RBAC Client A ${stamp}` }),
    ).resolves.toBeTruthy();
    await expect(
      h1().clients.update({ id: ids.clients.B, clientName: "hijack" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cannot move an own-practice record OUT of the practice (city/matter type)", async () => {
    await expect(
      h1().clients.update({ id: ids.clients.A, city: "Jeddah" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h1().clients.update({ id: ids.clients.A, matterType: "Corporate" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates clients only within own practice", async () => {
    const created = await h1().clients.create({
      clientName: `RBAC HoP1 own-practice client ${stamp}`,
      clientStatus: "Existing Client", city: "Riyadh", matterType: "Litigation",
    });
    ids.extraClients.push(created.id);
    await expect(
      h1().clients.create({
        clientName: `RBAC HoP1 outside client ${stamp}`,
        clientStatus: "Existing Client", city: "Jeddah", matterType: "Corporate",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("edits matter details in own practice; outside-practice matters are read-only", async () => {
    await expect(
      h1().clientMatters.update({ id: ids.matters.A1, matterDescription: "hop1 note" }),
    ).resolves.toBeTruthy();
    await expect(
      h1().clientMatters.update({ id: ids.matters.B1, matterDescription: "hijack" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("may change team fields within the practice, but cannot move the matter out", async () => {
    await expect(
      h1().clientMatters.update({ id: ids.matters.A1, attorney3Id: ids.users.trainee }),
    ).resolves.toBeTruthy();
    await expect(
      h1().clientMatters.update({ id: ids.matters.A1, matterType: "Corporate" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h1().clientMatters.reassignLeadLawyer({ clientMatterId: ids.matters.B1, userId: ids.users.senior }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates/edits financial records only within own practice (BR-06)", async () => {
    const rec = await h1().financial.create({ clientId: ids.clients.A, revenue: "111" });
    ids.extraFinancial.push(rec.id);
    await expect(
      h1().financial.create({ clientId: ids.clients.B, revenue: "222" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h1().financial.update({ id: ids.financial.B1, revenue: "333" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Financial delete stays admin/finance (Excel F-codes): HoP has none.
    await expect(
      h1().financial.delete({ id: rec.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─── Assigned-matter scopes (Senior / Executive / Associate) ───────────────────

describe("Assigned-matter scope + Lead Lawyer overlay", () => {
  it("Senior Associate sees only assigned matters and their clients", async () => {
    const s = caller("senior", "senior_associate");
    const matters = await s.clientMatters.listAll({});
    expect(matters.map(x => x.id)).toContain(ids.matters.A1);
    expect(matters.map(x => x.id)).not.toContain(ids.matters.B1);
    expect(await s.clientMatters.get({ id: ids.matters.B1 })).toBeNull();

    const clients = await s.clients.list({});
    const clientIds = clients.map(c => c.id);
    expect(clientIds).toContain(ids.clients.A);
    expect(clientIds).not.toContain(ids.clients.B);
    expect(await s.clients.get({ id: ids.clients.B })).toBeNull();
  });

  it("Senior Associate: assigned-matter financials read-only; client-level records excluded", async () => {
    const s = caller("senior", "senior_associate");
    const fins = await s.financial.list({});
    const finIds = fins.map(f => f.id);
    expect(finIds).toContain(ids.financial.A1);
    expect(finIds).not.toContain(ids.financial.B1);
    expect(finIds).not.toContain(ids.financial.clientLevel); // no matter link → ALL-scope viewers only
    await expect(
      s.financial.update({ id: ids.financial.A1, revenue: "999" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      s.financial.create({ clientId: ids.clients.A, revenue: "999" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Executive Associate designated Lead Lawyer sees THAT matter's financials only", async () => {
    const e = caller("exec", "executive_associate");
    const fins = await e.financial.list({});
    const finIds = fins.map(f => f.id);
    expect(finIds).toContain(ids.financial.A1); // led matter
    expect(finIds).not.toContain(ids.financial.B1);
    expect(finIds).not.toContain(ids.financial.clientLevel);
    // Never mutations through the overlay (BR-04/BR-06).
    await expect(
      e.financial.update({ id: ids.financial.A1, revenue: "999" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Executive Associate WITHOUT the designation sees no financial data", async () => {
    const e2 = caller("exec2", "executive_associate");
    expect(await e2.financial.list({})).toEqual([]);
    expect(await e2.financial.get({ id: ids.financial.A1 })).toBeNull();
  });

  it("Lead Lawyer overlay: exec sees ALL tasks of the led matter", async () => {
    const e = caller("exec", "executive_associate");
    const tasks = await e.tasks.list({});
    const taskIds = tasks.map(t => t.id);
    expect(taskIds).toContain(ids.tasks[0]); // task on led matter (assigned to assoc)
    expect(taskIds).toContain(ids.tasks[1]); // task on led matter (assigned to hop1)
    expect(taskIds).not.toContain(ids.tasks[2]); // unrelated matter
  });

  it("Associate cannot see unrelated matters or escalate via team fields", async () => {
    const a = caller("assoc", "associate");
    const matters = await a.clientMatters.listAll({});
    expect(matters.map(x => x.id)).not.toContain(ids.matters.B1);
    // Unrelated matter: existence is not revealed.
    await expect(
      a.clientMatters.update({ id: ids.matters.B1, matterDescription: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Own matter: plain details are editable…
    await expect(
      a.clientMatters.update({ id: ids.matters.A1, matterDescription: "assoc note" }),
    ).resolves.toBeTruthy();
    // …but authorization-defining fields are not (matter-team escalation).
    await expect(
      a.clientMatters.update({ id: ids.matters.A1, leadLawyerId: ids.users.assoc }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      a.clientMatters.update({ id: ids.matters.A1, attorney4Id: ids.users.exec2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Associate cannot assign tasks to others; Senior can", async () => {
    const a = caller("assoc", "associate");
    await expect(
      a.tasks.create({ title: "escalate", clientId: ids.clients.A, assignedTo: ids.users.senior }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const own = await a.tasks.create({ title: `assoc self task ${stamp}`, clientId: ids.clients.A });
    ids.tasks.push(own.id);

    const s = caller("senior", "senior_associate");
    const assigned = await s.tasks.create({
      title: `senior assigns ${stamp}`, clientId: ids.clients.A, assignedTo: ids.users.assoc,
    });
    ids.tasks.push(assigned.id);
  });

  it("IDOR: unrelated task reads return null / NOT_FOUND", async () => {
    const a = caller("assoc", "associate");
    expect(await a.tasks.get({ id: ids.tasks[2] })).toBeNull();
    await expect(a.tasks.update({ id: ids.tasks[2], title: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ─── Paralegal ─────────────────────────────────────────────────────────────────

describe("Paralegal least privilege", () => {
  const p = () => caller("paralegal", "paralegal");

  it("has NO financial visibility at all", async () => {
    await expect(p().financial.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(p().financial.get({ id: ids.financial.A1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(p().financialReports.summary({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("views all matters and edits permitted details, but no team fields", async () => {
    const matters = await p().clientMatters.listAll({});
    expect(matters.map(x => x.id)).toContain(ids.matters.B1);
    await expect(
      p().clientMatters.update({ id: ids.matters.A1, matterDescription: "paralegal note" }),
    ).resolves.toBeTruthy();
    await expect(
      p().clientMatters.update({ id: ids.matters.A1, leadLawyerId: ids.users.senior }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("edits existing clients only; cannot create clients or edit leads", async () => {
    await expect(
      p().clients.update({ id: ids.clients.A, clientName: `RBAC Client A ${stamp}` }),
    ).resolves.toBeTruthy();
    await expect(
      p().clients.update({ id: ids.clients.lead, clientName: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      p().clients.create({ clientName: "x" } as any),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("own tasks only; cannot assign to others", async () => {
    await expect(
      p().tasks.create({ title: "x", clientId: ids.clients.A, assignedTo: ids.users.assoc }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─── Coordinator ───────────────────────────────────────────────────────────────

describe("Coordinator registry + read-only financials", () => {
  const c = () => caller("coordinator", "coordinator");

  it("views financial records firm-wide but NEVER mutates them (BR-07)", async () => {
    const fins = await c().financial.list({});
    expect(fins.map(f => f.id)).toContain(ids.financial.B1);
    await expect(c().financial.create({ clientId: ids.clients.A, revenue: "1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c().financial.update({ id: ids.financial.A1, revenue: "1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c().financial.delete({ id: ids.financial.A1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c().payments.create({ leadId: 1, matterCode: "X" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("has no financial reports access (matrix: Coordinator = no reports)", async () => {
    await expect(c().financialReports.summary({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c().financialReports.export({ reportType: "details" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("manages enquiries (BR-15) and assigns tasks (BR-10)", async () => {
    const lead = await c().leads.create({
      dateOfEnquiry: "2026-01-01",
      clientName: `RBAC Coordinator Enquiry ${stamp}`,
      channelType: "Walk-in",
    });
    ids.leads.push(lead.id);
    // Enquiry deletion is Admin-only.
    await expect(c().leads.delete({ id: lead.id })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const t = await c().tasks.create({
      title: `coordinator assigns ${stamp}`, clientId: ids.clients.A, assignedTo: ids.users.assoc,
    });
    ids.tasks.push(t.id);
  });

  it("creates and edits clients (leads & existing) and matters", async () => {
    const created = await c().clients.create({
      clientName: `RBAC Coordinator client ${stamp}`, clientStatus: "Leads",
      city: "Riyadh", matterType: "Litigation",
    });
    ids.extraClients.push(created.id);
    await expect(
      c().clients.update({ id: created.id, clientName: `RBAC Coordinator client2 ${stamp}` }),
    ).resolves.toBeTruthy();
  });

  it("has no user management or settings access", async () => {
    await expect(c().users.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c().settings.update({ key: "overdue_invoice_days", value: "30" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─── Finance ───────────────────────────────────────────────────────────────────

describe("Finance role", () => {
  const f = () => caller("finance", "finance");

  it("full financial access incl. create/edit; views reports", async () => {
    const rec = await f().financial.create({ clientId: ids.clients.B, revenue: "777" });
    ids.extraFinancial.push(rec.id);
    await expect(f().financial.update({ id: rec.id, revenue: "778" })).resolves.toBeTruthy();
    const summary = await f().financialReports.summary({});
    expect(summary).toBeTruthy();
  });

  it("no Enquiries Log access; manages own tasks but cannot assign others", async () => {
    await expect(f().leads.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f().tasks.create({ title: "x", clientId: ids.clients.A, assignedTo: ids.users.assoc }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const own = await f().tasks.create({
      title: `finance self task ${stamp}`, clientId: ids.clients.A, assignedTo: ids.users.finance,
    });
    ids.tasks.push(own.id);
  });
});

// ─── Lead Lawyer eligibility & user management safeguards ─────────────────────

describe("Designations, roles and user management", () => {
  it("Trainee cannot be designated Lead Lawyer (documented spec conflict)", async () => {
    await expect(
      admin().clientMatters.reassignLeadLawyer({
        clientMatterId: ids.matters.A1, userId: ids.users.trainee,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("users.create/update accept only the 11 canonical account roles", async () => {
    await expect(
      admin().users.create({
        name: "x", email: `rbac.badrole.${stamp}@example.com`,
        password: "Abcdef12", role: "lawyer" as any,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      admin().users.create({
        name: "x", email: `rbac.badrole2.${stamp}@example.com`,
        password: "Abcdef12", role: "lead_lawyer" as any,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("legacy 'lawyer' accounts keep working at the least-privilege baseline (no silent migration)", async () => {
    const stored = await db.getUserById(ids.users.legacyLawyer);
    expect(stored?.role).toBe("lawyer"); // untouched in the DB
    const l = caller("legacyLawyer", "lawyer");
    expect(await l.clientMatters.listAll({})).toEqual([]); // ASSIGNED scope, no assignments
    expect(await l.financial.list({})).toEqual([]); // overlay-eligible but leads nothing
    await expect(
      l.tasks.create({ title: "x", clientId: ids.clients.A, assignedTo: ids.users.assoc }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" }); // cannot assign others
  });

  it("only Admin reaches user management endpoints", async () => {
    for (const [key, role] of [["hop1", "head_of_practice"], ["finance", "finance"], ["senior", "senior_associate"]] as const) {
      await expect(caller(key, role).users.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});

// ─── Aggregates & secondary endpoints do not leak ─────────────────────────────

describe("Aggregates and secondary endpoints are scoped", () => {
  it("financial.summary as Senior only counts visible records", async () => {
    const s = caller("senior", "senior_associate");
    const visible = await s.financial.list({});
    const expectedRevenue = visible.reduce((sum, r) => sum + Number(r.revenue ?? 0), 0);
    const summary = await s.financial.summary();
    expect(summary.totalRevenue).toBe(expectedRevenue);
  });

  it("client status counts as Associate only count related clients", async () => {
    const a = caller("assoc", "associate");
    const counts = await a.clients.statusCounts();
    const visible = await a.clients.list({});
    expect(counts.total).toBe(visible.length);
  });

  it("audit history follows record visibility", async () => {
    const a = caller("assoc", "associate");
    // Client B is invisible to assoc — audit history yields nothing (no probe).
    expect(await a.auditLogs.byEntity({ entityType: "client", entityId: ids.clients.B })).toEqual([]);
    // Paralegal has no financial visibility — financial audit is forbidden.
    await expect(
      caller("paralegal", "paralegal").auditLogs.byEntity({
        entityType: "financial_record", entityId: ids.financial.A1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("payments reads require firm-wide financial visibility", async () => {
    await expect(caller("senior", "senior_associate").payments.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("manager", "manager").payments.list()).resolves.toBeTruthy();
  });
});
