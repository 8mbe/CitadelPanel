# Archiving a server

An **archived** server is one whose files live in the backup bucket and nowhere
else. The node keeps nothing: no container, no data directory. The panel keeps
everything else: the row, its name, its ports, its env, its databases, its
subusers, its SFTP credentials and its links. Restoring it puts the files back on
the same node, rebuilds the container, and hands it back on the same address.

Related: [backups.md](backups.md) (the S3 destination, the restic repositories
and the run machinery this is built on), [server-lifecycle.md](server-lifecycle.md)
(the statuses, and why a status is a record rather than an observation),
[server-migration.md](server-migration.md) (the other long transfer, and where
the ordering principle here comes from), [ports.md](ports.md) (why an archived
server still holds its ports).

## Why it exists, and what it is not

There were two answers to "nobody is using this server", and neither is the one
an operator actually wants:

| | CPU and memory | The disk | The server |
| --- | --- | --- | --- |
| **Stop** | freed | **kept** | kept |
| **Delete** | freed | freed | **destroyed** |
| **Archive** | freed | freed | kept |

The disk is the resource an idle game server actually holds. A stopped container
costs nothing to run and sits on a thirty-gigabyte world indefinitely, and on a
node full of them that is the whole problem. Deleting frees it and takes the row
with it — the ports go back to the pool, the env is gone, the subusers are gone,
and the address players had bookmarked belongs to somebody else now.

Archiving is the third row: give up the node's disk, keep the identity. That
property is the entire reason this is something the panel is willing to do
**automatically** on a timer. Nothing is lost, so there is nothing for an
operator to be brave about.

It is deliberately not a variant of delete, and the UI says so in those terms.
The word sits close enough to "delete" that an owner will assume the worst and
never press it, so the archive card leads with the two lists — what moves, and
what stays exactly as it is — and the confirmation asks about the only thing
that is actually irreversible in the short term, which is the server going
offline.

## The three statuses

`archiving`, `archived` and `restoring` join `suspended` and `migrating` in the
small set of statuses **nothing may reconcile away**. The reason is sharper here
than anywhere else, and it is worth stating in full because getting it wrong
destroys data rather than merely confusing a page.

An archived server has no container. The node therefore answers `missing`, which
`statusFromContainerState` maps to `error`. A reconcile that believed it would
write `error` over every archived server, and the next power action would run
`withMissingContainerRecovery`, decide the container had been lost to a stray
`docker rm`, and "repair" it by rebuilding around the data directory — which is
empty. The owner gets a server that starts, runs, and has lost their world, with
nothing anywhere saying what happened.

So the rule lives in `statusReconcile.ts`, the pure module the fleet sweeper and
the server detail page share, and it is tested there. It is *also* excluded in
the sweeper's own query, so an archived server costs the sweep nothing: it is not
even in the batch its node is asked about. Two guards, because the one that
matters is the one in the shared rule and the one that is cheap is the one in the
query.

`archiving` and `restoring` are the same argument in transit. During an archive
the container has been stopped on purpose so the snapshot is of a world nobody is
writing to, and the node honestly reporting `exited` must not become `stopped`
and take the transfer's own progress reporting with it. That is exactly the
migration's problem, arrived at from a different direction.

## The commit point

Both directions run detached from the request that asked for them, for the reason
provisioning does: uploading a 30 GB world is minutes to hours, and no proxy,
browser or fetch timeout in the chain will hold a request open for it. The route
answers 202 with the row already in `archiving`, and the status is how the task
reports.

A detached task dies with its process, so the ordering has to make every
interruption recoverable from the row alone. The archive is therefore two phases
with one durable commit point between them, and the commit point is
**`servers.archive_snapshot_id`**:

```
stop → snapshot → [record the snapshot id] → wipe the node → 'archived'
                   ^^^^^^^^^^^^^^^^^^^^^^
```

- **Before it**, nothing on the node has been touched beyond a stop. A crash
  recovers by putting the row back to `stopped`. Nothing was lost, and the
  message says so.
- **After it**, the files are *proved* to be in S3. A crash recovers by
  **finishing**: re-running the wipe and settling the row at `archived`.

`recoverInterruptedArchives()` is that recovery, and it runs at boot next to
`failInterruptedProvisions` and `failInterruptedMigrations`. Unlike those two it
can often complete the job rather than only failing it, which is what the commit
point buys. Everything after it is idempotent, because the agent treats a missing
container, a missing network and a missing directory as already done.

There is no window in which the recovery has to guess, and — the point of the
whole arrangement — no window in which it could delete something that is not
already safely uploaded.

The unarchive is the same shape with the pointer *held* rather than written.
`archived_at` and `archive_snapshot_id` are cleared **last**, in the same
statement that settles the status, so an interrupted unarchive recovers to
`archived`: still true, still retryable from the same button.

### Why the stop is not best-effort

`reinstallServer` stops the container before wiping it and shrugs off a failure,
because it is about to delete the files whatever happens. Here a failed stop
would put a live game's half-written world into the only copy that is going to
survive, and *then* delete the original. So a stop that fails aborts the archive.

### Why files first on the way back

The unarchive restores the snapshot and only then rebuilds the container. A
restore that fails leaves nothing on the node but partial files, which the next
attempt simply overlays (a restic restore is an overlay, never a sync). Building
the container first and then failing the restore would leave a container on a
node for a row that says `archived`, which is drift nothing reconciles.

The container is rebuilt by `recreateServerContainer`, the same function a port
change and a missing-container heal use, so an unarchived server comes back with
the image, env, resource limits, startup command, published ports and networks it
had. It comes back **stopped**, for the reason a restore does: the owner should
look at what came back before players reconnect.

## What is and is not in the archive

A server backup is **files only** — see [backups.md](backups.md) for why that
split follows the credential rather than the convenience. An archive is one of
those backups, so the same boundary applies:

- **Archived**: the data directory. Worlds, configs, plugin jars, uploads, logs.
- **Not archived, and not touched**: the server's provisioned databases. They
  stay on the node's shared MariaDB exactly as they were, and come back to a
  restored server without anything having to move.

Leaving the databases in place is the right trade here even though it makes the
archive less than total. They are small next to a world, they are on shared
infrastructure a server owner holds no credential for, and taking them offline
would mean the archive could not be undone without an admin. What the feature is
reclaiming is disk on the node, and the world is essentially all of it.

Installed-plugin rows are **kept**, unlike a reinstall which deletes them. A
reinstall deletes the jars; an archive uploads them and brings them back, so the
rows stay true.

## The one snapshot that is not a spare copy

Every other snapshot in the system is a restore point: losing one costs a moment
in time. The archive's snapshot **is the server**. Its files exist nowhere else
until it is restored, and three things protect it:

- **`servers.archive_snapshot_id` is denormalised** out of `backup_runs`. The run
  row can be deleted by an operator or trimmed by the failed-run cap; the pointer
  to the files must not go with it. `archive_run_id` is a convenience for showing
  the log, with `ON DELETE SET NULL`.
- **`deleteServerBackup` refuses it** while the server is archived, in the API and
  not merely in the UI. The message says to restore the server first.
- **Nothing prunes it.** The retention quota (`maxPerServer`) is enforced by the
  agent when a *new* backup is written, and an archived server takes none: it is
  excluded from the schedule sweep, and a manual backup is refused. The archive's
  own run is the newest snapshot in the repository when it is written, so it
  survives its own quota pass.

It carries a `reason:archive` tag, so an operator reading the bucket can tell it
from an ordinary backup without the panel, and the backups tab badges it
**Archive** in the history.

## Automatic archiving

**On by default, at thirteen days.** An operator sets both under
**Admin → Backups → Archive idle servers**.

It is gated twice over, which is what makes an enabled default defensible: the
sweep does nothing at all until an S3 destination is configured and backups are
switched on, and it only ever takes servers that have been stopped for the whole
window. A panel that has never been pointed at a bucket behaves exactly as it did
before this existed.

### The idle clock

Answering "has this been stopped for thirteen days?" needs a timestamp neither
existing column could provide. `updated_at` is bumped by an env edit, a port
change and a plugin install, none of which say anything about whether the server
is in use — a fleet whose owners tweak settings would never auto-archive.
`created_at` is fixed.

So `servers.last_active_at` is the time of the server's **last status change**,
stamped by `setStatus` and only when the status actually moves (`IS DISTINCT
FROM`). That brackets an idle period from both ends:

- starting a server bumps it;
- the server going down bumps it again, whether it was stopped on purpose or
  crashed and the fleet sweeper noticed — so the clock runs from when it actually
  went down.

A server that has been *running* for a month is never a candidate however old the
column is, because the sweep requires `status = 'stopped'`. The column is the
answer to "for how long?", the status is the answer to "is it idle at all?", and
both have to be true.

Migration 027 backfills every existing row with the migration's own timestamp.
That is the safe direction: an upgrade gives the whole fleet a fresh idle period
rather than archiving every long-stopped server on the first tick after deploy.

### What the sweep will not touch

Beyond `status = 'stopped'` and the window:

- **`error`.** A server that failed to start is one somebody is probably trying
  to fix, and archiving it would take the evidence off the node.
- **A row with no container.** Its first install never finished; there is nothing
  to archive and a delete is the right action.
- **`backups_enabled = false`.** The only per-server opt-out that exists, and it
  reads exactly right here: an owner who has said "do not put my files in S3 on a
  schedule" has said the thing that would otherwise happen. They can still archive
  by hand, and an operator who needs the disk back can turn the flag on.
- **Anything with a backup or restore in flight.** Two restics on one repository
  contend on its lock.

Oldest-idle first, so a fleet that drains over several ticks drains in the order
an operator would have picked.

### Why it runs on the backup scheduler's timer

An archive *is* a backup as far as a node is concerned. A separate timer could
start an archive and a scheduled backup against one repository at the same
instant. One timer, running reconcile → fire → sweep in sequence, makes that
impossible without a lock — the same argument that put the two cron schedules on
one timer in the first place.

It is not itself a cron, and the admin card says so: "stopped for thirteen days"
is continuously true or false for each server on its own clock, so there is no
time of day to pick. `concurrency` (default **1**, not the backup schedule's 2)
is what keeps a fleet with fifty idle servers from uploading fifty worlds at
once. One at a time is right here because, unlike a nightly backup, there is no
window to hit: a fleet that takes a week to drain has lost nothing.

### A failed archive is not retried immediately

The catch path bumps `last_active_at`. Without it, a server whose node is down
would be picked by the sweep on every tick forever, writing a failed backup run
each time. Bumping the column drops it out of the candidate window for another
full idle period, which is a backoff that needs no extra state, and the reason
sits on the row in `archive_error` for whoever looks.

## What the owner sees

The **archive card** sits at the bottom of *Settings → General*, directly above
Reinstall. The pairing is deliberate: both look alike from a distance — a big
button at the bottom of Settings that takes the server away — and the one that
keeps every file is the one an owner should read first.

Archived, the server page is replaced entirely by a notice, the way a suspended
or installing one is. There is genuinely nothing there: no container to attach a
console to, no files to list, and the database explorer would be the one tab that
still worked, which is the most confusing outcome available. Unlike the other
three lockouts this one **applies to admins too** — the others exempt an admin
because they have a job to do on the page (read the install log, watch a
migration), and on an archived server there is nothing on the node for anybody to
inspect.

The notice renders the archive card itself rather than linking to Settings, since
it replaces Settings along with everything else and the link would come back
here. The same component owns both directions, which is what keeps the two halves
describing each other consistently.

An automatically archived server says so, on the notice and in the audit row:
nobody pressed anything, and "why is my server off?" has to be answerable without
support.

## Permissions

| Action | Requires |
| --- | --- |
| Archive, restore from archive, read the archive status | Owner or admin |

**Not** the `backups` flag, even though an archive takes one. That flag means
"may press the backup button"; this takes the server offline and deletes its
files from the node, which is the same class of action as delete and reinstall.
The line already sits there.

Reads gate with writes, per the project rule: a subuser with only `console` gets
the explanation on the lockout screen and no controls.

## Schema

| Column | Holds |
| --- | --- |
| `servers.status` | `archiving` / `archived` / `restoring` added to the CHECK |
| `servers.archived_at` | When the archive completed. The flag as well as the timestamp |
| `servers.archive_snapshot_id` | **The pointer to the only copy.** Denormalised on purpose |
| `servers.archive_run_id` | The run whose log is the archive's progress. `ON DELETE SET NULL` |
| `servers.archive_trigger` | `manual` or `idle` — two different answers to "why?" |
| `servers.archive_error` | Why the last attempt did not finish. Outlives the attempt |
| `servers.last_active_at` | The idle clock: time of the last status change |
| `backup_runs.trigger` | `archive` added to `manual` / `scheduled` |

`archive` is a third trigger rather than a reuse of the two that existed, because
both would have lied somewhere that matters. `scheduled` feeds the backup
schedule's double-fire guard, so an auto-archive wearing it would suppress that
minute's real backup for the same server. `manual` would make an automatic
archive claim somebody pressed a button.

## What archiving does *not* free

The server's **ports** stay claimed, and its resource reservation stays counted
against its node. Both are deliberate, and they are the cost of the promise.

An archived server comes back to the same address on the same node. Releasing its
ports would mean the next server provisioned there could take them, and the
restore would either fail or hand the owner a different address — which would
make archiving a migration with extra steps. Releasing the CPU/memory reservation
would oversubscribe the node for a server that is coming back to it, so the
restore could be refused by the scheduler on a node that was only full because
the panel had promised the space away.

Disk is what this reclaims, and on an idle game server disk is essentially all of
it.

## Files

| Path | Role |
| --- | --- |
| `…/services/serverArchive.ts` | Both directions, the commit point, boot recovery, the idle sweep |
| `…/routes/archive.ts` | HTTP handlers (owner or admin) |
| `…/services/serverBackups.ts` | `startArchiveRestore`, and the guards that keep an archived server out of the ordinary backup paths |
| `…/services/statusReconcile.ts` | The rule that the three statuses outrank the node (tested) |
| `…/nodes/backupScheduler.ts` | Runs the idle sweep on the one timer |
| `…/db/migrations/027_server_archive.sql` | Schema |
| `components/server/archive-server-card.tsx` | The card, both directions |
| `components/server/server-shell.tsx` | The full-page lockout |
| `components/admin/backup-settings.tsx` | The auto-archive policy card |
