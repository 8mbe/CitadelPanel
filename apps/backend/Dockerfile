# CitadelPanel Bun node agent.
#
# Runs on each game-server node with access to Docker and server data. The API
# is machine-to-machine only and every route requires NODE_TOKEN/AGENT_TOKEN.
#
# Build context is the REPOSITORY ROOT, not this directory: the workspace
# lockfile lives there, and an install without it is an unpinned install.
#
#   docker build -f apps/backend/Dockerfile -t citadel-agent .

FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
# Scoped to this workspace: the agent has no business carrying the panel's
# Next.js tree, and it must not carry anything that only the panel needs.
RUN bun install --frozen-lockfile --production --filter=backend

FROM base AS runtime
ENV NODE_ENV=production

# The whole install tree, not just /app/node_modules. A filtered install does
# not hoist to the workspace root: bun puts the agent's dependencies in
# /app/apps/backend/node_modules and leaves the root empty, so copying only the
# root produced an image whose every `import "ssh2"` failed at runtime. Copying
# /app is layout-agnostic, and the deps stage holds nothing but manifests and
# the lockfile besides.
COPY --from=deps /app ./
COPY package.json ./
COPY apps/backend/package.json apps/backend/tsconfig.json ./apps/backend/
COPY apps/backend/src ./apps/backend/src

# Runs as root on purpose: the agent's whole job is the Docker socket, whose
# group id differs per host. Its containment boundary is `paths.ts` and the
# bearer token, not a uid.
WORKDIR /app/apps/backend
RUN mkdir -p /var/lib/citadel/servers

# Agent HTTP/WS API.
EXPOSE 8081
# SFTP (own listener, same process). Set SFTP_PORT=0 to disable.
EXPOSE 8022

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun --eval "await fetch('http://localhost:' + (process.env.AGENT_PORT || 8081) + '/v1/health', { headers: { authorization: 'Bearer ' + (process.env.NODE_TOKEN || process.env.AGENT_TOKEN) } }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/server.ts"]
