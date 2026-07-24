import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

describe("production deployment safety", () => {
  it("does not bake credential values into the Dockerfile", () => {
    const dockerfile = fs.readFileSync(
      path.join(repositoryRoot, "Dockerfile"),
      "utf8",
    );

    for (const name of [
      "DATABASE_URL",
      "JWT_SECRET",
      "AUTH_SECRET",
      "NVIDIA_API_KEY",
    ]) {
      expect(dockerfile).not.toMatch(
        new RegExp(`^\\s*(?:ENV|ARG)\\s+${name}=`, "m"),
      );
    }
  });

  it("never runs database migrations during application startup", () => {
    const entrypoint = fs.readFileSync(
      path.join(repositoryRoot, "server", "_core", "index.ts"),
      "utf8",
    );

    expect(entrypoint).not.toContain("await runMigrations()");
    expect(entrypoint).not.toMatch(
      /import\s*\{[^}]*\brunMigrations\b[^}]*\}\s*from\s*["']\.\.\/db["']/s,
    );
  });
});
