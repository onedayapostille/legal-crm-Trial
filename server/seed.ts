/**
 * Production seed script.
 * Creates exactly one initial admin account from environment variables.
 */
import "dotenv/config";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { users } from "../drizzle/schema";
import { hashPassword } from "./_core/auth";
import { normalizeEmail } from "./db";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;
const adminName = process.env.ADMIN_NAME || "System Administrator";

if (!adminEmail || !adminPassword) {
  throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required to seed the initial admin");
}

if (adminPassword.length < 8 || !/[A-Za-z]/.test(adminPassword) || !/[0-9]/.test(adminPassword)) {
  throw new Error("ADMIN_PASSWORD must be at least 8 characters and include a letter and a number");
}

const client = postgres(url);
const db = drizzle(client);

async function seed() {
  const email = normalizeEmail(adminEmail!);
  const [userCount] = await db.select({ count: count() }).from(users);
  const totalUsers = Number(userCount?.count ?? 0);

  if (totalUsers > 0) {
    const [existingAdmin] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existingAdmin) {
      console.log(`Admin already exists for ${email}; no changes made.`);
    } else {
      console.log("Users already exist; seed did not create another admin.");
    }
    await client.end();
    return;
  }

  const passwordHash = await hashPassword(adminPassword!);
  await db.insert(users).values({
    email,
    name: adminName,
    passwordHash,
    role: "admin",
    status: "active",
  });

  console.log(`Initial admin created for ${email}.`);
  await client.end();
}

seed().catch(async err => {
  console.error("Seed failed:", err);
  await client.end();
  process.exit(1);
});
