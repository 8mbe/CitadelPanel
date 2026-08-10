# CitadelPanel Next.js UI and control-plane backend.

FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN bun install

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Next evaluates route modules while collecting build metadata. Runtime secrets
# replace these placeholders when the container starts.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV PANEL_ENCRYPTION_KEY=build-only-placeholder-key-32-characters
ENV BETTER_AUTH_SECRET=build-only-placeholder-auth-secret-32-chars
RUN bun run build

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs

# Keep the built application, migration scripts, and local CLI in the image.
# Startup initializes Better Auth and panel tables before serving requests.
COPY --from=builder --chown=nextjs:nextjs /app ./

USER nextjs
EXPOSE 3000

CMD ["sh", "-c", "bun run setup && bun run start"]
