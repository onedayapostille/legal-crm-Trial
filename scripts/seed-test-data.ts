/**
 * QA TEST-DATA seed — INSERT-ONLY. Creates clearly-marked `TEST -` users,
 * clients, matters (with assignments), tasks, action logs and financial records
 * so the full CRM workflow can be exercised on the live DB.
 *
 * SAFETY CONTRACT (enforced by the code below):
 *   - Uses ONLY the normal tRPC create endpoints (same business logic as the UI).
 *   - NEVER calls any delete/update endpoint, and NEVER runs raw SQL.
 *   - Idempotent: every entity is find-or-create by its `TEST -` name/email, so
 *     re-running does not duplicate and does not touch existing real data.
 *   - Existing users/clients/matters/data are never modified or removed.
 *
 *   tsx scripts/seed-test-data.ts
 */
import "dotenv/config";
import { appRouter } from "../server/routers";
import { getRawClient } from "../server/db";
import type { TrpcContext } from "../server/_core/context";

const TEMP_PASSWORD = process.env.TEST_USER_PASSWORD || "TestPass2026";

function adminCaller() {
  const user = {
    id: 1,
    openId: "seed-test-data",
    email: "admin@local",
    name: "System Administrator",
    loginMethod: "manus",
    role: "admin",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  } as NonNullable<TrpcContext["user"]>;
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  });
}

const TEST_USERS = [
  { name: "TEST - Omar Al-Zahrani", email: "test.omar.alzahrani@example.com", role: "partner" },
  { name: "TEST - Reem Al-Saud",    email: "test.reem.alsaud@example.com",   role: "lawyer" },
  { name: "TEST - Majed Al-Nasser", email: "test.majed.alnasser@example.com", role: "lawyer" },
  { name: "TEST - Huda Al-Rashid",  email: "test.huda.alrashid@example.com",  role: "staff" },
  { name: "TEST - Faisal Al-Dosari", email: "test.faisal.aldosari@example.com", role: "finance" },
] as const;

const TEST_CLIENTS = [
  { clientName: "TEST - Abdulrahman Al-Fahad",        clientNumber: "CL-TEST-001", matterType: "Corporate" as const },
  { clientName: "TEST - Sara Al-Mutairi",             clientNumber: "CL-TEST-002", matterType: "Litigation" as const },
  { clientName: "TEST - Khalid Al-Qahtani",           clientNumber: "CL-TEST-003", matterType: "Corporate" as const },
  { clientName: "TEST - Nora Al-Harbi",               clientNumber: "CL-TEST-004", matterType: "Corporate" as const },
  { clientName: "TEST - Faisal Al-Dosari Trading Co.", clientNumber: "CL-TEST-005", matterType: "Corporate" as const },
];

// matter -> owning client (by clientName), type, billing
const TEST_MATTERS = [
  { ref: "TEST - Corporate Advisory Matter",  client: "TEST - Abdulrahman Al-Fahad",        matterType: "Corporate",  billingType: "Billable Hours" as const },
  { ref: "TEST - Employment Dispute Matter",  client: "TEST - Sara Al-Mutairi",             matterType: "Litigation", billingType: "Fixed / Project-Based Fees" as const },
  { ref: "TEST - Banking & Finance Matter",   client: "TEST - Khalid Al-Qahtani",           matterType: "Corporate",  billingType: "Retainers" as const },
  { ref: "TEST - Contract Review Matter",     client: "TEST - Nora Al-Harbi",               matterType: "Corporate",  billingType: "Advisory / Special Mandates" as const },
  { ref: "TEST - Intellectual Property Matter", client: "TEST - Faisal Al-Dosari Trading Co.", matterType: "Corporate", billingType: "Blended" as const },
];

const TEST_TASKS = [
  { title: "TEST - Initial client meeting completed", assignee: "TEST - Omar Al-Zahrani",  matter: "TEST - Corporate Advisory Matter" },
  { title: "TEST - Draft agreement under review",     assignee: "TEST - Reem Al-Saud",      matter: "TEST - Corporate Advisory Matter" },
  { title: "TEST - Follow-up call scheduled",         assignee: "TEST - Majed Al-Nasser",   matter: "TEST - Employment Dispute Matter" },
  { title: "TEST - Documents received from client",   assignee: "TEST - Huda Al-Rashid",    matter: "TEST - Banking & Finance Matter" },
  { title: "TEST - Matter status update required",    assignee: "TEST - Omar Al-Zahrani",   matter: "TEST - Contract Review Matter" },
  { title: "TEST - Financial review required",        assignee: "TEST - Faisal Al-Dosari",  matter: "TEST - Intellectual Property Matter" },
];

async function main() {
  const caller = adminCaller();
  const created = { users: [] as string[], clients: [] as string[], matters: [] as string[], rates: 0, tasks: [] as string[], actions: 0, financials: 0 };
  const skipped = { users: 0, clients: 0, matters: 0, rates: 0, tasks: 0, actions: 0, financials: 0 };

  // ── 1) Test users ──────────────────────────────────────────────────────────
  const existingUsers = await caller.users.list();
  const userIdByName = new Map<string, number>();
  for (const u of existingUsers) userIdByName.set(u.name, u.id);
  for (const u of TEST_USERS) {
    const existing = existingUsers.find(e => e.email === u.email || e.name === u.name);
    if (existing) { userIdByName.set(u.name, existing.id); skipped.users++; continue; }
    const newUser = await caller.users.create({
      name: u.name, email: u.email, password: TEMP_PASSWORD, role: u.role as any, status: "active",
    });
    userIdByName.set(u.name, newUser.id);
    created.users.push(`${u.name} <${u.email}> [${u.role}] #${newUser.id}`);
  }

  // ── 2) Test clients ─────────────────────────────────────────────────────────
  const existingClients = await caller.clients.list({});
  const clientIdByName = new Map<string, number>();
  for (const c of existingClients) clientIdByName.set(c.clientName, c.id);
  for (const c of TEST_CLIENTS) {
    if (clientIdByName.has(c.clientName)) { skipped.clients++; continue; }
    const nc = await caller.clients.create({
      clientName: c.clientName,
      clientStatus: "Existing Client",
      clientNumber: c.clientNumber,
      matterType: c.matterType,
    });
    clientIdByName.set(c.clientName, nc.id);
    created.clients.push(`${c.clientName} #${nc.id}`);
  }

  // ── 3) Test matters + assignments ───────────────────────────────────────────
  const leadPartnerId = userIdByName.get("TEST - Omar Al-Zahrani");
  const attorneyIds = [userIdByName.get("TEST - Reem Al-Saud"), userIdByName.get("TEST - Majed Al-Nasser")].filter((x): x is number => !!x);
  const matterIdByRef = new Map<string, number>();
  for (const m of TEST_MATTERS) {
    const clientId = clientIdByName.get(m.client);
    if (!clientId) continue;
    const existing = await caller.clientMatters.list({ clientId });
    let found = existing.find(x => x.matterReference === m.ref);
    if (found) { matterIdByRef.set(m.ref, found.id); skipped.matters++; }
    else {
      const nm = await caller.clientMatters.create({
        clientId,
        matterReference: m.ref,
        matterType: m.matterType,
        matterStatus: "Active",
        billingType: m.billingType,
        priority: "high",
        leadLawyerId: leadPartnerId,           // Lead Partner: Omar
        supportLead: "TEST - Huda Al-Rashid",  // Support Lead (free-text field)
        matterDescription: `${m.ref} (QA test matter)`,
        acknowledgeConflicts: true,
      });
      matterIdByRef.set(m.ref, nm.id);
      created.matters.push(`${m.ref} #${nm.id} (client #${clientId}, lead #${leadPartnerId})`);
    }
    // Attorneys as billable lawyers (matter_lawyer_rates) — Reem & Majed
    const mid = matterIdByRef.get(m.ref)!;
    const rates = await caller.matterLawyerRates.list({ clientMatterId: mid });
    for (const aid of attorneyIds) {
      if (rates.some(r => r.userId === aid)) { skipped.rates++; continue; }
      await caller.matterLawyerRates.create({
        clientMatterId: mid, userId: aid, role: "Attorney", hourlyRate: "1500", currency: "SAR", isActive: true,
      });
      created.rates++;
    }
  }

  // Rejected clients are locked (no new tasks/actions/financials). Skip their
  // sub-records — never modify the client's status.
  const freshClients = await caller.clients.list({});
  const rejectedClientIds = new Set(freshClients.filter((c: any) => c.clientStatus === "Rejected").map((c: any) => c.id));

  // ── 4) Test tasks (assigned to test users) ──────────────────────────────────
  const allTasks = await caller.tasks.list({});
  for (const t of TEST_TASKS) {
    if (allTasks.some(x => x.title === t.title)) { skipped.tasks++; continue; }
    const matterId = matterIdByRef.get(t.matter);
    const matterDef = TEST_MATTERS.find(m => m.ref === t.matter);
    const clientId = matterDef ? clientIdByName.get(matterDef.client) : undefined;
    if (clientId && rejectedClientIds.has(clientId)) { skipped.tasks++; continue; }
    const assignedTo = userIdByName.get(t.assignee);
    const nt = await caller.tasks.create({
      title: t.title,
      description: `QA test task — ${t.title}`,
      status: "todo",
      priority: "medium",
      clientId,
      clientMatterId: matterId,
      assignedTo,
      dueDate: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    });
    created.tasks.push(`${t.title} #${nt.id} → ${t.assignee} (#${assignedTo})`);
  }

  // ── 5) Test action logs (Action Logs page) ──────────────────────────────────
  const ACTIONS = [
    { client: "TEST - Abdulrahman Al-Fahad", matter: "TEST - Corporate Advisory Matter", owner: "TEST - Omar Al-Zahrani", type: "Meeting", details: "TEST - Initial client meeting completed" },
    { client: "TEST - Sara Al-Mutairi",      matter: "TEST - Employment Dispute Matter", owner: "TEST - Majed Al-Nasser", type: "Call",    details: "TEST - Follow-up call scheduled" },
    { client: "TEST - Khalid Al-Qahtani",    matter: "TEST - Banking & Finance Matter",  owner: "TEST - Huda Al-Rashid",  type: "Document", details: "TEST - Documents received from client" },
  ];
  for (const a of ACTIONS) {
    const clientId = clientIdByName.get(a.client);
    if (!clientId) continue;
    if (rejectedClientIds.has(clientId)) { skipped.actions++; continue; }
    const existing = await caller.clientActions.list({ clientId });
    if (existing.some((x: any) => x.actionDetails === a.details)) { skipped.actions++; continue; }
    await caller.clientActions.create({
      clientId,
      clientMatterId: matterIdByRef.get(a.matter),
      actionOwner: a.owner,
      actionType: a.type,
      actionDetails: a.details,
      nextStep: "TEST - awaiting next step",
      actionDate: new Date().toISOString().slice(0, 10),
    });
    created.actions++;
  }

  // ── 6) Test financial records (exercise discount/outstanding formulas) ───────
  const FINANCIALS = [
    { client: "TEST - Abdulrahman Al-Fahad", matter: "TEST - Corporate Advisory Matter", feeType: "Billable Hours" as const, agreedFees: "10000", discountApproval: "CEO" as const, revenue: "3000", collectedAmount: "1000", collectionStatus: "Partially Collected" as const, responsibleLawyer: "TEST - Omar Al-Zahrani" },
    { client: "TEST - Khalid Al-Qahtani",    matter: "TEST - Banking & Finance Matter",  feeType: "Retainers" as const,     agreedFees: "50000", discountApproval: "Board" as const, revenue: "20000", collectedAmount: "20000", collectionStatus: "Fully Collected" as const, responsibleLawyer: "TEST - Reem Al-Saud" },
  ];
  for (const f of FINANCIALS) {
    const clientId = clientIdByName.get(f.client);
    const matterId = matterIdByRef.get(f.matter);
    if (!clientId) continue;
    if (rejectedClientIds.has(clientId)) { skipped.financials++; continue; }
    const existing = await caller.financial.list({ clientId });
    if (existing.length > 0) { skipped.financials++; continue; }
    await caller.financial.create({
      clientId,
      clientMatterId: matterId,
      feeType: f.feeType,
      agreedFees: f.agreedFees,
      discountApproval: f.discountApproval,
      revenue: f.revenue,
      collectedAmount: f.collectedAmount,
      collectionStatus: f.collectionStatus,
      responsibleLawyer: f.responsibleLawyer,
      financeNotes: "TEST - QA financial record (not real data)",
    });
    created.financials++;
  }

  console.log("\n=== TEST DATA SEED RESULT ===");
  console.log("Created:", JSON.stringify(created, null, 2));
  console.log("Skipped (already existed):", JSON.stringify(skipped));
  console.log("Temp password for all TEST- users:", TEMP_PASSWORD);
  console.log("Done.");
}

main()
  .then(async () => { await getRawClient().end(); process.exit(0); })
  .catch(async (err) => { console.error("Seed failed:", err?.message ?? err, err?.stack ?? ""); await getRawClient().end(); process.exit(1); });
