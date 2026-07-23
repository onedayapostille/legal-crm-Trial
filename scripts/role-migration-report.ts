// ─── RBAC migration-readiness report ─────────────────────────────────────────
// Lists every account still on a legacy role after migration 0024:
//   • lawyer — requires an explicit HR grade (senior_associate,
//     executive_associate, associate, junior_lawyer, or trainee). These are
//     intentionally NOT auto-mapped; an Admin must assign the grade in User
//     Management once HR confirms it.
//   • viewer — not part of the approved role set; has no capabilities until
//     an Admin assigns a canonical role.
//   • partner / staff — should be zero (remapped by 0024); listed as drift.
//
// Read-only: performs SELECTs only. Run with:  tsx scripts/role-migration-report.ts

import "dotenv/config";

const { getRawClient } = await import("../server/db");

const client = getRawClient();

try {
  const rows = (await client.unsafe(
    `SELECT id, email, name, role::text AS role, status::text AS status, last_login_at
       FROM users
      WHERE role::text IN ('lawyer', 'viewer', 'partner', 'staff')
      ORDER BY role, name NULLS LAST, email`,
  )) as unknown as Array<{
    id: number;
    email: string;
    name: string | null;
    role: string;
    status: string;
    last_login_at: Date | null;
  }>;

  const counts = (await client.unsafe(
    `SELECT role::text AS role, count(*)::int AS n FROM users GROUP BY role ORDER BY role`,
  )) as unknown as Array<{ role: string; n: number }>;

  console.log("─── Role distribution ───────────────────────────────────────");
  for (const c of counts) console.log(`  ${c.role.padEnd(22)} ${c.n}`);

  const lawyers = rows.filter(r => r.role === "lawyer");
  const viewers = rows.filter(r => r.role === "viewer");
  const drift = rows.filter(r => r.role === "partner" || r.role === "staff");

  console.log("\n─── Legacy 'lawyer' accounts requiring an HR grade ──────────");
  if (lawyers.length === 0) console.log("  (none — all lawyer accounts have been graded)");
  for (const u of lawyers) {
    console.log(
      `  #${u.id} ${u.email} (${u.name ?? "no name"}) — status ${u.status}, last login ${u.last_login_at ?? "never"}`,
    );
    console.log(
      "      → assign one of: senior_associate | executive_associate | associate | junior_lawyer | trainee",
    );
  }

  console.log("\n─── Legacy 'viewer' accounts (no capabilities) ──────────────");
  if (viewers.length === 0) console.log("  (none)");
  for (const u of viewers) {
    console.log(`  #${u.id} ${u.email} (${u.name ?? "no name"}) — status ${u.status}`);
  }

  if (drift.length > 0) {
    console.log("\n─── DRIFT: partner/staff rows should have been remapped by 0024 ───");
    for (const u of drift) console.log(`  #${u.id} ${u.email} — role ${u.role}`);
  }

  console.log(
    `\nSummary: ${lawyers.length} lawyer account(s) awaiting HR grade, ${viewers.length} viewer account(s) awaiting reassignment, ${drift.length} drift row(s).`,
  );
} finally {
  await client.end();
}
