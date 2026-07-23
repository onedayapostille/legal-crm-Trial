import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import {
  can,
  leadLawyerOverlayApplies,
  scopeFor,
  type Capability,
  type Scope,
} from '@shared/permissions';
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
 * Capability gate (central policy: shared/permissions.ts). The resolved data
 * scope is attached as ctx.authzScope for row filtering downstream.
 *
 * options.allowLeadLawyerOverlay: let a request through even when the base
 * scope is NONE, provided the role can hold the per-matter Lead Lawyer
 * designation — row-level conditions then restrict results to led matters
 * (used for financial READ endpoints only, per the overlay definition).
 */
export function capabilityProcedure(
  capability: Capability,
  options?: { allowLeadLawyerOverlay?: boolean },
) {
  return t.procedure.use(requireUser).use(
    t.middleware(async opts => {
      const { ctx, next } = opts;

      const role = ctx.user!.role;
      const scope: Scope = scopeFor(role, capability);
      const overlayOk =
        options?.allowLeadLawyerOverlay === true && leadLawyerOverlayApplies(role);

      if (scope === "NONE" && !overlayOk) {
        throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
      }

      return next({
        ctx: {
          ...ctx,
          user: ctx.user!,
          authzScope: scope,
        },
      });
    }),
  );
}

/** Convenience: any of the listed capabilities grants access (view/manage splits). */
export function anyCapabilityProcedure(capabilities: Capability[]) {
  return t.procedure.use(requireUser).use(
    t.middleware(async opts => {
      const { ctx, next } = opts;
      const role = ctx.user!.role;
      if (!capabilities.some(cap => can(role, cap))) {
        throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
      }
      return next({ ctx: { ...ctx, user: ctx.user! } });
    }),
  );
}

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.status !== "active" || ctx.user.role !== 'admin') {
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
