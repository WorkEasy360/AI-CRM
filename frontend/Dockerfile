# syntax=docker/dockerfile:1.7
# Multi-stage build for the Keel CRM frontend (Next.js standalone output).
# No secrets are needed at build or run time; API_INTERNAL_ORIGIN is a plain
# server-side setting supplied by the runtime environment.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM base AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Apply Alpine security updates so the runtime never ships known-vulnerable OS packages, and remove
# npm/npx/corepack: the standalone server only needs `node`, and npm bundles its own (often lagging)
# dependency tree that would otherwise sit unpatched in the image.
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && addgroup -g 10001 -S keel && adduser -u 10001 -S -G keel -h /app keel

COPY --from=build --chown=keel:keel /app/public ./public
COPY --from=build --chown=keel:keel /app/.next/standalone ./
COPY --from=build --chown=keel:keel /app/.next/static ./.next/static

USER 10001
EXPOSE 3000

# /health is answered by the standalone server itself (src/app/health/route.ts), without the backend;
# the ECS task definition and the CI smoke test probe the same path.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
