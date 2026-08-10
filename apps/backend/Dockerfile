# CitadelPanel Bun node service.
#
# Runs on each game-server node with access to Docker and server data. The API
# is machine-to-machine only and every route requires NODE_TOKEN/AGENT_TOKEN.

FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN bun install --production

FROM base AS runtime
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

RUN mkdir -p /var/lib/citadel/servers

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun --eval "await fetch('http://localhost:8081/v1/health', { headers: { authorization: 'Bearer ' + (process.env.NODE_TOKEN || process.env.AGENT_TOKEN) } }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/server.ts"]
