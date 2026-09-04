# Backups (restic snapshots to S3)

Backups come in **two scopes, owned by different people**:

| Scope | Contents | Taken by | Kept |
| --- | --- | --- | --- |
| `server` | One server's data directory. **Files only.** | Its owner (or a subuser with `backups`) | N per server, default 5 |
| `node` | A SQL dump of **every database provisioned on one node** | An administrator | N per node, default 5 |

Both run asynchronously on the node, report live progress, keep a durable log, and
can be driven by an admin-configured cron schedule. Both go to the same
S3-compatible bucket, in separate encrypted restic repositories.

Related: `scheduler.md` (the per-server schedule an owner can point at a file
backup, which is a different thing from the admin backup cron below),
`database-explorer.md` (where per-database credentials come from),
`subusers.md` (the `backups` flag), `ports.md` and `server-links.md` (the other
per-server owner surfaces), `first-time-setup.md` (backups are configured after
setup, not during it).

## Why the two scopes are separate

This is the load-bearing decision in the feature, and the first version got it
wrong by folding a server's database dumps into its own backup.

Dumping a server's databases means reading a MariaDB instance **shared with every
other server on that node**, and doing it for all of them at once needs the node's
`db_admin` credential, which is root-equivalent on that instance. Handing that to an
owner-triggered code path means the button a tenant presses reaches into
infrastructure belonging to everyone else on the node.

So the split follows the credential:

- A server owner backs up **their own files**, using nothing privileged.
- An administrator backs up **the databases**, using the credential only they hold.

The cost is that a server's files and its database rows are no longer captured in
one atomic snapshot, so a paired restore can straddle a few hours. That is a real
downside, stated plainly in the UI ("Databases live on the node's shared database
server and are backed up separately by an administrator"). It is the right trade:
the alternative was every tenant's backup button touching a shared root credential.

## Why restic, and why in a container

The obvious implementation, tar the data directory and stream it to S3, is wrong for
this workload. A game server's state is a world that changes *in place*, so a
full-copy backup re-uploads tens of gigabytes every night to capture a few hundred
megabytes of change. It also has no answer for the failure that actually destroys
data: a corrupted or ransomwared world overwriting the good copy, because a sync has
no concept of a point in time.

restic solves the parts that are hard to get right and easy to get wrong:

- **Content-addressed deduplication and compression.** The second snapshot of a
  30 GB world costs roughly what changed. The UI shows both numbers, bytes read
  from disk and bytes actually uploaded, because the second is the one that maps
  to the storage bill.
- **Client-side encryption.** Data is encrypted on the node before it leaves, so the
  bucket holds no readable tenant data even if its credentials leak.
- **Immutable, timestamped snapshots.** A bad backup does not destroy a good one.
- **`forget --prune`** actually reclaims the space, which an S3 lifecycle rule
  cannot do against a deduplicated store.

It runs in a **throwaway container** (`restic/restic`, pinned via `RESTIC_IMAGE`)
rather than being installed on each host. The agent already requires the Docker
socket, so this adds no per-node prerequisite, and it reuses the pattern the
blueprint install step already proved (`servers.ts` → `runContainerToCompletion`).

The tool containers do **not** go through `docker/hardening.ts`. That module builds a
spec for a *game*: one bind mount, published ports, a per-server isolated network.
Every one of those invariants is wrong here. What replaces it is narrower:
`backup/toolContainer.ts` drops every capability except three, sets
`no-new-privileges`, publishes no ports, caps memory, and puts the container on its
own bridge (`BACKUP_NETWORK`). That last point matters most. These containers hold
the operator's S3 credentials and a MariaDB admin password in their environment, so
no tenant container may ever share a network with them.

### Why a backup container keeps `DAC_OVERRIDE`

Dropping *all* capabilities takes `CAP_DAC_OVERRIDE` with it, and that is the
capability that lets root ignore file permissions. Without it, root inside a
container is *weaker* than an ordinary user: it can only touch paths whose mode
grants access to `other`. Every host directory these containers are handed, whether
the restic cache, the dump staging area or a server's data directory, is owned by
the user the agent runs as, mode `0755`. So a fully-capability-stripped run could not
write any of them, and both scopes failed before taking a single backup: restic on
`open /cache/CACHEDIR.TAG: permission denied`, `mariadb-dump` on the staging
directory.

Reading every file whoever owns it *is* what a backup is, so this is the one place
where a DAC bypass is the point rather than a weakening. Three capabilities are
added back:

- **`DAC_OVERRIDE`**: read a world whose files belong to the game's uid, and write
  the cache, the dumps, and a restore's output.
- **`CHOWN` / `FOWNER`**: put ownership and modes back as they were on restore,
  rather than leaving a restored world owned by root.

Everything actually dangerous stays dropped (`SYS_ADMIN`, `NET_RAW`, `SETUID`,
`MKNOD`, …), the container still gets no tenant network, and it still sees only the
mounts its scope needs, so the blast radius is the paths it was handed. Running the
container as the agent's own uid instead was the alternative, and it is worse: a
game's data directory contains files owned by whatever uid the game image runs as,
and a backup that silently skips the unreadable ones is not a backup.

### A leaked tool container blocks every later backup

`runToolContainer` removes its container in a `finally`, including on timeout,
because a leaked restic holds a repository lock that fails every subsequent backup
of that subject. Two things make that guarantee real rather than nominal:

- Extra networks are attached **inside** the `try`, so a network that does not exist
  cannot leave a created-but-never-started container behind.
- Containers carry a `citadel.tool=backup` label and a `citadel-backup-*` name, and
  the agent sweeps any that are still around **at boot** (`removeOrphanedToolContainers`).
  The `finally` cannot run if the agent is killed mid-backup, and before the label
  existed the leftover was an anonymous container an operator had to find by hand.
  The label is deliberately not `citadel.managed`. That one means "a tenant's game
  server" and is what the stats collector enumerates.

## Repository layout

```
s3:<scheme>://<endpoint>/<bucket>/<prefix>/servers/<serverId>   ← files
s3:<scheme>://<endpoint>/<bucket>/<prefix>/nodes/<nodeId>       ← database dumps
```

One repository per subject. A single shared repository would deduplicate slightly
better and would mean every node holding a password that decrypts *every* tenant's
data, with pruning for one server having to reason about another's snapshots.
Separate repositories trade that deduplication for a blast radius of exactly one
subject. The `servers/` and `nodes/` segments keep the scopes apart even though both
ids are UUIDs, so a human reading the bucket does not have to guess.

Each repository's password is minted on first use (48 random bytes), stored
AES-256-GCM encrypted in `server_backup_repos` / `node_backup_repos`, and delivered
to the agent on every call. The agent never persists it. Two consequences worth
stating plainly, both surfaced in the admin UI:

- **Rotating `PANEL_ENCRYPTION_KEY` makes every existing snapshot permanently
  unreadable.** The stored repository passwords become undecryptable, and they are
  the only thing that opens the repositories.
- The panel is a single point of failure for *reading* backups. If it is rebuilt from
  a Postgres backup, the repository passwords come back with it, which is why the
  panel's own database must be backed up by other means (see the end of this doc).

Minting is race-safe (`INSERT … ON CONFLICT DO NOTHING` followed by a re-read): two
concurrent first backups must agree on the password, or the loser writes snapshots
nothing can later decrypt.

### Transport: TLS is a field, not a scheme

`endpoint` is a bare host with an optional port, and the scheme comes from a separate
`useTls` boolean (default **true**). Two reasons:

- A scheme embedded in the host would be a second, less visible way to end up on
  plaintext. With one field there is exactly one answer to "is this connection
  encrypted?", and `wire.ts` rejects a scheme in `endpoint` to keep it that way.
- Plaintext has to be *possible*. A self-hosted Garage, MinIO or SeaweedFS on a LAN
  commonly has no certificate at all. That is the normal case for an operator
  self-hosting this panel, and refusing it would just mean no backups.

The admin form is helpful rather than pedantic about it: pasting `http://host:3900`
strips the scheme and *moves the TLS switch*, so the correction is visible and
undoable rather than silent.

Note that `region` is not cosmetic. It is part of the SigV4 signature, so a wrong
value fails authentication rather than being ignored. Self-hosted servers pick their
own: **Garage defaults to `garage`**, MinIO accepts anything.
`explainResticFailure` recognises the TLS-handshake and wrong-region failures
specifically, because restic's own messages for them say nothing about which setting
to change.

## What goes into a snapshot

Absolute paths at fixed mount points inside the restic container, so
`restic restore --target /` reconstructs them where they came from:

| Scope | Mount | Contents |
| --- | --- | --- |
| `server` | `/data` (read-only) | The server's data directory |
| `node` | `/dumps` | One `<dbname>.sql` per provisioned database |

A server backup never sees `/dumps`, and a database backup never sees `/data`. That
is what structurally prevents a server's snapshot from containing another tenant's
data.

### Database dumps

Two decisions in `backup/dumps.ts`, both rejecting the more obvious option:

- **A throwaway container, not `execInContainer`.** `docker/exec.ts` buffers a
  command's whole stdout into a string, fine for a `CREATE DATABASE` and fatal for a
  multi-gigabyte dump. Running `mariadb-dump` in its own container on `node_db_net`
  with `/dumps` bind-mounted lets the dump stream to disk and never enter the agent's
  memory.
- **One file per database, not `--all-databases`.** A single stream would also capture
  `mysql.user`, every tenant's password hash, and would make a per-database restore
  impossible. The panel is already the source of truth for database credentials, so
  the dumps carry *data only*.

Dumps run **sequentially**. They hit an instance shared by every server on the node,
and N concurrent dumps of large tables is exactly the load that makes other tenants'
servers time out. An admin backup of a busy node is allowed to be slow; it is not
allowed to be an outage. `--single-transaction` gives a consistent InnoDB snapshot
without locking the games out.

One database failing does **not** fail the run: on a node with fifty databases, one
that was dropped out from under us must not cost the other forty-nine their backup.
The failures are logged, listed in the result, and the snapshot records which
databases it actually contains. A run where *nothing* dumped does fail. Reporting
"backup complete" when nothing was captured is worse than an error.

The dump image is resolved by **inspecting the node's own database container** rather
than pinning a version: whatever engine serves the data ships a `mariadb-dump` that
can read it, and a mismatched client is a class of corruption that only appears at
restore time.

Dumps stage in `BACKUP_STAGING_ROOT/node-databases`, a *sibling* of the server data
root, never inside it. A dump under a server's own data directory would be readable
through the file manager and over SFTP by anyone with the `files` permission, which
is not the same set of people as those with `database`; and this is *every* tenant's
data, so it must not sit under any one server's tree. The directory is emptied before
each run (a stale dump for a deleted database would otherwise ride along forever) and
cleared afterwards **including on failure**. Leaving plaintext SQL for a whole node
on disk between backups is the largest needless exposure in this path.

## The quota: how "keep 5" is enforced

Retention is a plain snapshot count per subject, not a calendar policy. It is applied
as the job's **first real phase**: list the snapshots, delete the oldest ones that
have to go, and only then write the new one:

```
enforcing_limit → uploading → measuring
```

Three reasons, in order of how much they matter:

1. The limit is never briefly exceeded, so an operator near their storage ceiling
   frees space *before* asking for more rather than after.
2. It is what "a new backup replaces the oldest" actually means.
3. It happens inside the async job, so the request that started the backup stays
   fast. A `forget --prune` rewrites pack files and has no business in an HTTP
   handler.

The job reports which snapshot ids it deleted (`result.forgotten`), because the panel
cannot infer them without re-listing and diffing the repository. The reconciler drops
the matching rows **before** recording the new one, so a reader never briefly sees
more backups than the limit allows. That report is the whole mechanism keeping the
panel's history and the bucket's contents in step.

Unlike most housekeeping here, a failure to prune **fails the run**: the entire point
of the quota is that storage does not grow without bound, so quietly writing snapshot
six when the limit is five would defeat it.

There is deliberately **no `--keep-*` policy anywhere**. `restic forget` with a policy
and no matching snapshots deletes everything, and a mistake in that argument is
unrecoverable. Only explicit id lists are ever passed, and `forgetSnapshotsArgs`
refuses an empty one. For the same reason, an absent `keepMax` in a request body means
*unlimited*, never "keep none". A malformed request must not be able to wipe a
repository.

Failed runs produce no snapshot, so they are bounded separately: `trimFailedRuns`
keeps the most recent 20 per subject, because a node with wrong S3 credentials would
otherwise write one failed row per server per schedule tick forever.

## Storage accounting

The admin page reports one line: **used · allowed · total**.

- **used**: real. `restic stats --mode raw-data` (the deduplicated, compressed bytes
  actually stored, not the logical restore size), recorded per repository as the last
  phase of every backup. Measured *then* because the index is already in the local
  cache, so it costs a metadata pass rather than a download. Summing the recorded
  column is what makes the page load cheap: measuring live would mean one container
  per repository, which on a fleet of two hundred servers is two hundred container
  starts for a page view.
- **allowed**: enforced. `assertStorageAvailable()` refuses new backups once the
  total reaches it, before the node is contacted, so an operator hits a clear message
  instead of an invoice. Deliberately a check on the *current* total rather than a
  projection of what this backup will add: restic deduplicates, so a snapshot's real
  cost is unknowable in advance and refusing on a guess would block backups that
  would have fitted. The quota never blocks *deleting*, so an operator over it can
  always get back under.
- **total**: operator-declared, display only. S3 exposes no capacity API, so the
  size of the storage plan is something only they know. The panel asks rather than
  pretending to have discovered it.

`unmeasured` travels with the report so the number is honest: a repository whose size
has never been read contributes nothing, and the UI says the figure is a floor rather
than presenting it as complete. A measurement failure records `null`, never `0`.
Conflating "could not read" with "genuinely empty" would understate the one number
this exists to get right.

## Asynchronous execution

A 30 GB backup takes minutes to hours. Running it inside the request that asked for
it would die on the first proxy idle timeout, could not report progress, and would
lose everything on a reconnect. So:

1. The panel writes a `backup_runs` row (`pending`), **before** calling the agent. If
   the agent call then fails, there is a durable `failed` record saying why. The other
   order loses every failure that happened before a job id existed.
2. The agent registers an in-memory job and returns `202 { jobId }` immediately.
3. The job runs its phases.
4. `nodes/backupScheduler.ts` polls the job each tick, drains new log lines into
   `backup_run_logs`, and records the outcome.
5. The browser polls the panel and renders a progress bar and a live log tail.

The panel polls; the node never calls in. It has no panel credential and may be
behind NAT. Same shape as `security/watcher.ts`.

Jobs are keyed by an opaque **subject** string (`server:<uuid>` or `node:databases`)
rather than a server id, because both scopes need the same mutual exclusion: two
restics on one repository contend on its lock, and a database backup must not run
twice at once either. Keying per subject means a node backing up its databases can
still back up its servers' files, and a busy server does not block its neighbours.

### Division of state

| Owned by the panel (durable) | Owned by the agent (in memory) |
| --- | --- |
| The run row, its log, repository passwords, S3 credentials, the limits, the schedules | The restic and dump containers, the job's progress and log buffer |

This is what makes an agent restart survivable. The row exists before the agent is
called, so a job that has vanished becomes *a failed run with a stated reason*, not a
row stuck at "running" forever. `backup/jobs.ts` keeps finished jobs for an hour so a
panel that restarted mid-backup can still learn the outcome rather than reporting a
false failure.

### Progress, without a second streaming implementation

restic's `--json` output is newline-delimited, and the agent reads it by **polling the
container's log tail** (`getContainerLogs`) rather than following the log stream.
Following would mean a second streaming log implementation alongside
`demuxDockerLogStream`, and `RESTIC_PROGRESS_FPS=0.2` throttles restic to one progress
line every five seconds, granular enough for a progress bar and bounded enough to keep
in a log. The parser in `backup/restic.ts` is deliberately tolerant: a polled tail can
begin or end mid-line, so anything that is not valid JSON is skipped rather than
failing the parse.

Progress is reported as a **phase** as well as a percentage. The percentage only moves
during `uploading`, so the phase is what distinguishes "stuck at 0%" from "dumping a
large database".

## Logs

`backup_run_logs` holds one row per line, sequence-numbered by the agent. One row per
line rather than an appended `TEXT` column because that is what makes a live tail
cheap: `WHERE seq > $cursor` returns only what is new, so a two-second poll transfers
a few lines instead of re-downloading a log that grows for the length of a backup. The
same cursor makes the drain idempotent. A retried poll re-inserts nothing, thanks to
`UNIQUE (run_id, seq)`.

Logs are kept with the run and cascade-delete with it. **Failed runs are kept
alongside successful ones**. A backup that did not happen is the single most useful
thing to be able to tell an operator, and a snapshot list can only ever show
successes. That is the whole reason the panel keeps its own rows when the repository
already lists snapshots.

The agent caps its buffer at `AGENT_MAX_BACKUP_LOG_LINES` and evicts oldest-first,
because the end of a failed job's log is where the error is. The drop count travels to
the panel, so a truncated log says so once rather than silently.

## Schedules

Two independent cron expressions, both admin-set at **Admin → Backups** and both
evaluated in the panel's configured timezone:

- **Server backup schedule** sweeps server files.
- **Database backup schedule** sweeps node databases.

Separate because they are different operations on different subjects at different
privilege levels; an operator who wants nightly file backups does not necessarily want
the same cadence of full database sweeps. Migration 021 deliberately does **not**
inherit the old single schedule into the database one. Starting to sweep every
tenant's database because of a setting made for file backups would be a decision the
operator did not make.

`lib/cron.ts` is hand-rolled rather than a dependency. What is needed is small and
exactly specified (match a `Date`, describe an expression, compute the next run), while
a cron library brings `@`-shorthands, seconds fields, `L`/`W`/`#` extensions and its own
timezone handling, none of which an operator-facing field should accept. It is shared
by the UI preview and the scheduler, so a schedule can never display one thing and do
another.

Three details it gets right on purpose:

- **POSIX day semantics.** When *both* day-of-month and day-of-week are restricted, the
  day matches if **either** does. `0 4 1 * mon` means "the 1st, and also every
  Monday", not their intersection. Matching the manpage matters because an operator's
  expression must do what its documentation says.
- **Real timezones, not fixed offsets.** Evaluation goes through
  `Intl.DateTimeFormat`, so `0 4 * * *` means 04:00 local on both sides of a DST
  boundary.
- **Coarse-grained search.** `nextCronRun` skips whole non-matching days and hours
  rather than stepping minute by minute, which turns a `29 feb` lookup from ~800k
  timezone conversions into a few thousand. Each skip is bounded by the remainder of a
  unit already proven empty, so no match can be missed.

### Firing

One timer at 30 s (well under a minute, so a schedule naming a specific minute is never
missed). Each tick **reconciles before it fires**, because a run that has just finished
must be closed out before its subject is considered for a new one. That is also why
everything lives on one timer: separate timers could start a second restic against one
repository.

The double-fire guard is a **time window**, not a stored "last run at" marker: the tick
interval is shorter than a minute, so the same due minute is evaluated more than once,
and a marker would have to be written transactionally with the backup to be
trustworthy. Asking "has a scheduled run started for this subject since the top of this
minute?" needs no extra state and survives a panel restart mid-minute.

`concurrency` caps how many *servers* start per tick. Every concurrent backup reads a
disk and saturates a node's upstream, so on a fleet of a hundred servers the schedule
trickles rather than stampedes. Database backups are not throttled by it: there is one
per node, a node cannot contend with itself, and the dumps within a run are already
sequential.

A server is skipped when it is suspended (its container is stopped pending review, and
continuing to bill the operator's bucket for it is not what anyone configured), still
installing, in `error`, already running a backup, or has `servers.backups_enabled =
false`. A node is skipped without DB admin credentials, with no databases, or with
`nodes.database_backups_enabled = false`. Both flags default to **true**: an operator
who configures a destination and a schedule means "back up my fleet", and a per-subject
opt-in would leave most of it silently unprotected.

### The dev-mode timer footgun

The interval handle lives on `globalThis`, not in a module-level binding. The scheduler
starts once from `instrumentation.ts`, which Next.js never re-runs; when the module is
hot-replaced, a module-level `timer` would be `null` in the new instance while the
*old* instance's interval kept firing the previous version of the code, against
whatever schema that version knew about. The symptom is a tick failing on a table a
migration has since renamed, from a stack frame in a file that no longer exists. A
global handle makes a reload *replace* the timer instead of racing it.

## Restore

### Server files

Owner or admin only. `backups` is enough to *take* a backup, but a restore overwrites
a world.

1. The panel stops the server and marks it `stopped`. Not a courtesy: restic would
   otherwise be writing files the running game has open and cached, and the game would
   overwrite half of them on its next save.
2. `restic restore <snapshot> --target /` rebuilds `/data`.
3. The server is left **stopped**, with a separate "Start the server" button, so the
   owner can check the restored state before players reconnect, and a restore that only
   half-worked is not immediately handed to a live game.

Databases are untouched: they are not part of a server backup.

### Node databases

Admin only, and the most destructive operation in the panel. It overwrites the live
contents of every database in the snapshot, across every tenant on that node. The
confirmation dialog says exactly that, names the databases, and says to restart the
affected servers afterwards.

Each dump is imported with `CREATE DATABASE IF NOT EXISTS` first, because the reason to
run this is usually that the databases are gone. The panel re-provisions the scoped
users and grants separately from its own encrypted records, which is why the dumps only
need to carry data.

Servers are **not** stopped first, unlike a file restore. A database import goes through
MariaDB, which serialises it correctly; a game holding stale rows in memory is a reason
to restart it afterwards, not a reason for the panel to stop every server on the node on
its own initiative.

### Two deliberate limits, both scopes

- **No `--delete`.** A restore *overlays* the snapshot rather than making the target
  byte-identical to it. Handing a filesystem-wide delete to a tool running as root
  inside a container is a far worse failure mode than a few stale files, which the owner
  can clear from the file manager.
- **A dump missing from the snapshot is skipped with a log line, not an error.** It means
  that database was provisioned after the backup was taken, and losing the rest of the
  restore over it would be worse. An import is not transactional (`mariadb-dump` output
  contains its own DDL, which MariaDB cannot roll back), so a failure leaves that one
  database partially restored, which is reported, not hidden.

## Deletion

Snapshot first (`forget --prune`), then the panel row. The other order would orphan the
snapshot on a prune failure, paid for forever with nothing in the UI referencing it. A
snapshot the agent reports as already gone counts as success, so a retried delete
completes.

## Permissions

| Action | Requires |
| --- | --- |
| List, status, logs, take a **server** backup | `backups` |
| Include/exclude a server from the schedule | `settings` (a property of the server, like its env) |
| Restore or delete a **server** backup, list its repository snapshots | Owner or admin |
| Everything about **database** backups | Admin |
| Configure destinations, schedules, limits, storage | Admin |

Reads gate with writes, per the project rule: a subuser with only `console` must not be
able to enumerate a server's backup history.

## Configuration

Panel-side, at **Admin → Backups** (the `backups` key in `panel_settings`, secret
access key AES-256-GCM encrypted):

| Group | Fields |
| --- | --- |
| destination | `enabled`, `endpoint`, `useTls`, `region`, `bucket`, `prefix`, `accessKeyId`, `secretAccessKey` |
| `storage` | `quotaBytes` (enforced), `capacityBytes` (declared, display only) |
| `servers` | `schedule`, `maxPerServer`, `exclude`, `concurrency` |
| `databases` | `schedule`, `maxPerNode` |

`servers.exclude` is admin-controlled and applies to server **file** backups on every
server. Excluding regenerable data (caches, logs) shrinks every snapshot in the fleet,
which is a fleet-wide decision rather than a per-owner one. Database backups have
nothing to exclude: the staging directory contains exactly the dumps the run just
wrote.

The **Test connection** button runs on a real node, not on the panel. A node is what
has to reach S3, and it may sit behind a different egress path. It probes a *repository*
path rather than merely listing the bucket, because the credential that can list but not
write is the one operators actually misconfigure. A repository that does not exist yet
counts as success: that is the expected state before the first backup, and initialising
one to prove connectivity would leave debris in the bucket. It works while the
destination is entered but not yet enabled (`allowDisabled`), which is exactly when it is
needed.

Agent-side (`.env` on each node):

| Variable | Default | Purpose |
| --- | --- | --- |
| `RESTIC_IMAGE` | `restic/restic:0.19.1` | Pinned, not `latest`. A repository written by one restic version and read by another is a thing to opt into |
| `BACKUP_STAGING_ROOT` | `<SERVER_DATA_ROOT>/../backup-staging` | Dump staging and restic's chunk cache |
| `BACKUP_NETWORK` | `citadel_backup_net` | Dedicated bridge for tool containers |
| `AGENT_MAX_BACKUP_LOG_LINES` | `2000` | Per-job log buffer cap |

restic's chunk cache is kept per repository under the staging root between runs. Without
it every incremental backup re-downloads the repository index from S3 before it can
decide what changed. That is slow, and a real per-request bill. The cache holds no
plaintext tenant data, since repository contents are encrypted.

## Schema

| Table | Holds |
| --- | --- |
| `backup_runs` | One row per backup or restore, either scope. `scope` + `server_id`/`node_id`, with a `CHECK` that a server run names a server and a node run does not |
| `backup_run_logs` | One row per log line, `UNIQUE (run_id, seq)` |
| `server_backup_repos` | Per-server repository password and last measured size |
| `node_backup_repos` | The same, per node |
| `servers.backups_enabled` | Whether the file schedule includes this server |
| `nodes.database_backups_enabled` | Whether the database schedule includes this node |

One `backup_runs` table for both scopes because a run is a run: the lifecycle, progress
reporting and log are identical and only the subject differs. Two tables would have meant
two reconcilers that could drift apart. The repository tables *are* split, so each keeps a
real foreign key and cascades when its subject is deleted. A polymorphic `(scope, id)`
column cannot express that.

Migration 021 reshapes a database that ran the original single-scope 020: it adds the new
tables and columns, drops `server_backups`/`server_backup_logs`, and rewrites the settings
JSON into the nested groups. The old rows are dropped rather than migrated because they
describe snapshots that mixed files and dumps in one tree, which nothing can now restore
correctly. Keeping rows that offer a Restore button which cannot work would be worse than
an empty history. The snapshots themselves are left in the bucket under the old
`<prefix>/<serverId>` path, unreferenced, for the operator to remove by hand.

## What is not backed up

The panel's own PostgreSQL database. Backups cover *game servers*: their files, and the
databases they use. The control plane's metadata (accounts, nodes, audit logs, **and the
repository passwords that open every snapshot**) is the operator's responsibility to back
up by ordinary means, and it must be: without it, the snapshots in S3 cannot be decrypted.

## Files

| Path | Role |
| --- | --- |
| `apps/backend/src/backup/restic.ts` | Repository URL, argv, env, quota arithmetic, output parsing (pure; tested) |
| `apps/backend/src/backup/dumps.ts` | `mariadb-dump` / import via throwaway containers |
| `apps/backend/src/backup/toolContainer.ts` | Running tool containers, log-tail progress polling |
| `apps/backend/src/backup/jobs.ts` | Async job registry, subject keys, log buffer (tested) |
| `apps/backend/src/backup/run.ts` | Orchestration for both scopes |
| `apps/backend/src/backup/wire.ts` | Request validation (tested) |
| `apps/frontend/lib/cron.ts` | Cron parsing, matching, next-run, descriptions (tested) |
| `…/services/backupCore.ts` | Repository passwords, S3 target assembly, run rows, logs, storage accounting |
| `…/services/serverBackups.ts` | Server file backups |
| `…/services/databaseBackups.ts` | Node database backups |
| `…/nodes/backupScheduler.ts` | Reconcile in-flight runs; fire both schedules |
| `…/nodes/nodeBackupApi.ts` | Typed agent client |
| `…/routes/backups.ts` | HTTP handlers, both scopes |
| `…/db/migrations/020_server_backups.sql` | Schema for a fresh install |
| `…/db/migrations/021_backups_two_scopes.sql` | Reshape for a database that ran the original 020 |
| `components/server/backups-tab.tsx` | Owner-facing tab: status, progress, log tail, history, quota |
| `components/admin/backup-settings.tsx` | Destination, server schedule, storage |
| `components/admin/database-backups-card.tsx` | Database schedule and the per-node list |
