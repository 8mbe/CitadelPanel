# CitadelPanel Architecture & Security Plan

> Game server hosting panel (Minecraft + others), built on Bun + Next.js + Docker + PostgreSQL.
> Security-by-design, with heuristic anti-cryptomining / abuse detection, multi-node from day one.
>
> **Current boundary:** `apps/frontend` is the Next.js UI and control-plane backend.
> It owns Better Auth, PostgreSQL, users, setup, permissions, scheduling, and all
> browser APIs. `apps/backend` is only the Bun node service that controls Docker
> and server files. There is no separate `apps/agent` workspace.

## 1. Overview

CitadelPanel lets admins spin up isolated, resource-limited Docker containers running game servers (Minecraft Java/Bedrock first, extensible to others), managed through a web dashboard, across one or many physical/virtual nodes. Security and abuse-resistance are first-class concerns:

- Every game server container is sandboxed (no privileged mode, dropped capabilities, resource caps) while still allowing normal outbound internet access (plugins/mods checking for updates, downloading dependencies, etc. must keep working).
- Auth is handled by **Better Auth**, not hand-rolled crypto.
- Exactly **2 global roles**: `user` and `admin`. Fine-grained per-server delegation is handled via **subusers**, not extra roles.
- A background watcher heuristically scores containers for cryptomining/abuse behavior and maintains a **suspicious activity list** for admin review (auto-kill is optional/off by default, because detection isn't perfect and we would rather flag than act blindly).
- **Multi-node** is a first-class concept from Phase 1: the panel is one control-plane that manages game servers across many Docker hosts ("nodes"), each potentially on a different machine.

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Control-plane runtime | Next.js Node runtime | Owns browser APIs, auth, users, setup, metadata, and node scheduling |
| Node runtime | Bun (`apps/backend`) | Narrow bearer-authenticated Docker and filesystem service on every node |
| Database | **PostgreSQL** via `postgres` + `pg` | Relational integrity for users/servers/permissions/audit logs; `pg` backs Better Auth |
| Auth | **Better Auth** (email/password + optional OAuth + 2FA plugin) | Battle-tested session/credential handling instead of hand-rolled JWT/Argon2id, which leaves fewer places for auth bugs |
| Frontend | Next.js 16 + React 19 + Tailwind 4 | Already scaffolded (`apps/frontend`); Better Auth has first-class Next.js client bindings |
| Container engine | Docker Engine API | Dynamic per-server container lifecycle, across multiple remote hosts |
| Docker client | `dockerode` (npm, Bun-compatible) | Mature, avoids hand-rolled Docker socket HTTP; supports remote hosts via TCP+TLS |
| Realtime | Native `WebSocket` (Bun built-in) | Console streaming, live stats, node agent heartbeats |

## 3. Directory Structure

```
CitadelPanel/
├── apps/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── db/
│   │   │   │   ├── client.ts            # Bun.sql Postgres connection
│   │   │   │   ├── migrations/          # SQL migration files, versioned
│   │   │   │   └── schema.sql           # canonical schema reference
│   │   │   ├── auth/
│   │   │   │   ├── betterAuth.ts        # Better Auth instance + Postgres adapter config
│   │   │   │   ├── rbac.ts              # role check (user/admin) + subuser permission check
│   │   │   │   └── middleware.ts        # requireAuth, requireAdmin, requireServerPermission
│   │   │   ├── nodes/
│   │   │   │   ├── nodeRegistry.ts      # registered nodes, health, capacity
│   │   │   │   ├── nodeClient.ts        # per-node dockerode instance (remote TCP+TLS or local socket-proxy)
│   │   │   │   ├── scheduler.ts         # picks a node for a new server (capacity-aware)
│   │   │   │   └── dbProvisioner.ts     # create/drop per-server DB+user on node-db, manage node_db_net attachment
│   │   │   ├── docker/
│   │   │   │   ├── container.ts         # create/start/stop/remove/exec (routed through nodes/nodeClient)
│   │   │   │   ├── hardening.ts         # security opts applied to every container
│   │   │   │   └── stats.ts             # polling CPU/mem/net stats per container
│   │   │   ├── games/
│   │   │   │   ├── types.ts             # GamePreset interface
│   │   │   │   └── presets/
│   │   │   │       ├── minecraft-java.ts
│   │   │   │       └── minecraft-bedrock.ts
│   │   │   ├── security/
│   │   │   │   ├── watcher.ts           # periodic abuse-heuristic scan, per node
│   │   │   │   ├── heuristics.ts        # scoring rules (CPU, network, ports)
│   │   │   │   ├── mining-indicators.ts # stratum ports + known miner binary names
│   │   │   │   └── suspiciousList.ts    # read/write suspicious_activity table
│   │   │   ├── routes/
│   │   │   │   ├── servers.ts
│   │   │   │   ├── subusers.ts          # invite/manage per-server subusers
│   │   │   │   ├── users.ts
│   │   │   │   ├── admin.ts             # suspicious list review, bans, node management
│   │   │   │   └── nodes.ts             # register/list/health of nodes
│   │   │   ├── ws/
│   │   │   │   └── console.ts           # per-server log/console streaming
│   │   │   └── services/
│   │   │       ├── serverManager.ts     # orchestrates create/start/stop across db+docker+node
│   │   │       └── auditLog.ts
│   │   ├── index.ts
│   │   └── Dockerfile
│   └── frontend/
│       ├── app/
│       │   ├── login/                   # Better Auth client screens
│       │   ├── dashboard/
│       │   ├── servers/[id]/
│       │   │   ├── console/
│       │   │   ├── files/
│       │   │   ├── settings/
│       │   │   └── subusers/            # manage per-server access
│       │   └── admin/
│       │       ├── suspicious-activity/
│       │       └── nodes/               # add/monitor nodes
│       ├── lib/
│       │   ├── authClient.ts            # Better Auth client
│       │   └── api.ts
│       └── Dockerfile
├── data/
│   └── servers/<server-id>/             # bind-mounted per-server volume (isolated per server)
├── docker-compose.yml                    # panel: backend + frontend + postgres (per-node agents deployed separately)
├── .env.example
├── plan.md
└── README.md
```

## 4. Database Schema (PostgreSQL)

Better Auth owns and manages its own tables (`user`, `session`, `account`, `verification`, plus `twoFactor`/plugin tables if enabled) via its Postgres adapter/migrations. These are not hand-written. The panel extends `user` with an app-specific `role` field via Better Auth's `additionalFields` config, avoiding a duplicate identity table.

```sql
-- Better Auth manages: user, session, account, verification (+ plugin tables)
-- user.role: 'user' | 'admin'  (exactly 2 values, enforced by app-level enum/check constraint)

-- nodes (multi-node support)
nodes(id, name, hostname, docker_endpoint, tls_ca, tls_cert, tls_key,
      cpu_total, memory_total_mb, disk_total_mb, is_active, last_heartbeat_at)

-- game presets
game_presets(id, key UNIQUE, name, docker_image, default_ports JSONB, env_schema JSONB, startup_cmd_template)

-- servers
servers(id, name, owner_id FK -> user.id, node_id FK -> nodes.id, preset_id FK -> game_presets.id,
        container_id NULL, status, cpu_limit, memory_limit_mb, disk_limit_mb, created_at)
server_env(server_id FK, key, value)      -- encrypted at rest for secrets

-- subusers: per-server delegated access, independent of the 2 global roles
server_subusers(server_id FK -> servers.id, user_id FK -> user.id, permissions JSONB, invited_by FK, created_at)
-- permissions example: { "console": true, "files": true, "start_stop": true, "settings": false, "backups": false }

-- security / abuse detection
suspicious_activity(id, server_id FK, reason, score, detail JSONB, detected_at, reviewed, reviewed_by FK NULL)
audit_logs(id, user_id FK NULL, action, target_type, target_id, ip, created_at, metadata JSONB)
-- NOTE: a `mining_pool_blocklist` table was specified in an earlier revision and
-- has been removed. See §9.1 (a host list is defeated by proxying stratum
-- through an attacker-controlled domain).
```

All secrets (`server_env` values holding tokens/API keys) are encrypted with a panel-wide key (AES-256-GCM) before storage. They are never stored in plaintext, even in the DB.

## 5. Roles & Permissions Model

Exactly **2 global roles**, kept simple on purpose:

- **`admin`** has full control: manage all servers (including their resource limits), manage nodes, review suspicious activity, manage users, manage game presets.
- **`user`** owns their own servers, manages their own servers' subusers, no access to admin routes.

**Subusers** are the delegation mechanism for anything more granular (e.g. a `user` inviting a friend to help admin one specific Minecraft server):

- Scoped to a single server (`server_subusers` row), not a global role.
- Permission flags per subuser: console access, file manager, start/stop, settings edit, backups. Server owner assigns these when inviting.
- Subusers never gain visibility into the owner's other servers or account settings.
- Admin routes are still gated purely on `user.role === 'admin'`. Subuser permissions never grant admin capability.

## 6. Auth (Better Auth)

- `apps/frontend/lib/server/control-plane/auth/betterAuth.ts` configures Better Auth with the Postgres adapter, email/password provider enabled, and an `additionalFields` entry for `role` (`"user" | "admin"`, default `"user"`).
- Session cookies are httpOnly, `SameSite=Strict`, Secure in production. That is Better Auth's default cookie-session handling, with no custom JWT signing needed.
- Optional: enable Better Auth's `twoFactor` plugin for admin accounts (TOTP), and `rateLimit` plugin (built into Better Auth) on auth endpoints to blunt credential stuffing.
- Browser credential requests stay same-origin under Next.js `/api/auth/*`.
- Next.js middleware modules under `lib/server/control-plane/auth` validate the Better Auth session on each request, then layer global roles and server-scoped subuser permissions.
- First admin account: seeded via a one-time setup script / first-registered-user-becomes-admin flag (configurable), never a hardcoded default credential.

## 7. Multi-Node Architecture

The panel backend is the single control-plane; **nodes** are the machines that actually run game-server containers.

- Each node runs Docker with its Engine API exposed over **TCP + mutual TLS** (client cert auth) rather than the raw unprivileged unix socket, since the backend may be remote. For a node co-located with the backend, a local `docker-socket-proxy` (restricted API surface) is used instead of raw socket access.
- `nodes` table stores each node's connection info (`docker_endpoint`, TLS client cert/key/CA, all encrypted at rest) plus reported capacity (`cpu_total`, `memory_total_mb`, `disk_total_mb`) and a `last_heartbeat_at` for health monitoring.
- `nodes/nodeClient.ts` maintains one `dockerode` client per registered node; `nodes/scheduler.ts` picks a node for a new server based on available capacity vs. requested resource limits (simple bin-packing initially, most-free-capacity-first).
- `security/watcher.ts` iterates all active nodes and polls containers on each. Abuse detection is node-aware from day one, not bolted on later.
- Admin UI (`/admin/nodes`) lists nodes, health, current load, and lets an admin add a new node (paste Docker endpoint + upload/generate TLS client cert) or drain/deactivate one.
- Server creation flow always resolves through a node. Even a single-node deployment is just "one row in the `nodes` table," so there's no special-cased single-node code path to later refactor away.

## 7.1 Shared Per-Node Database Server (auto-provisioned databases)

Many Minecraft plugins (and other games) expect a MySQL-compatible database. Rather than giving every server its own DB container (wasteful, and DB engines are annoying to run one-per-tenant), each **node** runs exactly one shared database server that any server on that node can request a database from.

### 7.1.1 Topology
- Each node runs one **MariaDB/MySQL** container (`node-db`), deployed once per node alongside that node's Docker daemon, separate from the panel's own control-plane Postgres.
- `node-db` sits on a dedicated Docker network, `node_db_net`, created per node.
- `node_db_net` is **not** reachable from: the panel's control-plane (`panel_net`), other nodes, or the public internet. It has no published host ports. Only containers explicitly attached to it can reach `node-db`.
- A server's container joins `node_db_net` **only if** the user has provisioned a database for that server; servers with no database never touch this network.
- **Cross-tenant isolation on the shared network**: since multiple servers' containers may be attached to the same `node_db_net` to reach `node-db`, plain bridge networking would let them reach each other too. To prevent that, `node_db_net` is created with inter-container communication disabled (`com.docker.network.bridge.enable_icc=false`), plus a targeted `DOCKER-USER` iptables rule (managed by `nodes/dbNetwork.ts`) that allows traffic **only** to `node-db`'s container IP on its DB port. Net effect: every attached server can reach `node-db`, none can reach each other.

### 7.1.2 Auto-provisioning flow
When a user clicks "Create Database" for their server:
1. Backend connects to that node's `node-db` using a stored admin credential (`nodes.db_admin_user`, `nodes.db_admin_password_encrypted`, AES-256-GCM at rest, same key material as other panel secrets).
2. Generates: a database name (`db_<serverId-short>`), a dedicated DB username (`u_<serverId-short>`), and a cryptographically random password (32+ chars, `crypto.randomUUID()`-class entropy or better).
3. Runs `CREATE DATABASE`, `CREATE USER`, and `GRANT ALL PRIVILEGES ON <db>.* TO <user>`, scoped strictly to that one database, no broader grants, no access to other tenants' databases on the same `node-db` instance.
4. Attaches the server's container to `node_db_net` (if not already attached).
5. Stores the credentials in `server_databases` (password encrypted at rest) and surfaces host/port/db/user to the dashboard (password shown once, then masked with a "reveal" action) and/or injects them as env vars the game server can consume.
6. Deleting the database (or the server) drops the DB/user on `node-db` and detaches the container from `node_db_net`.

### 7.1.3 Schema addition
```sql
-- extends `nodes` (per-node shared DB server connection, admin-only)
-- nodes.db_admin_host, nodes.db_admin_port, nodes.db_admin_user, nodes.db_admin_password_encrypted

server_databases(id, server_id FK -> servers.id, node_id FK -> nodes.id,
                  db_name, db_user, db_password_encrypted, host, port, created_at)
```

### 7.1.4 Risk note
Disabling ICC + custom `DOCKER-USER` iptables rules is more fragile than Docker's out-of-the-box networking primitives. It must be re-applied idempotently whenever `node-db` or a server container is (re)created, and is a good candidate for an integration test (spin up two dummy server containers on `node_db_net`, assert they cannot reach each other, assert both can reach `node-db`).

## 8. Docker Isolation & Hardening (revised for plugin/mod compatibility)

Full network isolation (blocking all outbound traffic) is **not** used, because Minecraft plugins/mods routinely need outbound HTTPS (version checks, Spigot/Modrinth/CurseForge API calls, dependency downloads). Instead, isolation focuses on blocking *lateral* movement and unnecessary *inbound* exposure, while leaving normal outbound internet access intact:

- `--security-opt=no-new-privileges`, `cap_drop: ALL` (add back only what's strictly required, normally nothing for game servers).
- No `--privileged`, no `--pid=host`, no `--network=host`.
- Each server's container sits on its own Docker bridge network, **isolated from other containers and from the panel's own services** (backend, Postgres). Containers cannot reach each other or the control-plane laterally.
- **Outbound internet access is allowed by default** (standard Docker bridge NAT) so plugin update checks, mod downloads, etc. keep working normally.
- Only the game's required ports are published inbound; nothing else is exposed.
- Explicit CPU (`--cpus`) and memory (`--memory`) hard limits, with no bursting beyond the server's plan, which also bounds the blast radius of any undetected miner.
- Root filesystem read-only where the game image supports it, with a single writable bind mount for the server's data directory.
- The panel's own containers (backend, frontend, postgres) run on a separate `panel_net`; game-server networks cannot reach it (DB, admin API, etc. stay unreachable from any hosted server).

Net effect: game servers keep full, normal outbound connectivity (so plugins/mods work exactly as if self-hosted), while the panel's control-plane, the database, and other tenants' servers remain unreachable from within any given server container. The isolation boundary is "can't attack the panel or other tenants," not "can't reach the internet."

## 9. Anti-Cryptomining / Abuse Detection

Perfect detection is not realistic (sophisticated miners can throttle/hide), and since outbound traffic is now intentionally permitted (for plugin compatibility), detection leans more on **behavioral heuristics** rather than blanket network blocking. The system **flags, scores, and lists** suspicious servers for admin review rather than silently auto-banning.

### 9.1 Detection signals (`security/heuristics.ts`)
A background watcher (`security/watcher.ts`) polls each running container every N seconds via `docker/stats.ts`, per node, and scores it.

**Scope: node abuse only.** These heuristics exist to detect theft of the node's compute, cryptomining above all. They deliberately do *not* police what happens inside a game. Griefing, op abuse, plugin crash-loops and similar are the server owner's problem, not the platform's; flagging them would bury the signals that actually matter and put the panel in the position of refereeing other people's communities.

| Signal | Heuristic | Weight |
|---|---|---|
| Sustained high CPU | CPU usage >90% continuously for >15 min, atypical for the game's usual load pattern | High |
| CPU with near-zero I/O | High CPU but near-zero disk/network I/O (miners compute, don't do game I/O) | High |
| Suspicious outbound ports | Connections to known stratum/mining ports (3333, 4444, 5555, 7777, 14444, 45700) | High |
| Off-game-process binary names | If exec/process inspection is available, matching known miner binary names (`xmrig`, `minerd`, `cpuminer`) | Medium |
| Unexpected connection volume | Large number of distinct outbound IPs/high-frequency connections inconsistent with the game's normal profile (plugin update checks are occasional and low-volume, while mining pool traffic is persistent/high-frequency) | Medium |

**Deliberately not implemented: the mining-pool host blocklist.** An earlier revision matched outbound connections against a `mining_pool_blocklist` table seeded from public lists. It has been removed: a host list is trivially defeated by proxying stratum through a domain the miner controls, so it costs ongoing maintenance while catching only the laziest abuse, and its high weight (45) made it the single largest contributor to a score that could be evaded with one DNS record. The surviving indicators are properties of the *protocol* (stratum ports) and of the *container* (miner binary names), neither of which a proxy hides.

Scores accumulate; crossing a configurable threshold writes a row to `suspicious_activity` with the reason + raw detail (never auto-deletes the server).

### 9.2 Suspicious Activity List
- Admin dashboard page (`/admin/security`) lists flagged servers, score, reasons, timestamp, node, and a "reviewed" toggle.
- Admin can then manually: suspend the server, message the owner, permanently ban, or dismiss the flag as a false positive.
- Optional (config flag, off by default): **auto-suspend** if score exceeds a hard emergency threshold. This is opt-in per deployment, since false positives are costly for legitimate heavy workloads. The threshold must stay below the 130-point ceiling the weights allow, or enabling it would have no effect.

### 9.3 Defense in depth beyond detection
- Hard CPU/memory caps (§8) limit the *damage* a miner can do even if undetected. It can't exceed the plan's resource allocation or affect other tenants/host. With host blocklisting removed, this is the primary mitigation: detection is best-effort, but the resource ceiling is enforced by the kernel and cannot be evaded.
- Panel control-plane and other tenants stay unreachable regardless of what runs inside a given container (§8's lateral-isolation guarantee holds even if mining goes undetected).

## 10. Game Presets

```ts
interface GamePreset {
  key: string;                // "minecraft-java"
  name: string;
  dockerImage: string;
  defaultPorts: { container: number; protocol: "tcp" | "udp" }[];
  envSchema: Record<string, { required: boolean; default?: string }>;
  startupCommandTemplate: string;
  expectedResourceProfile: "bursty" | "steady-low" | "steady-high"; // feeds heuristics baseline
}
```

Adding a new game = one new preset file, no core changes. Phase 1 ships `minecraft-java` and `minecraft-bedrock`.

## 11. Docker Orchestration Flow

1. User requests new server → `serverManager.ts` validates the requesting user's plan limits & (if acting on someone else's server) subuser permissions.
2. `nodes/scheduler.ts` picks a target node with sufficient free capacity.
3. Preset resolved (`games/presets/*.ts`) → image, ports, env schema, startup command.
4. `docker/container.ts` creates the container via that node's `dockerode` client, applying all hardening options from `docker/hardening.ts`.
5. Data directory `data/servers/<id>/` created and bind-mounted (on the target node's disk).
6. Container started; `servers.status` and `servers.node_id` updated; `audit_logs` entry written.
7. `security/watcher.ts` picks up the new container automatically on its next poll of that node.
8. Stop/delete reverses the process; volume retained unless explicit delete-with-data is requested (extra confirmation).

## 12. Deployment (`docker-compose.yml`)

Runs the **panel control-plane** only. Game servers are created dynamically by the backend on whichever node is targeted, not declared here:

```yaml
services:
  postgres:      # internal network only, volume-persisted
  frontend:      # Next.js control plane; depends on Postgres and calls registered nodes
  backend:       # local Bun/Docker node only; no database or user/auth secrets
```

Each additional **node** is provisioned separately (just needs Docker installed + Engine API reachable via TLS, or the local socket-proxy sidecar if co-located with the backend) and then registered from `/admin/nodes`.

## 13. Phased Roadmap

1. **Phase 1, Core**: Postgres schema + migrations, Better Auth integration (2 roles), multi-node registry + scheduler, Docker hardening layer, Minecraft Java preset, create/start/stop/delete server flow, basic dashboard.
2. **Phase 2, Realtime & Files**: WebSocket console streaming, sandboxed file manager, live stats, subuser invite/management UI.
3. **Phase 3, Security hardening**: watcher + heuristics + suspicious activity list + admin review UI.
4. **Phase 4, Expansion**: additional game presets (Bedrock, Rust, Valheim...), backups, per-node capacity dashboards.

## 14. Known Risks & Trade-offs

- Allowing outbound internet from game containers (for plugin/mod compatibility) means network-level abuse detection is necessarily heuristic/behavioral rather than a hard block. Accepted trade-off, mitigated by resource caps + the suspicious-activity list.
- Remote node Docker endpoints (TCP+TLS) are a real attack surface if a node's TLS client cert leaks, mitigated by encrypting stored certs/keys at rest and scoping each node's trust to only the panel's CA.
- Heuristic abuse detection has false positives/negatives by nature, hence "list for review," not "auto-destroy," as the default posture.
- Better Auth outsources session/credential correctness to a maintained library, reducing (not eliminating) custom-auth-bug risk; panel-specific logic (role, subusers) is still custom and reviewed accordingly.
- Multi-node from day one adds scheduling complexity even for single-node deployments, accepted because retrofitting multi-node later is much costlier than designing for it up front.
- The shared per-node database server (§7.1) relies on disabled inter-container communication + custom `DOCKER-USER` iptables rules rather than pure Docker network isolation. That is more fragile than a fully isolated per-server DB, and must be covered by an integration test asserting cross-tenant unreachability on `node_db_net`.

---

# 15. Implementation Progress Log

> Running record of what has actually been built, what deviated from the plan above, and what remains. Updated as work lands.

## 15.1 Status Summary

| Phase | Scope | Status |
|---|---|---|
| **Phase 1, Core** | Postgres schema + migrations, Better Auth (2 roles), multi-node registry + scheduler, Docker hardening, Minecraft presets, create/start/stop/delete flow | **Backend complete**, dashboard not started |
| Phase 2, Realtime & Files | WS console streaming, file manager, live stats, subuser UI | Partial. Subuser API + stats/logs endpoints done, WebSocket & file manager not started |
| Phase 3, Security hardening | Watcher, heuristics, suspicious list, admin review | **Backend complete**, admin review UI built |
| Phase 4, Expansion | More presets, backups | Not started |

**Test coverage:** 81 unit tests passing, `tsc --noEmit` clean.

## 15.2 Entry: Phase 1 & 3 backend implementation

### Delivered

**Configuration & crypto**
- `src/config/env.ts`: all env resolved and validated **at import time**, so a misconfigured deployment fails at boot rather than at first request. `PANEL_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` are hard-required (no insecure defaults).
- `src/lib/crypto.ts`: AES-256-GCM encryption for secrets at rest, with a per-value random salt + IV and a `v1.` version prefix so the scheme can be migrated later without orphaning old rows. Also `generateStrongPassword` (40 chars, alphanumeric-only so values are safe in connection strings).
- `src/lib/http.ts`: `HttpError` + typed helpers, request-body validation, exact-origin CORS (not a wildcard, since auth uses credentialed cookies).

**Database**
- `src/db/migrations/001_initial_schema.sql`: every table from §4 and §7.1.3, plus one addition: **`server_ports`** (see deviations).
- `src/db/migrate.ts`: forward-only runner, one transaction per file, recorded in `schema_migrations`. Explicitly asserts Better Auth's tables exist first and fails with an actionable message, since panel tables have FKs to `"user"`.

**Auth & authorization**
- `src/auth/betterAuth.ts`: Better Auth with the `role` field as an `additionalFields` entry, `input: false` so **a signup request can never set its own role**. First-user-becomes-admin runs in a post-creation DB hook. Rate limiting enabled on auth endpoints.
- `src/auth/rbac.ts`: `resolveServerAccess` with precedence admin > owner > subuser. `sanitizePermissions` drops unknown keys so a client cannot invent permission names.
- `src/auth/middleware.ts`: `requireAuth` / `requireAdmin` / `requireServerPermission` / `requireServerOwner`. Role is read defensively: an unexpected value degrades to `user`, never to `admin`.

**Docker layer**
- `src/docker/hardening.ts`: the single chokepoint for container security. `cap_drop: ALL`, `no-new-privileges`, no privileged/host namespaces, hard CPU+memory caps with swap disabled, `PidsLimit`, capped log size, per-server network. Throws rather than returning a config if asked for unlimited CPU/memory or a privileged host port.
- `src/docker/container.ts`: lifecycle ops, all idempotent (already-started, already-stopped and already-gone are treated as success so flows are retryable). Includes `stripDockerLogHeaders` for Docker's multiplexed log framing.
- `src/docker/stats.ts`: normalises Docker's cumulative counters into usable percentages; subtracts page cache from memory usage so containers do not all look near their limit.

**Multi-node**
- `src/nodes/nodeRegistry.ts`: CRUD with encryption at the boundary. Two distinct shapes: `NodeWithSecrets` (internal) and `PublicNode` (API), so credentials cannot leak through a response by accident.
- `src/nodes/nodeClient.ts`: cached per-node `dockerode` clients, keyed with a connection fingerprint so re-registering a node invalidates its stale client. Refuses a TLS endpoint with no client certificate.
- `src/nodes/scheduler.ts`: most-free-capacity-first placement. Scoring is a **pure function** (`selectNode`) and fully unit-tested; compares nodes by *fraction* free so heterogeneous nodes compare fairly.

**Games**
- `src/games/types.ts`: `GamePreset` contract. `resolveEnv` **drops unknown env keys** rather than passing them through, since some images treat env as privileged configuration.
- Presets for `minecraft-java` and `minecraft-bedrock`, plus `src/games/registry.ts` which upserts code-defined presets into the DB on boot (code is the source of truth; the table is a projection so `servers.preset_id` can be a real FK).

**Orchestration**
- `src/services/serverManager.ts`: create/start/stop/restart/suspend/delete. Consistent ordering rule: **DB record first, then Docker**, because a row with no container is recoverable while a container with no row is an invisible orphan. Failed provisioning lands in `error` status (not deleted) so it can be inspected.
- `src/services/auditLog.ts`: typed action union; audit failures are logged and swallowed so a lost log line never breaks the operation it records.

**Security / abuse detection**
- `src/security/mining-indicators.ts`: stratum port classification (unambiguous vs. ambiguous) and known miner binary names with word-boundary matching. Static, no DB dependency.
- `src/security/heuristics.ts`: all seven signals from §9.1 as pure, individually-tested functions.
- `src/security/suspiciousList.ts`: flag storage with a **1-hour suppression window** so a running miner cannot bury the admin's review queue in duplicate rows.
- `src/security/watcher.ts`: periodic per-node sweep with rolling in-memory observation windows. Errors are contained per node and per container (one bad node must not blind the whole watcher), overlapping sweeps are skipped, and dead servers are evicted from the state map.

**API**: `src/routes/{servers,subusers,nodes,users,admin}.ts` and `src/server.ts` (`Bun.serve()` with native `routes`, no Express).

**Deployment**: `docker-compose.yml` (control-plane only), both `Dockerfile`s (non-root users), `.env.example`, `.gitignore`.

### Deviations from the plan above

1. **Better Auth cannot use `Bun.sql`** (§6 assumed it could reuse the pool). Better Auth talks to Postgres through Kysely and accepts a `pg` `Pool` or connection string only. Resolution: `src/db/client.ts` exports **both**: `sql` (Bun.sql) for all panel queries, and `authPool` (`pg`) used *exclusively* by Better Auth. Same database, so one source of truth; the extra dependency is the cost of not hand-rolling auth.

2. **Added a `server_ports` table** (not in §4). Port allocation needs a `UNIQUE(node_id, host_port, protocol)` constraint to be safe under concurrent server creation. Without it, two simultaneous creates could race onto the same host port and one container would fail to bind. The DB constraint is the real guard; the allocator scan is only an optimisation.

3. **Trimmed the mining-port list.** §9.1 lists `8080` as a mining indicator. Excluded: it is far too common for legitimate plugin/mod update traffic, and §8 deliberately keeps egress open for exactly that. Since §8 permits outbound HTTP(S), treating `8080` as evidence would generate constant false positives. Ports are now split into `UNAMBIGUOUS_MINING_PORTS` (high weight) and ambiguous ones like `7777` (lower weight, also a game port).

4. **Auto-suspend requires corroboration, not just a score.** §9.2 gates auto-suspend on a score threshold. Implemented as threshold **AND** a high-confidence signal (an unambiguous stratum port). A heavy modpack server can produce a high behavioural score; suspending it would be exactly the costly false positive §9.2 warns about. Still off by default, and its default threshold (115) is kept below the 130-point weight ceiling so that enabling it actually does something.

5. **`node_db_net` provisioning (§7.1) not yet implemented.** `server_databases` and the `nodes.db_admin_*` columns exist in the schema, and `attachToNetwork`/`detachFromNetwork` are in place, but `dbProvisioner.ts` and the ICC/iptables management are deferred. See §15.3. Nothing in the current code path depends on them.

6. **Connection- and process-level inspection is stubbed.** The watcher currently supplies resource-behaviour data only; `connections` and `processCommandLines` arrive empty. The heuristics degrade gracefully (those rules simply do not fire) and are already fully tested against synthetic data, so wiring a real source later needs no changes to the scoring logic.

### Deliberate security decisions worth re-reading before changing

- **The Docker socket is NOT mounted into the backend container.** A socket mount makes a backend compromise equivalent to host root. The backend reaches nodes over mutual TLS, or via a restricted socket-proxy.
- **Deleting a server is owner-or-admin only** and is not a delegable subuser permission, as with subuser management itself. Otherwise a delegated grant could escalate.
- **A user with no relationship to a server gets 404, not 403.** Confirming a server exists to an unrelated user is an information leak.
- **Server data is retained on delete** unless `?deleteData=true` is passed explicitly.
- **An admin cannot change their own role, and the last admin cannot be demoted**, so there is no accidental lockout.
- **Node deletion is blocked while servers reference it** (FK `ON DELETE RESTRICT`); orphaning running containers is worse than a failed request.

### Verification

- `bun test`: 81 passing (hardening 20, crypto 17, scheduler 15, heuristics 29).
- `tsc --noEmit`: clean.
- The heuristics suite deliberately includes false-positive cases: plugin-repository HTTPS traffic, a busy modpack server with pegged CPU, and a JVM command line containing a miner-like substring must all **not** be flagged.
- Not yet verified end-to-end: no live Postgres or Docker daemon has been exercised. Migrations, container creation and the watcher sweep are untested against real infrastructure.

## 15.3 Next Steps

1. **End-to-end verification.** Stand up Postgres + a local Docker node, run `bun run setup`, and exercise create → start → stop → delete against a real daemon.
2. **Frontend**: Better Auth client, login/dashboard, server detail (console/settings/subusers), admin pages for nodes and suspicious activity. Currently still the default Next.js template.
3. **WebSocket console** (`ws/console.ts`): live log streaming and stdin, gated on the `console` permission.
4. **Per-node database provisioning** (§7.1): `dbProvisioner.ts`, `node_db_net` with ICC disabled, the `DOCKER-USER` rule manager, and the cross-tenant unreachability integration test §7.1.4 calls for.
5. **Real connection/process inspection** to activate the network and process heuristics that are currently stubbed.
6. **Disk quota enforcement.** `disk_limit_mb` is currently recorded and used for scheduling but not enforced at the filesystem level.

## 15.4 Frontend rework to server-first flow (2026-08-06)

Replaced the sidebar-dashboard shell with a simple two-step flow:

1. **`/`**: server selection (tiles with status + resource snapshot, demo-data fallback).
2. **`/servers/[id]`** is the server page: name/status/power actions header, then sections as real routes: console (stats cards for CPU/memory/disk/players + interactive console), files, database, ports, subusers, settings, activity. Files/database/ports are placeholders; the rest carry over the previously built UI. `/servers/[id]` itself redirects to `/servers/[id]/console` so both addresses reach the console.

Notes:

- Sections are routes (`/servers/[id]/<section>`) so each is linkable/bookmarkable; the active-section underline nav is responsive (horizontal scroll on small screens).
- Live power state is shared across the header and sections via `ServerStatusProvider` (React context), replacing the old local-state duplication between header and console tabs.
- The sidebar component and its shadcn `sidebar.tsx`/`use-mobile` dependencies were deleted; admin pages (`/admin/servers`, `/admin/nodes`, `/admin/security`) remain reachable at their URLs under the same simple top-bar shell, with no navigation entry yet.
- Still demo-data driven; wiring to the backend stats/console endpoints is the next step.

Follow-up (same day):

- Server tiles on `/` got quick actions in the footer: **Files**, **Players**, and **Start** (shown only when the server is stopped/suspended/error, the same gating as the server page). The card title is now a stretched link so the footer buttons remain clickable.
- Added a **Players** section (`/servers/[id]/players`) listing currently connected players (demo data), plus matching demo player fixtures.

## 15.5 Setup CLI (2026-08-06)

Added `apps/backend/src/cli/`, a four-command setup tool so a new admin can go
from clone to running panel without reading source. Run as `bun run cli <cmd>`
from the repo root.

| Command | Purpose |
|---|---|
| `init` | Create/repair the repo-root `.env`, generating `PANEL_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` |
| `migrate` | Run the Better Auth migration then the panel migration, in the required order |
| `node:add` | Register a Docker node, pinging it and auto-detecting capacity before saving |
| `doctor` | Diagnose config → database → schema → nodes → local Docker, printing a fix per failure |

### Design constraints

- **No static import of `config/env.ts` from `src/cli/`.** That module validates
  at import time and throws, which is exactly the state `init` repairs; a static
  import would make the repair tool crash on the broken installs it targets.
  Commands that need `db/client`, `lib/crypto` or `nodes/*` use dynamic
  `import()` after the environment is loaded.
- **`init` never overwrites a populated secret without `--force` plus an explicit
  confirmation.** Rotating `PANEL_ENCRYPTION_KEY` makes every value encrypted
  under the old key permanently unreadable, so a re-run must be a no-op.
- **`.env` is edited in place, not regenerated**, so the explanatory comments
  from `.env.example` survive. Written with mode 600.
- **`doctor` stops descending once a prerequisite fails.** "Postgres
  unreachable" followed by six schema errors buries the one actionable line.
- **`node:add` probes before persisting.** A node that fails at registration is a
  20-second fix; one that fails at first server-create is a bug report.

### Bugs found and fixed while building this

1. **The repo-root `.env` was invisible to the backend.** Bun auto-loads `.env`
   from the CWD only and does not walk up, but `bun run dev:backend` runs with
   `cwd = apps/backend/`. A correctly-filled root `.env` therefore produced
   "Missing required environment variable", while `docker compose`, which reads
   the root file for `${VAR}` substitution, worked fine. `config/env.ts` now
   loads the repo-root file explicitly, with real environment variables still
   taking precedence so container `environment:` blocks are not overridden.

2. **`bun run auth:migrate` could never have worked.** `@better-auth/cli` loads
   its config through `jiti` (a Node loader), and `auth/betterAuth.ts`
   transitively imports `bun` via `db/client.ts`, which does not resolve outside
   the Bun runtime, failing with `Cannot find module 'bun'`. Added
   `auth/betterAuth.migrate.ts`, a schema-only config depending on `pg` alone,
   and pointed both the CLI and the `auth:migrate` script at it. It must be kept
   in sync when a field is added to `user`.

3. **`docker-compose.yml` defaulted `SUSPICION_AUTO_SUSPEND_THRESHOLD` to 150**
   while §9.1's weights cap a single observation at 130, so auto-suspend could
   never fire in a compose deployment even when explicitly enabled. Corrected to
   115, matching `config/env.ts` and `.env.example`.

### Verification

Exercised the full path against a real Postgres and Docker daemon:
`init` → `migrate` → `node:add` → `doctor` reports all green → backend boots →
`/api/health` returns ok → first registered account is promoted to `admin`.

Also verified: re-running `init` preserves secrets; declining the `--force`
rotation prompt leaves `PANEL_ENCRYPTION_KEY` intact (so existing node TLS
material stays decryptable); `--yes` and closed-stdin runs fall back to defaults
instead of hanging; `doctor` exits non-zero on failure.

`bun test`: 92 passing (16 new, covering `.env` parsing/rewriting and secret
generation). `tsc --noEmit` clean.
