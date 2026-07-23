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
# Runtime secrets must be injected by the process manager or container runtime.
# Do not add DATABASE_URL, JWT_SECRET, AUTH_SECRET, or NVIDIA_API_KEY here.
ENV NVIDIA_BASE_URL="https://integrate.api.nvidia.com/v1"
ENV NVIDIA_MODEL="google/diffusiongemma-26b-a4b-it"

RUN npm install -g pnpm@10 --force

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

EXPOSE 3000

CMD ["node", "dist/index.js"]
