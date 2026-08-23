# CitadelPanel Next.js UI and control plane.
#
# Build context is the REPOSITORY ROOT, not this directory: the workspace
# lockfile lives there, and an install without it is an unpinned install.
#
#   docker build -f apps/frontend/Dockerfile -t citadel-panel .

FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
# Manifests + lockfile only, so a source-only change reuses this layer.
COPY package.json bun.lock ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
RUN bun install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app ./
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# `config/env.ts` validates at import time and Next evaluates route modules
# while collecting build metadata, so the build needs values that parse, not
# values that work. Nothing connects: the db clients are lazy. Runtime env
# replaces all three (`process.env` wins over any .env file).
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV PANEL_ENCRYPTION_KEY=build-only-placeholder-key-32-characters
ENV BETTER_AUTH_SECRET=build-only-placeholder-auth-secret-32-chars
RUN bun run --cwd apps/frontend build

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs

# The whole workspace, devDependencies included. This image is not just a
# built site: it runs the migrations from source on every boot and loads a
# TypeScript `next.config.ts`, so pruning to `--production` would cost more in
# debugging than it saves in layer size.
COPY --from=builder --chown=nextjs:nextjs /app ./

USER nextjs
WORKDIR /app/apps/frontend
EXPOSE 3000

# Migrations, then serve. Deliberately NOT `bun run setup`: that also runs
# `env:init`, which would write a .env this container never reads and mint a
# fresh PANEL_ENCRYPTION_KEY that disagrees with the one compose passed in, so
# every secret already encrypted at rest becomes unreadable. Secrets are
# the operator's to supply; see docs/docker.md.
# Both migrations are idempotent, so this is the install and the upgrade path.
CMD ["sh", "-c", "bun run migrate && bun run start"]
