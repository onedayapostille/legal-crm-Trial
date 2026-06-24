import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import {
  isNvidiaConfigured,
  assertNvidiaConfigured,
  testNvidiaConnection,
  NVIDIA_NOT_CONFIGURED_MESSAGE,
} from "./_core/nvidia";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;
function callerFor(role: string, id: number) {
  const user: AuthenticatedUser = {
    id, openId: `test-${role}-${id}`, email: `u${id}@example.com`, name: `User ${id}`,
    loginMethod: "manus", role: role as any, status: "active",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
}

// These tests run OFFLINE: with no NVIDIA_API_KEY set in the test environment,
// the key guards short-circuit before any network call is attempted.
describe("NVIDIA key configuration + safe handling (no key in test env)", () => {
  it("isNvidiaConfigured() is false when NVIDIA_API_KEY is unset", () => {
    expect(isNvidiaConfigured()).toBe(false);
  });

  it("assertNvidiaConfigured() throws the exact safe message (no key material)", () => {
    expect(() => assertNvidiaConfigured()).toThrow(NVIDIA_NOT_CONFIGURED_MESSAGE);
    expect(NVIDIA_NOT_CONFIGURED_MESSAGE).toBe("NVIDIA API key is not configured on the server.");
  });

  it("testNvidiaConnection() reports the safe not-configured message and no key", async () => {
    const result = await testNvidiaConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toBe(NVIDIA_NOT_CONFIGURED_MESSAGE);
    // The result must never carry the key or any auth material.
    const serialized = JSON.stringify(result);
    expect(serialized.toLowerCase()).not.toContain("bearer");
    expect(Object.keys(result).sort()).toEqual(["message", "ok"]);
  });
});

describe("ai.testNvidia route — admin only, key never exposed", () => {
  it("rejects a non-admin with FORBIDDEN (before any NVIDIA call)", async () => {
    const lawyer = callerFor("lawyer", 2);
    await expect(lawyer.ai.testNvidia()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a finance user with FORBIDDEN", async () => {
    const finance = callerFor("finance", 3);
    await expect(finance.ai.testNvidia()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows admin and returns a safe structured result without the key", async () => {
    const admin = callerFor("admin", 1);
    const result = await admin.ai.testNvidia();
    // No key configured in tests → safe not-configured response (no network, no key).
    expect(result.ok).toBe(false);
    expect(result.message).toBe(NVIDIA_NOT_CONFIGURED_MESSAGE);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("bearer");
  });
});
