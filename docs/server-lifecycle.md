# Server lifecycle

What happens between "the server exists as a row" and "the game is running":
the power actions, the status the panel stores, and how the panel recovers when
its record of a container and the node's reality drift apart.

## Status is a record, the node is the truth

`servers.status` is what the panel last observed or intended
(`creating`, `installing`, `stopped`, `starting`, `running`, `stopping`,
`suspended`, `error`, `deleting`). It is written before the node is asked to do
anything and corrected after — the ordering principle in
`services/serverManager.ts`: a DB row with no container is recoverable, a
container with no DB row is an orphan nobody can see.

Because the status is a record rather than an observation, it can be wrong: a
game that crashes on its own leaves `running` behind. `reconcileServerStatus`
is the correction — it asks the agent for the container's real state and maps
it back onto the stored status. Suspended servers are never reconciled away;
that state is an administrative decision, not an observation of the node.

## The power actions

`startServer`, `stopServer`, `killServer`, `restartServer` all follow the same
shape: load the row, refuse if suspended (start/restart only), refuse if the
row has no container at all, write the transitional status, call the agent,
write the settled status, audit. `server.kill` is audited distinctly from
`server.stop` so a destructive action is visible in the log.

Start and restart run the plugin auto-updater first, because plugins must be on
disk before the game process reads the directory — see
[plugins.md](plugins.md).

## When the container is gone from the node

The panel addresses containers by server id, but it also stores the container
id it created (`servers.container_id`), and that pointer can outlive the
container. A `docker rm` on the node, a prune, a rebuilt host, a recreate that
removed the old container and then failed to build the new one — all leave a
row that says "this server has a container" and a node that answers every
lifecycle call with the agent's

```
No container exists on this node for server <id>.
```

Nothing in the UI used to clear that: the only code path that creates a
container is provisioning, and provisioning already ran. The server was stuck
in `error` with no way back.

So every power action now runs through `withMissingContainerRecovery`. On a 404
from the node it asks the agent for the container's state, and if the answer is
`missing` it rebuilds the container from the stored spec
(`recreateServerContainer`) and retries the action once.

Two properties make this safe rather than clever:

- **Rebuilding is non-destructive.** The data directory belongs to the agent
  and outlives any container (`SERVER_DATA_ROOT`, see the backend's
  `paths.ts`), so the new container comes up on the world, config and logs the
  old one left behind. The recreate re-derives everything else — image, env,
  resource limits, startup command, port bindings, DB and link networks — from
  the database, which is the same thing that happens when an owner publishes a
  port ([ports.md](ports.md)).
- **The retry is idempotent.** Start on a freshly built container is the normal
  case; the agent's stop and kill both treat "not running" as success.

A 404 that is *not* a missing container (the state read says the container is
there) is re-thrown untouched, and a rebuild that fails replaces the 404 with
its own message — an unreachable node, a blueprint that is no longer
registered — because that is the error worth reading.

The stale pointer is also cleared at the source: `recreateServerContainer` sets
`container_id` to `NULL` as soon as the old container is removed, so a create
that fails halfway does not leave the row naming a container that no longer
exists.

## What is not auto-healed

- **A row that never had a container** (`container_id IS NULL`) — still a plain
  409 telling the owner it may be provisioning or have failed to create.
  Provisioning failures deserve the operator's eyes, not an automatic retry
  loop.
- **The console and log streams.** They 404 with the same message when the
  container is missing; the console shows it as a terminal event rather than
  rebuilding a container behind a viewer's back
  ([direct-console.md](direct-console.md)).
- **Status polling.** `reconcileServerStatus` maps a missing container to
  `error` and stops there. Reads never create infrastructure — the rebuild
  happens on the power action the operator deliberately took.
