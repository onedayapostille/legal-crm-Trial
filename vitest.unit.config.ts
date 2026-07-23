import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    // Conservative allowlist: these suites were verified with DATABASE_URL
    // explicitly empty. Everything else is treated as integration coverage.
    include: [
      "server/auth.logout.test.ts",
      "server/normalizeForConflict.test.ts",
      "server/nvidia.test.ts",
    ],
  },
});
