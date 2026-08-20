# Performance

The two costs that dominate every panel request — a blocking Docker call on the
node, and a database round trip from the control plane — and the rules the code
follows to keep them off the hot path. Read this before adding a read endpoint
or a node call; both traps are easy to walk back into.

## Rule 1: the agent never blocks on `docker stats`

`GET /containers/{id}/stats?stream=false` looks like a snapshot and is not. The
daemon takes a reading, **waits out its own collection interval**, takes a
second, and only then answers — one to two seconds, every call, on an idle
machine. It does that because CPU usage is a rate: the payload's `precpu_stats`
is the earlier reading, and Docker will not answer until it has both.

That delay was the single largest source of latency in the product. It sat under
the per-server stats poll behind every open server page, and under the admin
fleet list, which samples every server on every node.

`one-shot=true` returns immediately (~5 ms) but zeroes `precpu_stats`, so the
daemon-supplied pair is gone. The agent supplies its own instead:
`docker/stats.ts` keeps the last CPU counters it read per container
(`cpuBaselines`) and differences the new reading against them. The pairing is
strictly better for a poller — the percentage covers the interval between polls
rather than an arbitrary one-second window inside a request.

The map is what makes the whole thing work, so its edges matter:

- **Asked again within `MIN_CPU_INTERVAL_MS`** (two viewers on one server, or
  the admin sweep landing on top of a page poll): the older baseline is *kept*
  and its percentage reused. Replacing it would leave the next caller measuring
  across a few milliseconds of noise.
- **No usable baseline** — first sample for this container, a gap longer than
  `MAX_CPU_BASELINE_AGE_MS`, or a counter that went backwards because the
  container restarted — the agent takes a second reading after a short wait
  rather than reporting a misleading `0`. Still an order of magnitude cheaper
  than the daemon's own blocking sample, and it happens once per container.
- Baselines for containers nobody has asked about are evicted, and a container
  that 404s has its baseline dropped.

Disk usage is the other half of a sample and is cached separately in
`servers.ts` (`cachedDiskUsageMb`): walking a populated game world is thousands
of small files, and it changes far more slowly than a usage meter is polled.

**If you add a stats-shaped endpoint, do not call `stats({ stream: false })`.**
Go through `sampleContainerStats`.

## Rule 2: panel endpoints are shaped around database round trips

The control plane's database is frequently not on the same machine as the panel.
A round trip that costs microseconds in development can cost tens of
milliseconds in a real deployment, and it is *serial* cost: ten sequential
lookups is ten times the latency, no matter how trivial each query is.

So the metric that matters for a read endpoint is not how many rows it reads but
**how many times it waits**. Three principles follow.

### Read the row once, then fan out

Everything a server detail view needs descends from one `servers` row. Read it
once and pass it down; do not let each helper re-read the columns it happens to
want.

`getServerReconciled` is the worked example. It loads the row (joining
`nodes.hostname` and `blueprints.key` in the same statement), then runs the
ports lookup, the plugin-support probe, and the node's status reconcile
concurrently — they are independent of each other, so the endpoint is two
database round trips and one node round trip deep instead of a chain of seven.
`getServerPluginSupportSummary` takes the row it already has (`PluginServerFields`)
rather than re-reading it.

### Batch across rows, never loop

The list endpoints resolve every row's ports in one `WHERE server_id = ANY(...)`
(`loadPortsForMany`) and every owner in one `WHERE id = ANY(...)`. The admin
fleet list groups servers by node so each node's agent is asked exactly once
(`sampleNodeServers`), rather than once per server. A per-row query inside a
loop is the failure mode this codebase keeps rediscovering — see the history of
`summariesFromRows`.

### Cache what is read constantly and written almost never

Two caches exist purely to keep a query off the hot path. Both are correct
because **every write path invalidates them explicitly**; the TTL is a backstop
for a second panel process, not the mechanism.

| Cache | Where | Invalidated by |
| --- | --- | --- |
| The whole `blueprints` table | `blueprints/registry.ts` | `invalidateBlueprintCache()` — called by the boot sync and by every write in `services/blueprintManager.ts` |
| A node's decrypted credentials | `nodes/nodeRegistry.ts` | `invalidateNode()`, reached through `invalidateNodeConnection()` in `nodes/nodeApi.ts`, which the node update and delete routes call |

The node cache matters more than it looks: `getNodeWithSecrets` sat in front of
*every* agent call — console attach, status reconcile, stats poll, file listing
— so a page that touched its node four times paid for four reads and four AES
decrypts of a row an admin last edited months ago.

**If you add a write to `blueprints` or `nodes`, invalidate.** A stale blueprint
is a server built from the wrong image; a stale node is calls sent to an old
address with an old token.

### Resolve permission alongside the read, not before it

`resolveServerAccess` reads the server row and LEFT JOINs the caller's subuser
grant in one statement, so a subuser's request costs the same as an owner's.

The logs and stats endpoints go further: `requireConsoleAccessAndLocation` runs
the permission guard and the two-column location read *concurrently*. The guard
is still what gates the response — if it throws, the whole expression rejects
and the row is never surfaced — but the endpoint waits once instead of twice.
That is worth doing where an endpoint is polled for as long as a page is open;
it is not worth doing anywhere else.

## What this does not fix

None of the above changes the cost of a single round trip. If the panel's
`DATABASE_URL` points through an SSH tunnel or across a WAN, every remaining
query still pays that latency and the endpoints will be slow in proportion.
Co-locating Postgres with the panel is worth more than any further query
shaving.

## Related

- `server-lifecycle.md` — what the stored status means and why the node is the
  truth, which is the reconcile `getServerReconciled` runs.
- `plugins.md` — the plugin context these reads resolve.
- `ports.md` — the port rows the list endpoints batch.
