# The node database

Every node that offers databases to its servers runs one MariaDB container next
to them. This doc is about that container's *existence*: creating it, starting
it, stopping it. What lives inside it (per-server databases, scoped users, the
explorer UI) is `docs/database-explorer.md`; backing it up is `docs/backups.md`.

## One button, because the agent already has the socket

Setting a node up used to mean SSHing in, running `bun run setup-db`, copying
the root password it printed, and pasting it into the register-node form. None
of that was a technical requirement. The node agent already holds the Docker
socket, which is the entire capability needed to run a database container, so
the panel can do all of it in one call and keep the credential itself.

Admin → Nodes → *(a node)* → **Shared database**:

- **Set up database**: creates the network, the data volume and the container,
  waits until MariaDB accepts connections, and records the address. This is what
  enables the Databases tab for every server on the node.
- **Start** / **Stop**: the container's power buttons.

The first-time-setup wizard offers the same button right after the first node is
registered, next to its port pool (see
[first-time-setup.md](first-time-setup.md)), so a fresh install does not have to
discover the feature later.

`bun run setup-db` still exists, as a thin CLI over the same functions
(`apps/backend/src/docker/nodeDb.ts`), for bringing a node up before it is
registered. The register-node form's database fields also remain, but they are
now for *adopting* a MariaDB the panel did not create, not the normal path.

## Flow

```
browser ──> POST /api/admin/nodes/:id/database/setup   (admin only)
                │
                │  panel generates the MariaDB root password (32 chars)
                │  and stores it ENCRYPTED on the node row FIRST
                ▼
          agent POST /v1/database/setup { rootPassword }
                │  ensure node_db_net (ICC on)
                │  ensure the data volume
                │  pull mariadb:11, create + start the container
                │  poll `mariadb-admin ping` until it answers
                ▼
          { exists, state, ready, host, port, … }
                │
                ▼
          panel stores host:port on the node row
          -> nodes.hasDatabaseServer flips true, owners can provision
```

Start and stop are the same shape without the create.

## Why the password is stored before the container exists

Setup can take minutes on a cold node: an image pull, then MariaDB's first-boot
initialisation. That is long enough to time out. If the password were only
persisted *after* the agent answered, a timed-out setup would leave a running
database whose root password nobody knows, and no way back except destroying it.

So the panel generates the password, writes it encrypted, and only then calls the
agent. Retrying presents the **same** password, and `setUpNodeDb` treats a
container that accepts it as success. The whole operation is idempotent as a
result: pressing the button again after a timeout finishes the job.

### The other refusal: a database this agent does not run

If the node already has a *configured address* (`db_admin_host`) and this agent
has no container, setup refuses. That state means the register-node form was
given an existing MariaDB's credentials: creating a container would take that
stored credential, use it for a brand new empty database, and overwrite the
address, quietly cutting every server on the node off from the data it was
using.

It is a confirmation rather than a hard refusal, because the same state also
covers "our container was removed", which is a real thing to want to fix. The
admin card names the address being replaced and asks; only then does it send
`replaceEndpoint: true`. The wizard never sends it: there, the state simply means
the operator typed those credentials a minute ago.

A container that exists and *rejects* the stored password is a 409, not a
recreate. It means another panel install (or a hand-run of the script) owns this
node's database, and recreating it would destroy every tenant's data. The panel
says so and names the two ways out.

Until the container is up, the row holds a user and password but no host.
`hasDatabaseServer` is `host AND user`, so a half-finished setup never offers
owners a database that does not exist.

## The data volume

The container mounts a named volume (`citadel-node-db-data`) at
`/var/lib/mysql`. This is what makes the container disposable: `docker rm` on the
database is a restart, not a data loss, so an image bump or a botched setup is
recoverable. Without it MariaDB's data would sit in the container's writable
layer, where any `rm` silently destroys every tenant's database.

Nodes set up before this existed keep their data in the container layer. They
keep working; the volume only applies to containers created from here on.

## Two properties that must not be "fixed"

Both are pinned by `apps/backend/src/docker/nodeDb.test.ts`, because both look
like harmless changes and neither is:

1. **No published host ports.** MariaDB is reachable only from containers on
   `node_db_net`. Publishing 3306 would expose every tenant's database to the
   node's network and, on most hosts, the internet.
2. **ICC enabled on `node_db_net`.** Tenant isolation comes from MariaDB's
   per-database grants, never from the bridge. With `enable_icc=false` no game
   server can reach the database at all: the TCP connect just times out, which
   presents as "databases are broken" rather than as a network setting.

The second one was a real bug. Early `setup-db` runs created the network with ICC
off, so `ensureNodeDbNetwork` now *repairs* it during setup: an ICC-disabled
network with nothing attached is recreated (a network is only metadata), and one
with containers still attached is refused with the commands to fix it by hand.
`assertNodeDbNetworkAllowsIcc` is the same check on every later operation, for a
network someone recreated manually.

## Stopping is allowed, and warned about

Stopping the database takes every server database on the node offline until it is
started again. Game containers keep running; their queries fail. That is a
legitimate thing for an admin to want (maintenance, a restore), so it is not
blocked: the dialog names how many server databases are affected, and the audit
row records the count.

Stop leaves the stored `host` alone. Docker assigns the container's IP at start,
so a *stopped* container reports no address, and clearing the stored one would
turn "the database is down" into "this node never had a database". Start
re-records the address, because a restarted container can come back on a
different IP; skipping that is how a node quietly stops being able to provision
databases after a reboot.

## Status has four states, not two

The card distinguishes them because the difference is what an operator acts on:

| Badge | Meaning | Action offered |
| --- | --- | --- |
| Not set up | no container on the node | Set up database |
| Stopped | container exists, not running | Start |
| Starting | running, not answering yet | (wait) |
| Running | answering `mariadb-admin ping` | Stop |
| Unknown | the node's agent did not answer | (fix the node) |

"Starting" earns its own state because Docker reports a container as running for
the ~20s MariaDB spends initialising, and a green badge over a database that
refuses connections teaches operators to distrust the badge. `ready` is only
probed when the panel has a password to probe with, since the ping is a
`docker exec`.

The card fetches itself rather than arriving with the node page: the status costs
an agent round trip plus that exec, and the rest of the page should not wait on
it (see `docs/performance.md`).

## Configuration

All shared between the agent and the CLI script (`apps/backend/src/config.ts`):

| Variable | Default | What it is |
| --- | --- | --- |
| `NODE_DB_NETWORK` | `node_db_net` | The internal bridge |
| `NODE_DB_CONTAINER` | `citadel-node-db` | Container name |
| `NODE_DB_VOLUME` | `citadel-node-db-data` | Data volume |
| `NODE_DB_IMAGE` | `mariadb:11` | Pinned to a major version |

## Audit

`node.database.setup`, `node.database.start`, `node.database.stop`, all against
the node. Setup records whether it minted the credential or reused the stored
one; stop records how many server databases it affected. Never the credential.
