FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@10.4.1 --force

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV NVIDIA_BASE_URL="https://integrate.api.nvidia.com/v1"
ENV NVIDIA_MODEL="google/diffusiongemma-26b-a4b-it"

RUN npm install -g pnpm@10.4.1 --force

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

EXPOSE 3000

# DATABASE_URL, JWT_SECRET/AUTH_SECRET, and NVIDIA_API_KEY must be supplied
# through the runtime environment. Never bake credentials into this image.
CMD ["node", "dist/index.js"]
