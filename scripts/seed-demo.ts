/**
 * DEV/QA demo seed — creates one demo client with two matters (different types)
 * and a matter-linked financial record, so the manager-video workflow can be
 * exercised end-to-end on a fresh local DB.
 *
 * Idempotent: re-running does not duplicate (it skips when the demo client and
 * its matters already exist). Safe for local dev only — never run in production.
 *
 *   tsx scripts/seed-demo.ts
 */
import "dotenv/config";
import { appRouter } from "../server/routers";
import { getRawClient } from "../server/db";
import type { TrpcContext } from "../server/_core/context";

const DEMO_CLIENT = "DEMO - Northwind Trading";

function adminCaller() {
  const user = {
    id: 1,
    openId: "seed-demo",
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
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}

async function main() {
  const caller = adminCaller();

  // 1) Demo client (find or create)
  const clients = await caller.clients.list({});
  let client = clients.find(c => c.clientName === DEMO_CLIENT);
  if (!client) {
    client = await caller.clients.create({
      clientName: DEMO_CLIENT,
      clientStatus: "Existing Client",
      clientNumber: "CL-DEMO-001",
    });
    console.log(`Created demo client #${client.id} (${client.clientName})`);
  } else {
    console.log(`Demo client already exists #${client.id}`);
  }

  // 2) Two matters with different types (Original Serial inherits from client)
  const existing = await caller.clientMatters.list({ clientId: client.id });
  const haveRef = (ref: string) => existing.some(m => m.matterReference === ref);

  if (!haveRef("NW-001")) {
    const m1 = await caller.clientMatters.create({
      clientId: client.id,
      matterReference: "NW-001",
      matterType: "Corporate",
      matterStatus: "Active",
      priority: "high",
      billingType: "Billable Hours",
    });
    console.log(`Created matter NW-001 (#${m1.id})`);
  }
  if (!haveRef("NW-002")) {
    const m2 = await caller.clientMatters.create({
      clientId: client.id,
      matterReference: "NW-002",
      matterType: "Litigation",
      matterStatus: "Active",
      priority: "medium",
      billingType: "Fixed / Project-Based Fees",
    });
    console.log(`Created matter NW-002 (#${m2.id})`);
  }

  // 3) A matter-linked financial record (Revenue is the active amount field)
  const matters = await caller.clientMatters.list({ clientId: client.id });
  const firstMatter = matters.find(m => m.matterReference === "NW-001");
  const financials = await caller.financial.list({ clientId: client.id });
  if (firstMatter && financials.length === 0) {
    const fin = await caller.financial.create({
      clientId: client.id,
      clientMatterId: firstMatter.id,
      feeType: "Billable Hours",
      agreedFees: "100000",
      discountApproval: "CEO",        // 10% → exercises the discount formula
      revenue: "60000",
      collectedAmount: "40000",
      collectionStatus: "Partially Collected",
      responsibleLawyer: "Demo Partner",
    });
    console.log(`Created financial record #${fin.id} linked to matter NW-001`);
  }

  console.log("Demo seed complete.");
}

main()
  .then(async () => { await getRawClient().end(); process.exit(0); })
  .catch(async (err) => { console.error("Seed failed:", err?.message ?? err); await getRawClient().end(); process.exit(1); });
