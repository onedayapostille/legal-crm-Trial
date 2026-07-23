import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import type { PolicyDecision } from "@shared/policy";
import * as db from "../db";
import { getSessionFromRequest, verifySessionToken } from "./auth";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  /** The authenticated actor (role + id). Never derived from request input. */
  user: User | null;
  /**
   * The authorization decision for the current capability, populated by
   * `capabilityProcedure`. Carries the resolved DataScope for actor-aware
   * resolvers / future query filtering. Absent on unauthenticated or
   * bridge-gated (permissionProcedure) routes.
   */
  authz?: PolicyDecision;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  try {
    const token = getSessionFromRequest(opts.req);
    if (!token && opts.req.path.includes("auth.me")) {
      console.log("[Auth] auth.me without session cookie:", {
        path: opts.req.path,
        hasCookieHeader: Boolean(opts.req.headers.cookie),
        protocol: opts.req.protocol,
        forwardedProto: opts.req.headers["x-forwarded-proto"] ?? null,
      });
    }
    const session = await verifySessionToken(token);

    if (session?.userId) {
      user = await db.getUserById(session.userId);
    }
  } catch (error) {
    console.error("[Context] Auth error:", error);
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
