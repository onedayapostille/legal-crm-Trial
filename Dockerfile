FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@10 --force

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV APP_RELEASE="crm-runtime-envbake-2026-06-22"
ENV PORT=3000
# NOTE: live secrets baked in to work around the host not injecting App Settings
# at runtime. TEMPORARY — rotate these and move to runtime env on the new server.
ENV DATABASE_URL="postgresql://postgres.pdjqncgbuclsugqbcyhe:Anoosve%23%23*S@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require"
ENV JWT_SECRET="493b960b0dc88a0595aa6388f9b1c5c2c82c6a114ff91ba6c28e21b702879dd0"
ENV AUTH_SECRET="493b960b0dc88a0595aa6388f9b1c5c2c82c6a114ff91ba6c28e21b702879dd0"

# AI Assistant (NVIDIA NIM). Same "host doesn't inject runtime env" workaround as
# the DB/JWT above. TEMPORARY — this key is exposed in git history; ROTATE it once
# the assistant is confirmed working, and move to real runtime env injection.
# A --build-arg still overrides this default if your build supports it.
ARG NVIDIA_API_KEY="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"
ENV NVIDIA_API_KEY=$NVIDIA_API_KEY
ENV NVIDIA_BASE_URL="https://integrate.api.nvidia.com/v1"
ENV NVIDIA_MODEL="google/diffusiongemma-26b-a4b-it"

RUN npm install -g pnpm@10 --force

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

EXPOSE 3000

CMD ["node", "dist/index.js"]
