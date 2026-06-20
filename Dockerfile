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
ENV APP_RELEASE="env-presence-diagnostic-2026-06-20"

# SECURITY: Secrets (DATABASE_URL, JWT_SECRET, etc.) are NOT baked into the image.
# They must be supplied at runtime via environment variables, e.g.:
#   docker run -e DATABASE_URL=... -e JWT_SECRET=... ...
# or via docker-compose `env_file: .env` (see docker-compose.yml).
# Required runtime variables are documented in README.md and .env.example.

RUN npm install -g pnpm@10 --force

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

EXPOSE 3000

CMD ["node", "dist/index.js"]
