# MIZAN v1.0 image — multi-stage build (boilerplate for the target environment).
# The sandbox runs `bun run dev` instead; this file documents the container path.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run db:generate && bun run build

FROM node:22-slim AS web
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Dubai
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD curl -f http://localhost:3000/api/v1/health/ready || exit 1
CMD ["node", "server.js"]

FROM node:22-slim AS api
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Dubai MIZAN_ROLE=api
COPY --from=build /app ./
CMD ["bun", "scripts/api.ts"]

FROM node:22-slim AS worker
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Dubai MIZAN_ROLE=worker
COPY --from=build /app ./
CMD ["bun", "scripts/worker.ts"]
