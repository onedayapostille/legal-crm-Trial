# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@10 --force

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── Stage 2: Production runtime ──────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV APP_RELEASE="emergency-baked-env-2026-06-20"

# ═══════════════════════════════════════════════════════════════════════════════
#  TEMPORARY EMERGENCY CONFIG — REMOVE AFTER DUBLYO ENV INJECTION IS FIXED
# ═══════════════════════════════════════════════════════════════════════════════
# WHY: The Dublyo platform is not injecting App Settings env vars into the runtime
# container, so DATABASE_URL/JWT_SECRET arrive empty and the app is down (login →
# "service temporarily unavailable"). Baking them into the image restores service.
#
# SECURITY — READ BEFORE USING:
#   * Baked ENV values are visible via `docker history` / image inspect, and once
#     real values are committed they live in git history FOREVER.
#   * Therefore: ROTATE the DB password and JWT_SECRET after Dublyo env injection
#     is fixed and this block is removed. Treat both as compromised.
#   * The committed values below are PLACEHOLDERS. Replace them with the REAL,
#     CURRENT values BEFORE building (keep the surrounding quotes). Use the current
#     Dublyo DB — NOT the old Supabase URL from git history.
#
# Less-leaky alternatives, in order of preference (use if at all possible):
#   1) Fix Dublyo runtime env injection (the real fix), or
#   2) `docker run -e DATABASE_URL=... -e JWT_SECRET=...`, or a mounted /assets/.env
#      (server/_core/index.ts already loads /assets/.env, /.env, .env), THEN
#   3) only as a last resort, paste real values here and commit.
#
# >>> INSERT REAL VALUES HERE (replace the <…> placeholders; keep the quotes) <<<
ENV DATABASE_URL="<PASTE_CURRENT_DATABASE_URL_HERE>"
ENV JWT_SECRET="<PASTE_CURRENT_JWT_SECRET_HERE>"
# ═══════════════════════════════════════════════════════════════════════════════
#  END TEMPORARY EMERGENCY CONFIG
# ═══════════════════════════════════════════════════════════════════════════════

RUN npm install -g pnpm@10 --force

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

EXPOSE 3000

CMD ["node", "dist/index.js"]
