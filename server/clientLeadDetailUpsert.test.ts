import { describe, expect, it } from "vitest";
import {
  normalizeClientLeadDetailData,
  upsertClientLeadDetailWithDb,
} from "./db";
import { clientLeadDetails } from "../drizzle/schema";

describe("client lead detail atomic upsert", () => {
  it("normalizes blank optional dates to SQL NULL", () => {
    expect(
      normalizeClientLeadDetailData({
        clientId: 999,
        nextActionDate: "",
        nextActionDate2: "   ",
        nextAction: "Call the client",
      }),
    ).toEqual({
      nextActionDate: null,
      nextActionDate2: null,
      nextAction: "Call the client",
    });
  });

  it("uses INSERT ON CONFLICT(client_id) instead of a read-then-insert race", async () => {
    const calls: Array<{
      table: unknown;
      values?: Record<string, unknown>;
      conflict?: { target: unknown; set: Record<string, unknown> };
    }> = [];

    const database = {
      insert(table: unknown) {
        const call = { table } as (typeof calls)[number];
        calls.push(call);
        return {
          values(values: Record<string, unknown>) {
            call.values = values;
            return {
              onConflictDoUpdate(conflict: { target: unknown; set: Record<string, unknown> }) {
                call.conflict = conflict;
                return {
                  async returning() {
                    return [{ id: 1, ...values, ...conflict.set }];
                  },
                };
              },
            };
          },
        };
      },
    };

    const result = await upsertClientLeadDetailWithDb(
      database as any,
      5,
      {
        clientSource: "email",
        nextActionDate: "",
        nextActionDate2: "2026-07-28",
        assignedLawyerId: null,
        priority: "medium",
      },
    );

    expect(result.clientId).toBe(5);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe(clientLeadDetails);
    expect(calls[0].values).toMatchObject({
      clientId: 5,
      nextActionDate: null,
      nextActionDate2: "2026-07-28",
      assignedLawyerId: null,
    });
    expect(calls[0].conflict?.target).toBe(clientLeadDetails.clientId);
    expect(calls[0].conflict?.set).not.toHaveProperty("clientId");
    expect(calls[0].conflict?.set).toMatchObject({
      nextActionDate: null,
      nextActionDate2: "2026-07-28",
    });
  });
});
