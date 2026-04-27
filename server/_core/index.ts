import { config as loadDotenv } from "dotenv";
import fs from "fs";

// Load any supplementary .env files (local dev, mounted volumes, etc.)
const envCandidates = ["/assets/.env", "/assets/env", "/.env", ".env"];
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    loadDotenv({ path: p, override: false });
  }
}

// Build DATABASE_URL from POSTGRES_* vars if injected by platform
if (!process.env.DATABASE_URL && process.env.POSTGRES_PASSWORD) {
  const user         = process.env.POSTGRES_USER ?? "postgres";
  const password     = encodeURIComponent(process.env.POSTGRES_PASSWORD);
  const explicitHost = process.env.POSTGRES_HOST     ??
                       process.env.POSTGRES_HOSTNAME ??
                       process.env.PGHOST            ??
                       process.env.DB_HOST;
  const host         = explicitHost ?? "localhost";
  const port         = process.env.POSTGRES_PORT ?? "5432";
  const db           = process.env.POSTGRES_DB   ?? "app";
  const sslParam     = "";
  process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}:${port}/${db}${sslParam}`;
  console.log(`[Server] DATABASE_URL built from POSTGRES_* vars — host: ${host}, ssl: ${!explicitHost}`);
}

import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { ensureAdminExists, getRawClient, runMigrations } from "../db";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  console.log("[Server] NODE_ENV:", process.env.NODE_ENV ?? "(not set)");
  console.log("[Server] APP_RELEASE:", process.env.APP_RELEASE ?? "(not set)");
  console.log("[Server] DATABASE_URL:", process.env.DATABASE_URL ? "SET ✓" : "NOT SET ✗");
  console.log("[Server] JWT_SECRET:", process.env.JWT_SECRET ? "SET ✓" : "NOT SET ✗");

  const app = express();
  const server = createServer(app);

  app.set("trust proxy", true);
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  app.get("/health", (_req, res) => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    let databaseHost: string | null = null;
    let databasePort: string | null = null;
    try {
      const parsed = new URL(databaseUrl);
      databaseHost = parsed.hostname;
      databasePort = parsed.port || null;
    } catch {
      // Keep health endpoint available even if DATABASE_URL is malformed.
    }
    res.json({
      ok: true,
      ts: Date.now(),
      release: process.env.APP_RELEASE ?? "unknown",
      databaseUrlSet: Boolean(databaseUrl),
      databaseUrlHasSslMode: databaseUrl.includes("sslmode="),
      databaseHost,
      databasePort,
      jwtSecretSet: Boolean(process.env.JWT_SECRET),
    });
  });

  app.get("/health/db", async (_req, res) => {
    try {
      await getRawClient().unsafe("select 1");
      res.json({ ok: true, ts: Date.now() });
    } catch (err: any) {
      res.status(503).json({
        ok: false,
        ts: Date.now(),
        error: err?.message ?? String(err),
        cause: err?.cause?.message ?? null,
        code: err?.code ?? err?.cause?.code ?? null,
      });
    }
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({ router: appRouter, createContext })
  );

  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000", 10);
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`[Server] Port ${preferredPort} busy — using ${port}`);
  }

  server.listen(port, "0.0.0.0", () => {
    console.log(`[Server] Running on http://0.0.0.0:${port}`);
  });

  runMigrations()
    .then(() => ensureAdminExists())
    .catch(err => console.warn("[Server] DB setup warning:", (err as Error).message));
}

startServer().catch(console.error);
