# Server migration

Moving a server from one node to another: the capacity checks that happen
before anything is touched, why the whole thing is a copy rather than a move,
what the panel does when a step fails, and the one kind of server that cannot
be migrated yet.

## The rule everything else follows from

**A migration is a copy, and the source keeps everything until the destination
has proved itself.**

For the entire run — through the backup, the stop, the copy, the port
allocation, the container build and the verification — the source node still
has the container, still has the data directory, and still holds its published
ports in `server_ports`. `servers.node_id` is the *last* thing that changes, and
the source's copy is deleted only after the destination has answered as a
working server.

That is what makes the failure story one sentence: **if anything goes wrong, the
server is still on the node it started on.** It is also why none of the steps is
a move. There is no moment at which the files exist in exactly one place and the
panel is between two records of where that is, which is the state no amount of
retrying gets you out of.

The cost is disk: for the length of the migration the world exists twice, once
on each node. That is the price of the guarantee, and it is why the preflight
insists on headroom rather than on the world merely fitting.

## The phases

| Phase | What it does | What a failure here costs |
|---|---|---|
| `preflight` | Every check, while the server is still running | Nothing. Nothing has been touched |
| `backup` | A restic snapshot of the server's files | Nothing; the migration is abandoned |
| `stopping` | Stops the source container | The server is started again |
| `transferring` | Streams the data directory to the destination | The partial copy is deleted |
| `allocating_ports` | Chooses the destination's port numbers | Nothing is written yet |
| `building` | Creates the container on the destination | The container is deleted |
| `verifying` | Asks the destination about the container | As above |
| `cutover` | One transaction: `node_id` + the port rows | Nothing committed; source untouched |
| `cleanup` | Deletes the source's container and files | The migration still **succeeded** |

Everything up to and including `verifying` is undone by `rollback`, which
restores the source to exactly the state it was found in — running if it was
running. `cutover` is a single transaction with no network calls in it, so it
either happens or it does not. `cleanup` is the one deliberately best-effort
step, and the reason is in [Cleanup, and the receipt](#cleanup-and-the-receipt).

## Preflight: every refusal at once

`preflightMigration` returns a *list of checks*, not the first objection. An
admin who has to reserve ports on the destination *and* free 30 GB there wants
to be told both things now, not one per attempt. Each check returns `ok`, `warn`
or `fail`, and one `fail` blocks the migration.

What is checked, and why each one is not implied by the others:

- **Server state.** Only `running`, `stopped` and `error` can be moved.
  Everything else is a server that is mid-something (`creating`, `installing`,
  `deleting`, another migration) or under an administrative hold (`suspended`).
- **Container.** A row with no container has nothing to move. Starting it once
  rebuilds it ([server-lifecycle.md](server-lifecycle.md)).
- **Other operations.** No other migration, and no backup or restore in flight.
- **Databases.** See [The one thing that does not
  move](#the-one-thing-that-does-not-move).
- **Destination readiness.** The same `assertNodeReadyToProvision` a create
  runs: the agent answers, Docker is reachable, the data root is writable.
- **Transfer tools.** Whether the destination's agent has `tar` and `du`. This
  exists purely to move a discovery earlier: without it, a node missing them
  fails the copy *after* the server has been stopped.
- **CPU / memory / disk allocation.** The scheduler's bookkeeping, via
  `loadNodeCapacity` and the node's reserves ([ports.md](ports.md) has the same
  machinery for a create).
- **Free space.** Not the same question as the one above, and this is the
  distinction worth stating: `nodes.disk_total_mb` is a number an admin typed at
  registration so the scheduler has something to bin-pack against. Whether a
  40 GB world actually fits is a fact about the destination's filesystem, which
  only the destination can answer. So the agent reports real `statfs` numbers
  through `/v1/health`, the source measures the world with `du`, and the
  requirement is the data **plus headroom** — 20%, floored at 2 GB
  (`requiredFreeBytes`). A destination that ends a migration with 200 MB free
  has not gained a server, it has gained an outage: a full data root fails every
  write on that node, not just this server's.
- **Ports.** Whether the destination's pool has enough free numbers at all, and
  how many of the current numbers can be kept.
- **Safety backup.** `ok` when a destination is configured, `warn` when not.

## Keeping the port numbers

The panel tries to give the server **the same numbers on the destination**, and
this is worth real effort rather than being a nicety. A preserved port is a
player address that does not change, a config file nobody has to edit, and a
server-link peer that keeps working — and the last of those is not even this
owner's server.

A number is keepable when it is in the destination's pool, not allocated to
another server there, and free on that host right now (`keepablePorts`). All
three are necessary: a pool entry can be fully allocated, and an unallocated
number can still be held by a process the panel does not manage. A number that
cannot be kept is drawn randomly from the destination's pool, exactly the way a
new server's is ([ports.md](ports.md)), and the migration log names the swap.

Because the published port reaches the game through the blueprint's
`primaryPortEnv` and the image rewrites its config from that variable on every
boot, **a reassigned port needs nobody to edit `server.properties`**. That is
the whole reason [ports.md](ports.md) insists the panel owns that variable and
owners cannot. The panel passes the new value as an env override at build time
and persists it at cutover, never before: a migration that fails after the build
must not leave `server_env` naming a port on a node the server is not on.

### Why the port rows move only at cutover

`server_ports`' primary key is `(server_id, container_port)` and mappings are
identity, so a server cannot hold the *same* number on two nodes at once. Since
keeping the number is the common case, the destination's rows cannot be written
in advance — so they are written in the cutover transaction, and the source
keeps its claim until then.

That leaves a window between "the agent said this number is free" and the
cutover in which another server's create could take it on the destination. The
`UNIQUE (node_id, host_port)` constraint catches exactly that, the whole
transaction rolls back, and the migration fails with the source untouched. For a
race this rare, failing safe is the right answer, not a lock.

## The transfer

Two agent routes and one panel-side pipe:

- `GET /v1/servers/:id/transfer/export` streams the data directory as a tar.
  Read-only, by construction: the source must not be damaged by the thing that
  is trying to leave it.
- `POST /v1/servers/:id/transfer/import` extracts a tar into the destination's
  data root, refusing outright if anything is already there.

**The bytes go through the panel, not node to node.** The obvious design has the
destination fetch from the source directly, which is what `pullFromUrl` does for
a remote URL and would halve the hops. It is not what happens, because two nodes
are not required to be able to reach each other: a node is registered by the
*panel's* view of it, and plenty of deployments put each node behind its own NAT
with no route between them. A transfer that worked on a flat LAN and failed
everywhere else would be worse than one that is uniformly a hop slower. It also
keeps the trust model exactly as it is — the panel authenticates to each agent
with that agent's own bearer token, and **no node is ever handed a credential
for another node.**

Nothing is buffered. The source's response body becomes the destination's
request body in one pass, with a counting pass-through in between for the
progress bar. A fifty-gigabyte world must not become a fifty-gigabyte allocation
in the panel's process.

The stream is **uncompressed** by default. A game server's disk is mostly
already-compressed data (region files, jars, mod archives), so gzip spends real
CPU on both machines to shave very little — CPU on machines whose job is running
other people's games. `compress` is available per migration for a metered or
slow link.

### Verifying the copy

The destination re-measures its data directory after extracting, and the panel
compares that against the source's measurement (`transferIsComplete`). This is
the one failure a streaming copy has that a buffered one does not: **an archive
truncated at a member boundary extracts without `tar` complaining**, and the
only evidence is that the result is smaller than what was sent.

The tolerance is 2%, and it is a floor rather than a band. Two filesystems do
not have to agree on what a directory entry costs, so an honest copy can measure
a little differently at either end, and one that measures *larger* is routine.
What the check has to catch is a loss measured in percent.

## Verification, and where the real proof is

`verifying` deliberately **does not start the game**. Booting a Minecraft server
takes minutes and writes into the world it has just received, so a
start-verify-stop before cutover would double the outage and mutate the very
thing being verified. What is checked is what is cheap and is what actually goes
wrong: the container exists on the destination and Docker will describe it.

The real proof is the start immediately *after* cutover. That is safe to leave
until then because a failure there also rolls back — nothing on the source has
been deleted yet. A server that migrates but refuses to boot is reported as its
own thing (the files are in place, start it and read the error), the same way a
provision that builds but does not start is
([server-lifecycle.md](server-lifecycle.md)).

## Server links follow the server

A link's *mechanism* depends entirely on whether the two servers share a node: a
private ICC-enabled Docker network if they do, public
`hostname:port` addressing if they do not ([server-links.md](server-links.md)).
Moving a server flips that answer for every link it has, in both directions, and
nothing else in the panel would notice — leaving a link row the UI still shows
and a pair network holding one container whose partner left.

`rewireServerLinks` handles both directions at cutover: a link that was internal
and is now external has its old pair network torn down on the *previous* node
(which is why this runs before the source container is deleted), and one that is
now internal gets a pair network on the new shared node. A link between two
servers that never shared a node needs nothing: it was addresses, and it still
is.

A link that cannot be rewired is logged and does not fail the migration — the
server has already changed hands, and a peer whose node is unreachable must not
retroactively turn a completed move into a failed one. The owner can remove and
re-add it.

## The safety backup

Before anything is stopped, the migration takes a normal restic snapshot of the
server's files ([backups.md](backups.md)) and refuses to continue if it fails.

It is not the primary safety net — the source's own copy is, and it is kept
throughout. This is the secondary one, for the failure that is *not* detected
during the run: a world that arrives subtly wrong and is noticed three days
later is past every rollback this feature can perform, and a snapshot taken
immediately before the move is the only thing that answers it.

It is taken *before* the stop rather than after, so a backup that fails costs no
outage at all.

A panel with no S3 destination configured can still migrate, but the admin has
to say so: the preflight returns `requiresNoBackupAcknowledgement`, and the
start request is refused without `acknowledgeNoBackup: true`. Running with
nothing to fall back on is a decision, and it should be one somebody made rather
than one the panel made for them.

## Cleanup, and the receipt

Deleting the source's container and files is the only best-effort step, and that
is deliberate. By then the server is on the destination and working; a source
node that went unreachable in the last minute must not turn a completed
migration into a "failed" one, because "failed" would imply the server is not
where it now is.

What it does instead is report — into the log, the migration row's `error`
field, and the audit entry. Once nothing points at the old node any more, that
record is the only thing that knows a container and a world are still sitting on
it. Same reasoning as the forced-delete receipt in
[server-lifecycle.md](server-lifecycle.md).

## Failure, rollback, and saying so

`rollbackMigration` runs on every failure and every cancellation, and undoes
three things in the order that leaves the server working soonest:

1. **the record**, if the cutover got that far — until `node_id` points at the
   source again, nothing else in the panel can act on the server correctly;
2. **whatever the destination built** — its container and its copy of the data,
   because a half-migrated server left on a node is the orphan the whole feature
   is arranged to avoid;
3. **the source's own state** — the status it had, and a restart if it was
   running.

Every step is individually guarded, because a rollback that threw half way
through would leave the worst of both nodes. A failure in any one step is
recorded, downgrades the outcome from `restored` to `partial`, and the rest
still runs.

`rollback` is therefore the field that answers the only question that matters
after a failure, and the UI leads with it rather than with the error:

- `restored` — **the server was not moved. It is still on its original node with
  its files intact, and has been put back the way it was.**
- `partial` — it was not moved either, but putting things back did not fully
  succeed; the log says what could not be undone and both nodes want a look.
- `not_needed` — it failed early enough that nothing had been changed.

### Cancelling

Cooperative, not a kill. The run checks between phases and unwinds through the
same rollback a failure uses, because interrupting a `tar` mid-stream and
walking away would leave a half-written tree on the destination that nothing
owns. Refused once the cutover has begun: past that the server *is* on the
destination, and the honest options are "let it finish" and "migrate it back",
not "stop half way".

### A panel restart mid-migration

A migration runs in the panel's process, and it holds its server in `migrating`,
a status nothing else is allowed to correct. A restart part-way through would
otherwise leave that server unreachable by every recovery path the panel has.

`failInterruptedMigrations` runs at boot, alongside `failInterruptedProvisions`.
It is deliberately conservative: it does **not** resume and it does **not** undo
anything on either node, because it cannot know how far the previous process
got, and guessing risks deleting a copy that is now the only one. It closes the
row out as failed with `partial`, says so in the log, and releases the server's
status so the fleet sweeper can work out from the node what is actually running.

## `migrating`, the status nothing reconciles

`servers.status` is a record, and something goes and looks
([server-lifecycle.md](server-lifecycle.md)). `migrating` is exempt from that,
like `suspended`, and for a sharper reason than "the panel is holding it": for
most of a migration the row still names the **source** node, and that node
truthfully reports the container as exited, because the migration stopped it on
purpose so the files would stop changing. A reconcile that believed the node
would write `stopped` over a move in progress and take the migration's own
progress reporting off the server page with it.

So `reconcileStatus` returns `migrating` unchanged at any age (there is no
"trusted for" window: a migration can legitimately run for hours), and the fleet
sweeper excludes those rows from its batch entirely. Only
`services/serverMigration.ts` moves this status, and only
`failInterruptedMigrations` releases it.

Every other action on the server is refused while it holds — `assertNotMigrating`
guards the power actions, delete, reinstall, suspend, port changes and database
changes. Refused rather than queued, and with the reason, because the wait is
minutes to hours and the caller is a person who should be told to come back.

## Who can do it

**Admin-only, all of it, reads included.** Every other server action is gated on
the owner or a subuser flag; this deliberately is not. A migration is an
operator decision about the fleet: it decides which machine somebody's game runs
on, it can be refused for reasons about *other* tenants' capacity, and its
preflight and log name nodes, free space and host facts that are none of an
owner's business. There is no `migrate` subuser flag and there should not be
one.

The owner is not kept in the dark. Their server sits in `migrating`, the shell
shows a "Server is being moved…" screen that says their files are safe on the
original node until the move is verified, and the page updates itself when the
move finishes.

## The one thing that does not move

**A server with provisioned databases cannot be migrated**, and the preflight
refuses it by name.

A server's database lives on the *source* node's shared MariaDB
([node-database.md](node-database.md)), reachable at that node's internal
address, under a credential that appears in config files the panel does not own.
Moving the container without it produces a server that starts, looks healthy,
and cannot reach its data — which is a worse outcome than a refused migration,
because it fails silently and hours later.

Moving it *with* the container is a second feature, not a missing line here: it
needs a per-server dump and import, a matching account on the destination's
MariaDB, and a rewrite of a host address that is hardcoded in plugin configs the
panel has no safe way to edit. Until that exists, the way to move such a server
is to back the database up, remove it from the server, migrate, and provision a
new one.

## Files

| | |
|---|---|
| `services/serverMigration.ts` | The orchestrator: preflight, phases, cutover, rollback |
| `services/migrationPlan.ts` | The rules as pure functions (headroom, tolerance, port keeps), tested |
| `nodes/nodeTransferApi.ts` | The panel-side pipe between two agents |
| `routes/migrations.ts` | The admin API |
| `components/admin/migrate-server-dialog.tsx` | The verdict screen and the live account |
| `apps/backend/src/transfer.ts` | The agent's export/import/measure |
| `db/migrations/025_server_migrations.sql` | `server_migrations`, its log, and the `migrating` status |
