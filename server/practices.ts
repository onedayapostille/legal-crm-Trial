/**
 * Head-of-Practice responsibility + OWN_PRACTICE write enforcement (Phase 5).
 *
 * A "practice" is a (location, matter_type) pair with one responsible Head of
 * Practice (the `practices` table). A record's practice is derived from its
 * (city, matter_type) natural key — clients directly, client_matters via their
 * parent client's city. HoP READS stay ALL (handled by the policy/scoping layer);
 * only CREATE/EDIT are OWN_PRACTICE and enforced here.
 *
 * Fail-closed rules (§G):
 *   - Any write capability whose resolved scope is neither ALL nor OWN_PRACTICE
 *     is denied.
 *   - Under OWN_PRACTICE, a record is writable only if its (location, matter_type)
 *     maps to a practice this actor heads. Null/legacy/unmapped → denied.
 *   - On EDIT, BOTH the current and the proposed (location, matter_type) must be
 *     in the actor's practice — this prevents self-claiming a record (pulling it
 *     into your practice) or pushing it into another head's practice via the
 *     scope-defining fields.
 *
 * Nothing here is reachable by a live account (no head_of_practice role is live),
 * so it is dormant until account migration; tests drive it with a HoP actor.
 */
import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { authorize } from "@shared/policy";
import type { Actor } from "./scoping";
import { practices, clients, clientMatters } from "../drizzle/schema";
import { getDb } from "./db";

/** A record's practice coordinates. Either field may be null (unclassified). */
export interface PracticeKey {
  location: string | null | undefined;
  matterType: string | null | undefined;
}

/** The responsible Head-of-Practice user id for a (location, matter_type), or null. */
export async function getPracticeHead(
  location: string | null | undefined,
  matterType: string | null | undefined,
): Promise<number | null> {
  if (!location || !matterType) return null;
  const db = getDb();
  const [row] = await db
    .select({ headId: practices.headOfPracticeId })
    .from(practices)
    .where(and(eq(practices.location, location as any), eq(practices.matterType, matterType as any)))
    .limit(1);
  return row?.headId ?? null;
}

/**
 * The practice key of a financial record: location = its client's city;
 * matter type = the linked matter's type if any, else the client's own type.
 * Used to enforce OWN_PRACTICE on financial create/edit (Phase 7).
 */
export async function financialRecordPracticeKey(
  clientId: number,
  clientMatterId: number | null | undefined,
): Promise<PracticeKey> {
  const db = getDb();
  const [c] = await db
    .select({ city: clients.city, matterType: clients.matterType })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  let matterType: string | null | undefined = c?.matterType ?? null;
  if (clientMatterId != null) {
    const [m] = await db
      .select({ matterType: clientMatters.matterType })
      .from(clientMatters)
      .where(eq(clientMatters.id, clientMatterId))
      .limit(1);
    if (m?.matterType) matterType = m.matterType;
  }
  return { location: c?.city ?? null, matterType };
}

const FORBIDDEN = new TRPCError({ code: "FORBIDDEN", message: "You do not have required permission (10002)" });

/** Throw unless the given practice key is a practice the actor heads. */
async function assertInActorPractice(actor: Actor, key: PracticeKey): Promise<void> {
  const head = await getPracticeHead(key.location, key.matterType);
  // Null location/matter_type or unmapped practice → unclassified → fail closed.
  if (head == null || head !== actor.id) throw FORBIDDEN;
}

/**
 * Enforce a create/edit against the actor's write scope for `capability`.
 *   - ALL           → unrestricted (Admin, legacy firm-wide writers).
 *   - OWN_PRACTICE   → proposed (and, for edits, existing) practice must be the
 *                      actor's own; otherwise FORBIDDEN.
 *   - anything else  → FORBIDDEN (fail closed).
 * `existing` is omitted for creates, supplied for edits.
 */
export async function assertOwnPracticeWrite(
  actor: Actor,
  capability: string,
  proposed: PracticeKey,
  existing?: PracticeKey,
): Promise<void> {
  const scope = authorize({
    id: actor.id,
    role: actor.role,
    authorizationModel: actor.authorizationModel,
    status: actor.status,
  }, capability).scope;
  if (scope === "ALL") return;
  if (scope !== "OWN_PRACTICE") throw FORBIDDEN;
  // Edit: the record as it stands must already be in the actor's practice
  // (cannot edit — or self-claim — a record you don't own).
  if (existing) await assertInActorPractice(actor, existing);
  // Create & edit: the resulting record must be in the actor's practice
  // (cannot place a record into another head's practice).
  await assertInActorPractice(actor, proposed);
}

// ─── Read-only legacy classification report (§H) ──────────────────────────────

export interface PracticeClassificationRow {
  location: string | null;
  matterType: string | null;
  count: number;
  practiceExists: boolean;
  headAppointed: boolean;
  writableUnderOwnPractice: boolean;
}

export interface PracticeClassificationReport {
  entity: "clients" | "client_matters";
  totalRows: number;
  classified: number;   // maps to a practice WITH a head
  unclassified: number; // null/unmapped, or practice without a head → write-fail-closed
  rows: PracticeClassificationRow[];
  note: string;
}

/**
 * Read-only classification of CLIENT rows by (city, matter_type): how many map to
 * a practice, whether that practice has an appointed head, and therefore whether
 * they would be writable under OWN_PRACTICE. Pure read — no writes, no backfill.
 * (client_matters follow the same shape, deriving location from the parent
 * client; deferred here to the clients view which is the primary classification.)
 */
export async function getClientPracticeClassification(): Promise<PracticeClassificationReport> {
  const db = getDb();
  const grouped = await db
    .select({
      location: clients.city,
      matterType: clients.matterType,
      count: sql<number>`count(*)::int`,
      headId: practices.headOfPracticeId,
      practiceId: practices.id,
    })
    .from(clients)
    .leftJoin(
      practices,
      and(eq(practices.location, clients.city), eq(practices.matterType, clients.matterType)),
    )
    .groupBy(clients.city, clients.matterType, practices.headOfPracticeId, practices.id);

  const rows: PracticeClassificationRow[] = grouped
    .map(g => {
      const practiceExists = g.practiceId != null;
      const headAppointed = g.headId != null;
      return {
        location: g.location ?? null,
        matterType: g.matterType ?? null,
        count: Number(g.count),
        practiceExists,
        headAppointed,
        // Writable under OWN_PRACTICE only when the practice exists AND has a head.
        writableUnderOwnPractice: practiceExists && headAppointed,
      };
    })
    .sort((a, b) => b.count - a.count);

  const totalRows = rows.reduce((n, r) => n + r.count, 0);
  const classified = rows.filter(r => r.writableUnderOwnPractice).reduce((n, r) => n + r.count, 0);
  return {
    entity: "clients",
    totalRows,
    classified,
    unclassified: totalRows - classified,
    rows,
    note:
      "Read-only. Rows with null/unmapped (city, matter_type) or a practice with " +
      "no appointed head are UNCLASSIFIED: readable under ALL, but not writable " +
      "under OWN_PRACTICE until a controlled classification step appoints a head. " +
      "No rows are modified and no heads are inferred.",
  };
}
