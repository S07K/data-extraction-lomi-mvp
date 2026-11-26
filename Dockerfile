# One build of the whole monorepo, then small per-service runtime images.
# Targets: migrate | api | worker | web

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@10.17.1 && apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# ---- install + build (cached on lockfile and manifests) ----
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/queue/package.json packages/queue/
COPY packages/contracts/package.json packages/contracts/
COPY packages/extraction/package.json packages/extraction/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm turbo run build --filter=@lomi/api --filter=@lomi/worker --filter=@lomi/web --filter=@lomi/db
# Self-contained production bundles for the Node services (workspace deps copied in).
RUN pnpm --filter @lomi/api deploy --prod --legacy /out/api \
 && pnpm --filter @lomi/worker deploy --prod --legacy /out/worker

# ---- migrate + seed (one-shot) ----
FROM build AS migrate
WORKDIR /repo/packages/db
ENV FIXTURES_DIR=/repo/fixtures
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/seed-cli.js"]

# ---- api ----
FROM node:24-bookworm-slim AS api
WORKDIR /app
COPY --from=build /out/api ./
USER node
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
CMD ["node", "dist/main.js"]

# ---- worker ----
FROM node:24-bookworm-slim AS worker
WORKDIR /app
COPY --from=build /out/worker ./
USER node
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]

# ---- web (Next.js standalone) ----
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
