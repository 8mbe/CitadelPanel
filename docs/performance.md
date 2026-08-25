# Performance

Two costs dominate every panel request: a blocking Docker call on the node, and
a database round trip from the control plane. This doc covers both, and the
rules the code follows to keep them off the hot path. Read this before adding a
read endpoint, a node call, or a poll; all three traps are easy to walk back
into.

## Rule 1: the agent never blocks on `docker stats`

`GET /containers/{id}/stats?stream=false` looks like a snapshot and is not. The
daemon takes a reading, **waits out its own collection interval**, takes a
second, and only then answers. One to two seconds, every call, on an idle
machine. It does that because CPU usage is a rate: the payload's `precpu_stats`
is the earlier reading, and Docker will not answer until it has both.

That delay was the single largest source of latency in the product. It sat under
the per-server stats poll behind every open server page, and under the admin
fleet list, which samples every server on every node.

`one-shot=true` returns immediately (~5 ms) but zeroes `precpu_stats`, so the
daemon-supplied pair is gone. The agent supplies its own instead:
`docker/stats.ts` keeps the last CPU counters it read per container
(`cpuBaselines`) and differences the new reading against them. The pairing is
strictly better for a poller. The percentage covers the interval between polls
rather than an arbitrary one-second window inside a request.

The map is what makes the whole thing work, so its edges matter:

- **Asked again within `MIN_CPU_INTERVAL_MS`** (two viewers on one server, or
  the admin sweep landing on top of a page poll): the older baseline is *kept*
  and its percentage reused. Replacing it would leave the next caller measuring
  across a few milliseconds of noise.
- **No usable baseline.** First sample for this container, a gap longer than
  `MAX_CPU_BASELINE_AGE_MS`, or a counter that went backwards because the
  container restarted. Here the agent takes a second reading after a short wait
  rather than reporting a misleading `0`. Still an order of magnitude cheaper
  than the daemon's own blocking sample, and it happens once per container.
- Baselines for containers nobody has asked about are evicted, and a container
  that 404s has its baseline dropped.

Disk usage is the other half of a sample and is cached separately in
`servers.ts` (`cachedDiskUsageMb`): walking a populated game world is thousands
of small files, and it changes far more slowly than a usage meter is polled.

**If you add a stats-shaped endpoint, do not call `stats({ stream: false })`.**
Go through `sampleContainerStats`.

### Poll for what is on screen, not for what is mounted

The stats sample is cheap now, but it is still a request per poll per viewer,
and it reaches all the way to the node. The server page's data provider wraps
every section while the cards that read the sample live in one of them, so
polling unconditionally meant the files, settings, backups and activity tabs all
sat there sampling CPU for numbers nobody was looking at.

The poll is demand-driven instead: `ResourceStats` calls `useLiveResourceStats()`,
the provider counts subscribers, and the interval runs only while at least one is
mounted. The declaration lives in the component that renders the numbers, so
moving the cards to another section moves the poll with them.

The layout's seed fetch used to serve the same idea, until the layout stopped
fetching at all. See Rule 3 for what replaced it.

### One request per tick, not per tile

The dashboard's tiles poll every few seconds while a server is running, and the
per-server `/stats` endpoint costs one authenticated round trip each. An owner
with ten running servers paid ten requests per tick, each resolving access,
re-reading the row, and reaching its node separately.
`POST /api/servers/stats-batch` (`routes/servers.ts`) resolves the caller's
access to every named server in **one** statement (the subuser grant LEFT
JOINed on, same decision `resolveServerAccess` makes), groups the allowed ones
by node so each node's agent is asked exactly once, and returns a map. Servers
the caller cannot reach are simply absent, the same hide-existence rule the
individual endpoint applies with its 404. The abuse watcher's sweep had this
shape first; the dashboard endpoint is the same idea pointed at owners.

The sweep goes one step further: nodes are sampled concurrently, up to four at
a time (`security/watcher.ts`). Nodes are independent machines, so waiting for
one slow or dead agent before even asking the next stretched each sweep by the
*sum* of node latencies; the cap bounds the burst any one sweep puts on the
fleet's agents. Error containment is unchanged. An unreachable node logs and
returns, and one server's scoring failure costs only itself.

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
concurrently. They are independent of each other, so the endpoint is two
database round trips and one node round trip deep instead of a chain of seven.
`getServerPluginSupportSummary` takes the row it already has (`PluginServerFields`)
rather than re-reading it.

### Batch across rows, never loop

The list endpoints resolve every row's ports in one `WHERE server_id = ANY(...)`
(`loadPortsForMany`) and every owner in one `WHERE id = ANY(...)`. The admin
fleet list groups servers by node so each node's agent is asked exactly once
(`sampleNodeServers`), rather than once per server. A per-row query inside a
loop is the failure mode this codebase keeps rediscovering. See the history of
`summariesFromRows`.

The same list's search (`GET /api/admin/servers?q=`) is filtered in SQL, in
`listAllServers`, rather than in the page. The rows are cheap; the sampling that
follows them is not, so narrowing the set before the fan-out means a search also
narrows how many node agents get asked. For the same reason the admin page
debounces the query by 250ms instead of refetching per keystroke: the users
directory can afford a request per character because it is one query, and this
page cannot because it is one query plus a round trip to every node still in
the result.

Batching also means one statement per *write* of a set. `writeEnvValues` upserts
a whole env block through one `UNNEST`, because provisioning writes a
blueprint's entire environment at once. It is also the single place that decides
whether a value is encrypted. The owner's env form used to write secret-flagged
values in the clear, which `loadEnvForContainer` then failed to decrypt on the
next container build.

### Cache what is read constantly and written almost never

Three caches exist purely to keep a query off the hot path. All are correct
because **every write path invalidates them explicitly**; the TTL is a backstop,
not the mechanism.

| Cache | Where | Invalidated by |
| --- | --- | --- |
| The whole `blueprints` table | `blueprints/registry.ts` | `invalidateBlueprintCache()`, called by the boot sync and by every write in `services/blueprintManager.ts` |
| A node's decrypted credentials | `nodes/nodeRegistry.ts` | `invalidateNode()`, reached through `invalidateNodeConnection()` in `nodes/nodeApi.ts`, which the node update and delete routes call |
| Resolved sessions | `auth/sessionCache.ts` | `invalidateSessionCache()`, from Better Auth's after-hook on every action that revokes a session |

The node cache matters more than it looks. `getNodeWithSecrets` sat in front of
*every* agent call: console attach, status reconcile, stats poll, file listing.
So a page that touched its node four times paid for four reads and four AES
decrypts of a row an admin last edited months ago.

The session cache exists because of a gap that is easy to miss. Better Auth's
cookie cache is meant to make `getSession` free, and for five minutes it is.
But the panel calls `auth.api.getSession({ headers })` and **discards the
response**, so the `Set-Cookie` that would re-establish the cache never reaches
the browser; only the sign-in response ever writes it. Every session older than
its cookie cache, which is every session in real use, therefore paid two extra
database round trips on *every* request, permanently. That was ~127 ms per
request here.

What makes caching sessions acceptable rather than reckless is that the parts
that must not go stale are not cached: `authorizeSession` re-reads `banned` and
`role` from the database on every single request, which is the same compensation
the cookie cache already depends on. Revocation is immediate rather than
TTL-bounded. Signing out changes the cookie, so the key changes, and any
server-side revocation clears the cache through the after-hook.

**If you add a write to `blueprints` or `nodes`, invalidate.** A stale blueprint
is a server built from the wrong image; a stale node is calls sent to an old
address with an old token. **If you add an auth action that ends a session, add
its path to `SESSION_REVOKING_PATHS`.**

### Resolve permission alongside the read, not before it

`resolveServerAccess` reads the server row and LEFT JOINs the caller's subuser
grant in one statement, so a subuser's request costs the same as an owner's.

The logs and stats endpoints go further: `requireConsoleAccessAndLocation` runs
the permission guard and the two-column location read *concurrently*. The guard
is still what gates the response. If it throws, the whole expression rejects
and the row is never surfaced. The win is that the endpoint waits once instead
of twice. That is worth doing where an endpoint is polled for as long as a page
is open; it is not worth doing anywhere else.

## Rule 3: a page is as slow as its deepest chain of fetches

Endpoint latency is only half of it. A page that fetches A, waits, then fetches
B pays both, and the browser is where that shows up, not the server log.

The pattern to watch for is a component that renders a skeleton until its own
fetch resolves, with the things that need *other* data as its children: those
children cannot start until it finishes, even when their data is entirely
independent. `/admin/backups` was four levels deep this way; the cards each take
`settings` as a prop, so the storage read and the database list could not begin
until the settings read came back.

Two cheap habits keep this down:

- **Do not debounce the first run.** The schedule cards waited 400 ms before
  their first preview, which is a debounce for keystrokes being charged to a page
  load where nothing had been typed. Delay changes, not the initial value.
- **Measure in a browser, not with curl.** Load the page with CDP and count
  `Network.requestWillBeSent`. Two cautions, both of which produced wrong
  readings while this was written: React StrictMode double-fires effects in dev,
  so every request appears twice and neither is a bug; and a page left open from
  a previous measurement keeps polling, so close every existing target and let
  the old page go quiet before counting.

### The fix that worked: resolve in a server component, seed the provider

The server page was the worst offender: its layout was a client component that
gated every section on its own `GET /api/servers/:id`, so nothing else on the
page could even begin until that round trip came back. The layout is now a
server component (`resolveServerView` in `lib/server/server-view.ts`) that
authorizes and reads the record during rendering, the same move the panel
layout already made for the session, and seeds `ServerDataProvider` with it.
Sections fetch their own data from their first mount; the shell's fetch no
longer exists to wait behind.

One trade-off was accepted: the old client layout also pre-fetched a stats
sample alongside the record (for sections that show one), because it knew the
pathname and the server component does not. The first sample now comes from the
provider's existing demand-driven poll instead. That is one poll later than the
old seed, against every section loading ~a round trip sooner. If that ever
matters, the seed can come back as a prop passed down from each section route,
which knows what it renders.

## What this does not fix

None of the above changes the cost of a single round trip. If the panel's
`DATABASE_URL` points through an SSH tunnel or across a WAN, every remaining
query still pays that latency and the endpoints will be slow in proportion.
Co-locating Postgres with the panel is worth more than any further query
shaving.

Known and not yet addressed:

- **`/admin/backups`.** Still two waves, because every card needs `settings`.
- **Banning a user** suspends their servers one at a time, and each suspend stops
  a container with a grace period. For an owner with many servers that request
  can run for minutes.
- **`GET /api/servers/:id/backups/snapshots`** is ~800 ms, nearly all of it the
  agent starting a throwaway restic container and reaching S3. Not a panel
  problem, but it is the slowest read in the product.

## Related

- `server-lifecycle.md`: what the stored status means and why the node is the
  truth, which is the reconcile `getServerReconciled` runs.
- `plugins.md`: the plugin context these reads resolve.
- `ports.md`: the port rows the list endpoints batch.
- `../lib/server/control-plane/security/watcher.ts`: the sweep this doc's
  per-node batching and concurrency caps were built for.
