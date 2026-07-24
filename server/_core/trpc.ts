import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import {
  authorize,
  satisfiesLegacyPermission,
  type KnownCapability,
  type PolicyDecision,
} from '@shared/policy';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  if (ctx.user.status !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Account is not active" });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

/**
 * Server-side authorization check against the centralized policy engine
 * (shared/policy). Returns the full typed decision so callers can read the
 * resolved DataScope. The actor is always the authenticated session user — role
 * and scope are NEVER taken from request input.
 */
export function serverAuthorize(
  user: NonNullable<TrpcContext["user"]>,
  capability: KnownCapability,
): PolicyDecision {
  return authorize({
    id: user.id,
    role: user.role,
    authorizationModel: user.authorizationModel,
    status: user.status,
  }, capability);
}

/**
 * Capability-gated procedure — the Phase-2 successor to permissionProcedure. Runs
 * the policy engine for the given typed capability, throws a consistent FORBIDDEN
 * on denial (never revealing record existence), and exposes the decision as
 * `ctx.authz` (with the resolved scope) for actor-aware resolvers/query filtering.
 *
 * Routes are migrated onto this incrementally; until then permissionProcedure
 * remains the compatibility bridge (below).
 */
export function capabilityProcedure(capability: KnownCapability) {
  return t.procedure.use(requireUser).use(
    t.middleware(async opts => {
      const { ctx, next } = opts;
      const decision = serverAuthorize(ctx.user!, capability);
      if (!decision.allowed) {
        throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
      }
      return next({
        ctx: {
          ...ctx,
          user: ctx.user,
          authz: decision,
        },
      });
    }),
  );
}

/**
 * @deprecated Compatibility bridge for routes not yet migrated to
 * {@link capabilityProcedure}. Retains the Phase-1 boolean `hasPermission` check
 * verbatim so migrated and unmigrated routes coexist with identical behavior.
 * Remove once every route uses a typed capability. Tracked in docs/AUTHZ_PHASES.md.
 */
export function permissionProcedure(permission: string) {
  return t.procedure.use(requireUser).use(
    t.middleware(async opts => {
      const { ctx, next } = opts;

      if (!satisfiesLegacyPermission({
        id: ctx.user!.id,
        role: ctx.user!.role,
        authorizationModel: ctx.user!.authorizationModel,
        status: ctx.user!.status,
      }, permission)) {
        throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
      }

      return next({
        ctx: {
          ...ctx,
          user: ctx.user,
        },
      });
    }),
  );
}

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (
      !ctx.user
      || ctx.user.status !== "active"
      || !serverAuthorize(ctx.user, "users:manage").allowed
    ) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
