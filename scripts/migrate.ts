import "dotenv/config";

const { getRawClient, runMigrations } = await import("../server/db");

try {
  await runMigrations();
  console.log("[DB] All migrations completed.");
} finally {
  await getRawClient().end();
}
