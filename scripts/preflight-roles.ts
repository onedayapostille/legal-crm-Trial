/**
 * Read-only role-migration preflight (Phase 3).
 *
 * Reports account counts per role and how each maps under the approved plan
 * (auto / manual-HR / needs-decision / unknown). It is STRICTLY READ-ONLY — a
 * single `SELECT ... GROUP BY role` — and emits NO personal data (only role names
 * and counts). It never writes, migrates, or re-grades anyone.
 *
 * Usage (LOCAL disposable DB only — never point this at production):
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app \
 *     npx tsx scripts/preflight-roles.ts
 *
 * Exit code is always 0 on success; a non-empty "unknown" bucket is surfaced in
 * the output for human review rather than failing the run.
 */
import "dotenv/config";

const { getRawClient } = await import("../server/db");
const { buildPreflightReport, formatPreflightReport } = await import("../shared/policy/migration");

async function main() {
  const client = getRawClient();
  // Read-only aggregate: role + count only. No id/name/email is selected.
  const rows = (await client.unsafe(
    `SELECT role::text AS role, COUNT(*)::int AS count
       FROM users
      GROUP BY role
      ORDER BY count DESC, role ASC`,
  )) as unknown as Array<{ role: string; count: number }>;

  const report = buildPreflightReport(rows.map(r => ({ role: r.role, count: Number(r.count) })));
  console.log(formatPreflightReport(report));

  if (report.unknown.length > 0) {
    console.log(
      `\n[preflight] NOTE: ${report.unknown.length} unrecognized role(s) present — ` +
        `review manually before any controlled migration.`,
    );
  }
}

try {
  await main();
} finally {
  await getRawClient().end();
}
