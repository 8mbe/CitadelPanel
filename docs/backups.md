# Backups (restic snapshots to S3)

A backup is one **restic snapshot** in the operator's S3 bucket, holding a
server's data directory *and* a SQL dump of every database it has provisioned,
taken as a single unit. Backups run asynchronously on the node, report live
progress, keep a durable log, and can be driven by an admin-configured cron
schedule.

Related: `database-explorer.md` (where the per-database scoped credentials come
from), `subusers.md` (the `backups` flag), `ports.md` and `server-links.md` (the
other per-server owner surfaces), `first-time-setup.md` (backups are configured
after setup, not during it).

## Why restic, and why in a container

The obvious implementation — tar the data directory, stream it to S3 — is wrong
for this workload. A game server's state is a world that changes *in place*, so
a full-copy backup re-uploads tens of gigabytes every night to capture a few
hundred megabytes of change. It also has no answer for the failure that actually
destroys data: a corrupted or ransomwared world overwriting the good copy,
because a sync has no concept of a point in time.

restic solves the parts that are hard to get right and easy to get wrong:

- **Content-addressed deduplication and compression.** The second snapshot of a
  30 GB world costs roughly what changed. The UI shows both numbers — bytes read
  from disk, and bytes actually uploaded — because the second is the one that
  maps to the storage bill.
- **Client-side encryption.** Data is encrypted on the node before it leaves, so
  the bucket holds no readable tenant data even if its credentials leak.
- **Immutable, timestamped snapshots.** A bad backup does not destroy a good one.
- **`forget --prune`** implements retention properly, including reclaiming the
  space, which a "delete old objects" lifecycle rule cannot do against a
  deduplicated store.

It runs in a **throwaway container** (`restic/restic`, pinned, `RESTIC_IMAGE`)
rather than being installed on each host. The agent already requires the Docker
socket, so this adds no per-node prerequisite, and it reuses the pattern the
blueprint install step already proved (`servers.ts` → `runContainerToCompletion`).

The tool containers do **not** go through `docker/hardening.ts`. That module
builds a spec for a *game* — one bind mount, published ports, a per-server
isolated network — and every one of those invariants is wrong here. What replaces
it is narrower: `backup/toolContainer.ts` drops all capabilities, sets
`no-new-privileges`, publishes no ports, caps memory, and puts the container on
its own bridge (`BACKUP_NETWORK`). That last point matters most — these
containers hold the operator's S3 credentials and a server's database password in
their environment, so no tenant container may ever share a network with them.

## One repository per server

Each server gets its own restic repository:

```
s3:https://<endpoint>/<bucket>/<prefix>/<serverId>
```

A single shared repository would deduplicate slightly better across tenants and
would mean every node holding a password that decrypts *every* tenant's data,
with `forget` for one server having to reason about another's snapshots. Separate
repositories trade that deduplication for a blast radius of exactly one server.

The repository password is minted per server on first backup (48 random bytes),
stored AES-256-GCM encrypted in `server_backup_repos`, and delivered to the agent
on every call. The agent never persists it. Two consequences worth stating
plainly, both surfaced in the admin UI:

- **Rotating `PANEL_ENCRYPTION_KEY` makes every existing snapshot permanently
  unreadable.** The stored repository passwords become undecryptable, and they
  are the only thing that opens the repositories.
- The panel is a single point of failure for *reading* backups, not for writing
  them. If the panel is rebuilt from a Postgres backup, the repository passwords
  come back with it.

Minting is race-safe (`INSERT … ON CONFLICT DO NOTHING` followed by a re-read):
two concurrent first backups must agree on the password, or the loser writes
snapshots nothing can later decrypt.

## What goes into a snapshot

Two absolute paths, at fixed mount points inside the restic container:

| Mount | Contents |
| --- | --- |
| `/data` | The server's data directory (`<SERVER_DATA_ROOT>/<serverId>`), read-only |
| `/dumps` | One `<dbname>.sql` per provisioned database |

Because the paths are absolute, `restic restore --target /` reconstructs both at
the same mount points on the way back out — no path rewriting.

### Database dumps: ordering and credentials

Databases are dumped **before** the file walk begins. Doing it the other way
round captures a database that is minutes newer than the world it belongs to,
which is the subtle kind of restore corruption that only surfaces when a player
notices their inventory does not match their balance.

Two decisions in `backup/dumps.ts`, both rejecting the more obvious option:

- **A throwaway container, not `execInContainer`.** `docker/exec.ts` buffers a
  command's whole stdout into a string — fine for a `CREATE DATABASE`, fatal for
  a multi-gigabyte dump. Running `mariadb-dump` in its own container on
  `node_db_net` with `/dumps` bind-mounted lets the dump stream to disk and never
  enter the agent's memory.
- **The scoped per-database user, not the DB admin.** The panel already decrypts
  each database's own credentials for the database explorer, and those grants
  cover exactly one database — so MariaDB itself bounds what the dump can read.
  The root-equivalent admin credential never enters the backup path.
  `--single-transaction` gives a consistent InnoDB snapshot without locking the
  game out, and `--no-tablespaces` avoids needing the global `PROCESS` privilege
  the scoped user deliberately lacks.

The dump image is resolved by **inspecting the node's own database container**
rather than pinning a version: whatever engine serves the data ships a
`mariadb-dump` that can read it, and a mismatched client is a class of corruption
that only appears at restore time.

Dumps stage in `BACKUP_STAGING_ROOT/<serverId>` — a *sibling* of the data root,
never inside it. A dump under `<SERVER_DATA_ROOT>/<id>` would be visible in the
file manager and over SFTP, so plaintext SQL of the game's database would be
readable by everyone with the `files` permission, which is not the same set of
people as those with `database`. It would also sit inside the tree restic is
walking. The staging directory is emptied before each run (a stale dump for a
deleted database would otherwise ride along forever) and cleared after the
snapshot is written.

## Asynchronous execution

A 30 GB backup takes minutes to hours. Running it inside the request that asked
for it would die on the first proxy idle timeout, could not report progress, and
would lose everything on a reconnect. So:

1. The panel writes a `server_backups` row (`pending`) — **before** calling the
   agent. If the agent call then fails, there is a durable `failed` record saying
   why. The other order loses every failure that happened before a job id existed.
2. `POST /v1/servers/:id/backups` registers an in-memory job on the agent and
   returns `202 { jobId }` immediately.
3. The agent's job dumps databases → ensures the repository → runs
   `restic backup --json` → applies retention.
4. `nodes/backupScheduler.ts` polls the job each tick, drains new log lines into
   `server_backup_logs`, and records the outcome.
5. The browser polls the panel and renders a progress bar and a live log tail.

The agent polls, the node never calls in — it has no panel credential and may be
behind NAT. Same shape as `security/watcher.ts`.

### Division of state

| Owned by the panel (durable) | Owned by the agent (in memory) |
| --- | --- |
| The run row, its log, the repository password, S3 credentials, retention, the schedule | The restic containers, the dump containers, the job's progress and log buffer |

This is what makes an agent restart survivable. The row exists before the agent
is called, so a job that has vanished becomes *a failed backup with a stated
reason*, not a row stuck at "running" forever. `backup/jobs.ts` keeps finished
jobs for an hour so a panel that restarted mid-backup can still learn the outcome
rather than reporting a false failure.

### Progress, without a second streaming implementation

restic's `--json` output is newline-delimited, and the agent reads it by **polling
the container's log tail** (`getContainerLogs`) rather than following the log
stream. Following would mean a second streaming log implementation alongside
`demuxDockerLogStream`, and `RESTIC_PROGRESS_FPS=0.2` throttles restic to one
progress line every five seconds — granular enough for a progress bar, bounded
enough to keep in a log. The parser in `backup/restic.ts` is deliberately
tolerant: a polled tail can begin or end mid-line, so anything that is not valid
JSON is skipped rather than failing the parse.

Progress is reported as a **phase** as well as a percentage. The percentage only
moves during `uploading`, so the phase is what distinguishes "stuck at 0%" from
"dumping a large database".

## Logs

`server_backup_logs` holds one row per line, sequence-numbered by the agent.
One row per line rather than an appended `TEXT` column because that is what makes
a live tail cheap: `WHERE seq > $cursor` returns only what is new, so a two-second
poll transfers a few lines instead of re-downloading a log that grows for the
length of a backup. The same cursor makes the drain idempotent — a retried poll
re-inserts nothing, thanks to `UNIQUE (backup_id, seq)`.

Logs are kept with the run and cascade-delete with it. **Failed runs are kept
alongside successful ones** — a backup that did not happen is the single most
useful thing to be able to tell an operator, and a snapshot list can only ever
show successes. That is the whole reason the panel keeps its own rows when the
repository already lists snapshots.

The agent caps its buffer at `AGENT_MAX_BACKUP_LOG_LINES` and evicts
oldest-first, because the end of a failed job's log is where the error is. The
drop count travels to the panel, so a truncated log says so once rather than
silently.

## The schedule

An admin sets a standard five-field cron expression at **Admin → Backups**,
evaluated in the panel's configured timezone. Empty means manual backups only —
which is distinct from `enabled: false`, because a working "Back up now" button
with no cron behind it is a legitimate configuration.

`lib/cron.ts` is hand-rolled rather than a dependency. What is needed is small
and exactly specified (match a `Date`, describe an expression, compute the next
run), while a cron library brings `@`-shorthands, seconds fields, `L`/`W`/`#`
extensions and its own timezone handling — none of which an operator-facing field
should accept. It is shared by the UI and the scheduler, so a schedule can never
display one thing and do another.

Three details it gets right on purpose:

- **POSIX day semantics.** When *both* day-of-month and day-of-week are
  restricted, the day matches if **either** does — `0 4 1 * mon` means "the 1st,
  and also every Monday", not their intersection. Matching the manpage matters
  because an operator's expression must do what its documentation says.
- **Real timezones, not fixed offsets.** Evaluation goes through
  `Intl.DateTimeFormat`, so `0 4 * * *` means 04:00 local on both sides of a DST
  boundary.
- **Coarse-grained search.** `nextCronRun` skips whole non-matching days and
  hours rather than stepping minute by minute, which turns a `29 feb` lookup from
  ~800k timezone conversions into a few thousand. Each skip is bounded by the
  remainder of a unit already proven empty, so no match can be missed.

### Firing

The scheduler ticks every 30 seconds (well under a minute, so a schedule naming a
specific minute is never missed). Each tick **reconciles before it fires** — a
run that has just finished must be closed out before its server is considered for
a new one — which is also why both jobs live on one timer rather than two: two
timers could start a second restic against one repository.

The double-fire guard is a **time window**, not a stored "last run at" marker:
"has a scheduled run started for this server since the top of this minute?" needs
no extra state and survives a panel restart mid-minute.

`concurrency` caps how many servers start per tick. Every concurrent backup reads
a disk and saturates a node's upstream, so on a fleet of a hundred servers the
schedule deliberately trickles rather than stampedes.

A server is skipped when it is suspended (its container is stopped pending review
— continuing to bill the operator's bucket for it is not what anyone
configured), still installing, in `error`, already running a backup, or has
`servers.backups_enabled = false`. That last flag defaults to **true**: an
operator who configures a destination and a schedule means "back up my fleet",
and a per-server opt-in would leave most servers silently unprotected. Owners can
opt an individual server out from its backups tab.

## Retention

`restic forget --prune --tag citadel`, applied after every backup, scoped to our
own tag so a repository an operator also uses by hand is not pruned on our rules.

The defaults keep a month of history at decreasing granularity — 3 most recent,
7 daily, 4 weekly, 6 monthly. `keepLast` being non-zero is load-bearing: it
guarantees a very recent backup survives even if the clock or the schedule is
misconfigured.

**An all-zero policy means keep everything, not delete everything.** `restic
forget` with no `--keep-*` rule deletes every snapshot, so `retainsAnything()`
gates the call and an absent policy in a request body parses to keep-everything.
A default that quietly destroys data is not a default.

Retention failure is **non-fatal**: a snapshot that was written but not pruned is
a successful backup with a housekeeping problem, and reporting it as a failed
backup would be a lie. The next backup retries it.

## Restore

Owner or admin only — `backups` is enough to *take* a backup, but a restore
overwrites a world and every database in the snapshot.

1. The panel stops the server and marks it `stopped`. This is not a courtesy:
   restic would otherwise be writing world files the running server has open and
   cached, and the server would overwrite half of them on its next save.
2. `restic restore <snapshot> --target /` rebuilds `/data` and `/dumps`.
3. Each dump is re-imported by a throwaway `mariadb` container, as the same
   scoped user.
4. The server is left **stopped**, and the UI offers a separate "Start the
   server" button — so the owner can look at the restored state before players
   reconnect, and a restore that only half-worked is not immediately handed to a
   live game.

Two deliberate limits:

- **No `--delete`.** A restore *overlays* the snapshot rather than making the
  data directory byte-identical to it. Handing a filesystem-wide delete to a tool
  running as root inside a container is a far worse failure mode than a few stale
  files, which the owner can clear from the file manager.
- **A dump missing from the snapshot is skipped with a log line, not an error.**
  It means that database was provisioned after the backup was taken, and losing
  the rest of the restore over it would be worse. A dump import is not
  transactional (`mariadb-dump` output contains its own DDL, which MariaDB cannot
  roll back), so a failed import leaves that one database partially restored —
  which is reported rather than hidden.

## Deletion

Snapshot first (`forget --prune`), then the panel row. The other order would
orphan the snapshot on a prune failure — paid for forever with nothing in the UI
referencing it. A snapshot the agent reports as already gone counts as success, so
a retried delete completes.

## Permissions

| Action | Requires |
| --- | --- |
| List, status, logs, take a backup | `backups` |
| Include/exclude from the schedule | `settings` (it is a property of the server, like its env) |
| Restore, delete, list repository snapshots | Owner or admin |
| Configure the destination, schedule, retention | Admin |

Reads gate with writes, per the project rule: a subuser with only `console` must
not be able to enumerate a server's backup history.

## Configuration

Panel-side, at **Admin → Backups** (stored in the `backups` `panel_settings` key,
secret access key AES-256-GCM encrypted): enable, endpoint, region, bucket,
prefix, access key ID, secret access key, cron schedule, concurrency, retention,
exclude globs.

The endpoint is stored as a **bare host with no scheme**, and the agent rejects
one that carries a scheme (`backup/wire.ts`). restic accepts `s3:http://…` for a
plaintext endpoint, and silently shipping an operator's bucket credentials in the
clear is not a mistake worth supporting. The admin form strips a pasted
`https://` rather than rejecting the whole form over it.

The **Test connection** button runs on a real node, not on the panel — a node is
what has to reach S3, and it may sit behind a different egress path. It probes a
*repository* path rather than merely listing the bucket, because the credential
that can list but not write is the one operators actually misconfigure. A
repository that does not exist yet counts as success: that is the expected state
before the first backup, and initialising one to prove connectivity would leave
debris in the bucket.

Agent-side (`.env` on each node):

| Variable | Default | Purpose |
| --- | --- | --- |
| `RESTIC_IMAGE` | `restic/restic:0.19.1` | Pinned, not `latest` — a repository written by one restic version and read by another is a thing to opt into |
| `BACKUP_STAGING_ROOT` | `<SERVER_DATA_ROOT>/../backup-staging` | Dump staging and restic's chunk cache |
| `BACKUP_NETWORK` | `citadel_backup_net` | Dedicated bridge for tool containers |
| `AGENT_MAX_BACKUP_LOG_LINES` | `2000` | Per-job log buffer cap |

restic's chunk cache is kept per server under the staging root between runs.
Without it every incremental backup re-downloads the repository index from S3
before it can decide what changed — slow, and a real per-request bill. The cache
holds no plaintext tenant data, since repository contents are encrypted.

## What is not backed up

The panel's own PostgreSQL database. `server_backups` covers *game servers* — a
server's files and its provisioned databases. The control plane's metadata
(accounts, nodes, audit logs, **and the repository passwords that open every
snapshot**) is the operator's responsibility to back up by ordinary means, and it
must be, since without it the snapshots in S3 cannot be decrypted.

## Files

| Path | Role |
| --- | --- |
| `apps/backend/src/backup/restic.ts` | Repository URL, argv, env, `--json` parsing (pure; tested) |
| `apps/backend/src/backup/dumps.ts` | `mariadb-dump` / import via throwaway containers |
| `apps/backend/src/backup/toolContainer.ts` | Running tool containers, log-tail progress polling |
| `apps/backend/src/backup/jobs.ts` | In-memory async job registry and log buffer (tested) |
| `apps/backend/src/backup/run.ts` | Backup / restore orchestration |
| `apps/backend/src/backup/wire.ts` | Request validation (tested) |
| `apps/frontend/lib/cron.ts` | Cron parsing, matching, next-run, descriptions (tested) |
| `…/services/backupManager.ts` | Rows, repository passwords, credential assembly, audit |
| `…/nodes/backupScheduler.ts` | Reconcile in-flight runs; fire the schedule |
| `…/nodes/nodeBackupApi.ts` | Typed agent client |
| `…/routes/backups.ts` | HTTP handlers |
| `…/db/migrations/020_server_backups.sql` | Schema and the `backups` setting seed |
| `components/server/backups-tab.tsx` | Owner-facing tab: status, progress, log tail, history |
| `components/admin/backup-settings.tsx` | Destination, schedule, retention |
