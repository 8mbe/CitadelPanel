# Node maintenance

An administrator drains a node with **Admin → Nodes → a node → Drain**, or
`PATCH /api/admin/nodes/:id` with `{ "isActive": false }`. Draining now stops
the node's workloads as well as removing it from server placement. It does not
move servers, release their ports or resource allocations, or delete data.

Related: [server-lifecycle.md](server-lifecycle.md), [scheduler.md](scheduler.md),
[backups.md](backups.md), [node-database.md](node-database.md),
[direct-console.md](direct-console.md), and [sftp.md](sftp.md).

## Intent first, shutdown second

The panel records `nodes.is_active = false` before asking the agent to stop.
That ordering matters when the node is unreachable: maintenance intent remains
stored, new placement and ordinary agent calls are refused, and a failed
request never silently puts the node back into service. The `node.drain` audit
entry records the administrator's action even if shutdown cannot finish.

The status sweeper includes every registered node, even ones with no game servers. It
reconciles maintenance at panel boot and every 30 seconds, using the existing
reachability backoff after failures. This also covers nodes drained before this
behavior was introduced. An offline node cannot be stopped remotely; the sweep
finishes its shutdown when the agent becomes reachable. A failed stop is
reported to the administrator and retried without abandoning the other
containers.

The agent's authenticated `POST /v1/maintenance` closes its execution latch
before stopping containers. Games, blueprint install containers, the managed
node database, and backup/dump/restore tool containers receive Docker's normal
30-second graceful stop, after which Docker kills a process that has not exited.
Paused containers are unpaused first so they can shut down. Container labels,
rather than a panel-supplied container ID, select these workloads; unrelated
containers on the Docker host are left alone.

Server rows become `stopped` only after the agent reports a stopped container.
Suspension, migration, archive, and provisioning statuses retain their owners;
an interrupted install or backup records its failure through its existing
task or job path. Startup watchdogs are cancelled before shutdown so this
deliberate stop does not become a recorded startup crash.

## Why the agent stays reachable

Stopping the agent itself would remove the mechanism used to finish a failed
drain, check health, and activate the node. Maintenance therefore keeps HTTP
and the SFTP listener alive while refusing ordinary work with HTTP 503 or
rejecting SFTP authentication. Health, container state, saved logs, discovery,
backup job reconciliation, stop/kill, and maintenance control remain available.
File operations, transfers, stats sampling, SQL, container creation, starts,
restarts, and backup/repository tools are blocked. Panel metadata remains
readable and editable.

The panel client and agent use the same endpoint allowlist in
`shared/nodeMaintenance.ts`. Checking both sides prevents a browser, API key,
scheduled task, or request accepted just before draining from bypassing the
maintenance state. New scheduled tasks, scheduled server backups, node database
backups, and automatic archives exclude inactive nodes; delayed schedule tasks
check the node again before running.

Existing console sockets and SFTP connections are closed when the latch closes.
The maintenance abort signal also interrupts transfer processes and streamed
file uploads. A file pull cancels its upstream fetch, and interrupted
uploads/pulls discard their staged file instead of replacing the original.
Short filesystem calls already executing may settle; maintenance does not roll
back operations completed before the drain.

Every container launch checks the latch immediately before starting and again
after Docker answers. The drain waits for launches already in flight; a launch
that raced it stops its own container. A request's generation also survives
asynchronous image pulls, so old install or backup work cannot start a new
container even if the node has since been activated.

## Persistence and activation

The agent stores a private `.citadel-maintenance` marker at its own
`SERVER_DATA_ROOT`, outside each server's bind mount and file-access root. The
marker is synced to disk before shutdown and read before the agent accepts
requests. Restarting the agent preserves the latch and repeats the stop pass.
This is execution state, not a user/session database on the agent.

**Activate**, or `{ "isActive": true }`, clears the agent's marker before the
panel advertises the node as active. If the agent cannot acknowledge that,
the node remains drained. Activation permits placement and work again; it
does not start game servers or the shared database. Start them explicitly
after maintenance. Schedules resume at their next due time.

The panel serializes each node's activation and drain operations, including
background enforcement, across the agent call and the database write. Agent-side
serialization alone is insufficient: after activation clears the latch but
before the panel records `is_active = true`, a sweep can still observe a drained
node and send a new drain. That late drain would close the latch again after
activation succeeds, and could stop a migration's safety backup. Queued
enforcement therefore re-reads the database intent inside the same panel queue
and skips nodes that have since been activated. Failed operations release the
queue so activation can recover them; different nodes proceed independently.
This queue lives in the panel process, alongside the status sweeper.

Preventing the activation race does not repair a latch already left closed by
an earlier run. Active nodes therefore also have their agent's health checked:
when `maintenance` is explicitly `true`, the sweep clears the persistent latch
without stopping or starting workloads or changing the panel's active flag.
This recovery is recorded as `node.update` with the
`maintenance-reconciliation` trigger. A healthy active node receives no
activation call. An unreachable health probe is retried through the usual
backoff, and an older agent that omits the field is not assumed to be drained.
The fresh intent read, health probe, and recovery share the same per-node queue
as explicit activation and draining, so a queued administrator drain still wins.
This also repairs empty nodes; filtering by game-server count would leave their
persistent latch closed until their first provision failed.

Activation uses the same ten-minute agent request budget as draining. The agent
may still be finishing an earlier graceful stop when activation arrives; the
ordinary fifteen-second API timeout is shorter than even one stop's grace period.
Both paths first probe health with a five-second deadline. An already-offline
host should fail that probe rather than occupy the node's maintenance queue for
ten minutes. This does not shorten a reachable agent's graceful shutdown. On a
failed drain, the page refreshes the saved inactive flag, and an administrator
can [remove its servers without contacting the node](server-lifecycle.md#forcing-it-and-the-receipt)
before deleting the now-empty node. Node deletion itself reads only panel data.

Both the panel and agent need this version. An older agent without the
maintenance endpoint cannot acknowledge shutdown or activation; its error is
reported and the panel retains drain intent. No database migration or new
environment variable is required.
