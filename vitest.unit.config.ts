import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // These suites create database fixtures or otherwise require DATABASE_URL.
      // CI runs them only in a separately approved integration environment.
      exclude: [
        "server/conversionRate.test.ts",
        "server/financeInvoiceEditing.test.ts",
        "server/financialReports.test.ts",
        "server/financialRevenue.test.ts",
        "server/matterTypeAndAttorneyCreate.test.ts",
        "server/matterTypeCoverage.test.ts",
        "server/recentLeads.test.ts",
      ],
    },
  }),
);
