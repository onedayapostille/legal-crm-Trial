/**
 * Read-only policy-era preflight. Prints counts only; no names, email addresses,
 * or mutations. Run before deploying the 0026 application build.
 */
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ override: false });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");

const sql = postgres(url, { max: 1, prepare: false });
try {
  const [{ present }] = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'users'
        AND column_name = 'authorization_model'
    ) AS present
  `;
  const rows = present
    ? await sql.unsafe(`
        SELECT role::text AS role,
               authorization_model::text AS authorization_model,
               count(*)::int AS count
          FROM users
         GROUP BY role, authorization_model
         ORDER BY role, authorization_model
      `)
    : await sql.unsafe(`
        SELECT role::text AS role,
               CASE WHEN role::text IN (
                 'head_of_practice','senior_associate','executive_associate',
                 'associate','junior_lawyer','trainee','paralegal','coordinator'
               ) THEN 'target (0026 deterministic backfill)'
               ELSE 'legacy (0026 deterministic backfill)'
               END AS authorization_model,
               count(*)::int AS count
          FROM users
         GROUP BY role
         ORDER BY role
      `);
  console.log("AGP CRM authorization-era preflight (read-only)");
  console.log(`authorization_model column present: ${present ? "yes" : "no"}`);
  console.table(rows);
} finally {
  await sql.end();
}
