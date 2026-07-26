import { describe, expect, it } from "vitest";
import { assertOwnPracticeWrite } from "./practices";

describe("registry-scoped client writes", () => {
  const coordinator = {
    id: 70001,
    role: "coordinator",
    authorizationModel: "target" as const,
    status: "active",
  };

  it("allows a Coordinator to create a client without practice classification", async () => {
    await expect(
      assertOwnPracticeWrite(
        coordinator,
        "clients:create",
        { location: undefined, matterType: undefined },
      ),
    ).resolves.toBeUndefined();
  });

  it("allows a Coordinator to edit a client across the registry", async () => {
    await expect(
      assertOwnPracticeWrite(
        coordinator,
        "clients:edit",
        { location: "Jeddah", matterType: undefined },
        { location: "Riyadh", matterType: "Litigation" },
      ),
    ).resolves.toBeUndefined();
  });
});
