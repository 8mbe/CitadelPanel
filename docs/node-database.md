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

The register-node form offers it too, inside the **Shared database** toggle:
**Set it up for me** creates the database on the agent whose URL and token are
typed above, then fills the form's four fields from the answer. That is the only
place the first-time-setup wizard offers it (see
[first-time-setup.md](first-time-setup.md)); a node that skipped the toggle is
given one from its admin page later, which is where start and stop live anyway.

`bun run setup-db` still exists, as a thin CLI over the same functions
(`apps/backend/src/docker/nodeDb.ts`), for bringing a node up before it is
registered. The register-node form's database fields also remain, but they are
now for *adopting* a MariaDB the panel did not create, not the normal path.

## The credential is generated, and it is not root

Nobody types or invents a database user or password. The panel mints both:

- **user** `citadel_<8 hex>`, so two nodes never share an account name and a
  credential from one node's row is recognisably not another's;
- **password** 32 alphanumeric characters (~190 bits), from the same generator as
  every other panel secret.

The agent creates that account inside MariaDB, then **forgets the image's root
password**: it generates one to get through first-boot initialisation and returns
it nowhere. So the panel's own account is the only credential anyone holds. A
second root-equivalent secret that nobody has is one fewer thing to leak, and the
recovery path if the panel's copy is lost is the Docker socket (recreate the
container against the kept volume), not a spare password.

This is *not* least privilege, and pretending otherwise would be dishonest: the
grant is `ALL PRIVILEGES ON *.* … WITH GRANT OPTION`, because the account's job is
to create a database and a user per server and grant that user rights (see
`provisionServerDatabase`). An account that creates accounts is root-equivalent.
What the named account buys is ownership: it is the panel's, it shows up as
itself in `SHOW PROCESSLIST`, and it can be replaced without touching root.

Alphanumeric is load-bearing, not cosmetic. The user and password are the only
values interpolated into a `CREATE USER … IDENTIFIED BY` literal, so restricting
their alphabet removes the quoting question instead of answering it. The agent
re-validates both shapes before any SQL runs
(`apps/backend/src/docker/nodeDb.test.ts` covers quotes, backslashes, spaces and
semicolons), because the agent is root-equivalent on this database and does not
take the panel's word for it.

`adminUser: "root"` is still accepted, and means "no extra account": that is the
arrangement on nodes set up before this, and their setup/start/stop keep working
unchanged.

## Flow

```
browser ──> POST /api/admin/nodes/:id/database/setup   (admin only)
                │
                │  panel mints citadel_<hex> + a 32-char password and stores
                │  them ENCRYPTED on the node row FIRST
                ▼
          agent POST /v1/database/setup { adminUser, adminPassword }
                │  ensure node_db_net (ICC on)
                │  ensure the data volume
                │  pull mariadb:11, create + start the container
                │    (root password generated here, then forgotten)
                │  poll `mariadb-admin ping` until it answers
                │  CREATE USER + GRANT the panel's account
                ▼
          { exists, state, ready, host, port, … }
                │
                ▼
          panel stores host:port on the node row
          -> nodes.hasDatabaseServer flips true, owners can provision
```

Start and stop are the same shape without the create.

## A minute-long button has to say something

Setup is one blocking call that takes 30-90 seconds on a node that has never run
MariaDB: Docker pulls the image, MariaDB initialises its system tables, then the
panel's account is created. A spinner for that long reads as a hang, and the
first version of this feature proved it.

So both entry points run the call through `useNodeDatabaseProgress`
(`apps/frontend/lib/node-database-progress.ts`), which shows two things:

- **the phase**, polled off the node every 3 seconds rather than guessed from a
  timer, so the sentence on screen is what is actually happening. The phases are
  exactly the transitions the status endpoint can distinguish: no container yet
  (still pulling), container not running (starting), running but not answering
  (first-boot initialisation), answering (done). The last two are deliberately
  not split further, because from outside they are indistinguishable and both
  mean "wait";
- **elapsed seconds**, which is the part that proves the page is alive.

A failed poll is swallowed. The setup call owns the outcome, and a missed tick is
not news worth putting on screen.

## When the credential is refused: two options, and only two

MariaDB keeps its accounts **in the data volume**, not in the container. That one
fact decides the whole recovery story, and it is worth stating because the
obvious guess is wrong: `MARIADB_ROOT_PASSWORD` is applied only when the image
initialises an *empty* data directory, so on an existing volume the old
credentials survive every `docker rm` (verified against mariadb:11 — recreating
a container with a new password still authenticates with the old one).

So when a database refuses the panel's account, there are exactly two ways
forward, and the panel offers both rather than picking one:

| Option | What it does | Cost |
| --- | --- | --- |
| **Recreate the container** (`recreate: "container"`) | New container, same volume | Nothing. Every database survives. Only works if the stored credential is the one that volume knows |
| **Delete and start over** (`recreate: "all"`) | Deletes container **and volume** | Destroys every database on the node |

The first is offered first because it is free, and it is the fix for a container
that is broken, misconfigured or gone rather than a credential that is wrong. The
second always works, which is exactly why it is gated.

### The wipe is gated twice, server-side

`recreate: "all"` needs `confirm` to equal the node's name (the container's name,
in the pre-registration form). The dialog collects it in two steps, matching the
server-reinstall dialog: a page of consequences naming how many databases are
destroyed, then a checkbox plus the name typed by hand. A single "are you sure?"
is a reflex; typing the name is a decision.

The check is re-done in the route, so calling the API directly gains nothing, and
the audit row records `recreate` plus the number of databases that were destroyed
(counted before the volume is deleted, while they still exist).

## An access-denied ping is not a stage of starting up

The first version treated every failed ping the same and retried for 120 seconds,
so a wrong credential produced two minutes of "MariaDB is initialising its system
tables" over a container log full of `Access denied for user 'root'@'127.0.0.1'`.
That is a lie the logs contradict, which is worse than no progress output at all.

The probe is now three-valued (`alive` / `unreachable` / `denied`), classified by
the output text rather than the exit code, because `mariadb-admin` exits **0** on
an access-denied ping and 1 when the server is unreachable. Only the status line
distinguishes them.

`denied` short-circuits the wait after a 6-second grace (a first boot can briefly
answer before its grants are flushed), so a wrong credential now fails in about
9 seconds instead of 120, with a message that names the cause. The status
endpoint carries the same value, so the UI says "the database is up but refusing
this credential" instead of inventing an initialisation that finished long ago.

## Refusing before the wait, not after it

A machine that already has a `citadel-node-db` container cannot accept a
*newly generated* account: only whoever holds the existing credential can open
that database. The register form therefore reads the node's status **before**
minting anything, and refuses in milliseconds instead of after a full image
pull.

The refusal names the real cause, which depends on whether this panel already
knows the machine:

- **It does** (an agent URL matching a registered node): the operator is
  registering the same agent twice, and the database they are looking for is on
  that node's page. Only the credential stored on that node can open it.
- **It does not**: the container is from somewhere else. Enter its credential in
  the form's fields, or delete it and create a new one, which destroys whatever
  is in it (the same gated wipe as above). Removing only the container would
  change nothing, for the reason in the section above.

"Another panel install" was the only explanation the first version offered, which
was misleading in the most common case: one machine registered twice during a
local test.

### Before the node row exists

`POST /api/admin/nodes/database/provision` is the same operation addressed by a
raw `{ apiUrl, token }` instead of a node id, for the register form's button: at
that moment the four database fields are part of the create-node request, so
there is no node to address. It returns `{ host, port, user, password }` and
persists nothing. Its sibling `POST /api/admin/nodes/database/status` is the
status read with the same addressing, used for the preflight above and for
progress polling. Both live in `routes/nodeDatabaseSetup.ts`, split from the
node-id lifecycle routes in `routes/nodeDatabase.ts` because the addressing is
the whole difference.

That is the one path where a database credential is returned to a browser. It has
to be: the value's destination is a form field that posts straight back to
`POST /api/admin/nodes`, which stores it encrypted. The alternative, stashing it
server-side for create-node to collect, means inventing a second place to keep a
root-equivalent secret, which is worse than a value that lives in one admin's
page for one minute.

An operator who provisions and then abandons the form leaves a running database
and no credential in the panel. The node page reports exactly that (container
exists, panel has no credential) with the commands to clear it.

## Why the password is stored before the container exists

Setup can take minutes on a cold node: an image pull, then MariaDB's first-boot
initialisation. That is long enough to time out. If the password were only
persisted *after* the agent answered, a timed-out setup would leave a running
database whose root password nobody knows, and no way back except destroying it.

So the panel generates the credential, writes it encrypted, and only then calls
the agent. Retrying presents the **same** credential, and `setUpNodeDb` treats a
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

A container that exists and *rejects* the stored credential is a 409, not a
silent recreate: it means the volume belongs to a different install (or a
hand-run of the script), and the panel says so and offers the two options above.

Until the container is up, the row holds the account but no host.
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

`ready` means the ping succeeded **as the panel's own account**, not merely that
some database is listening, so it also proves the account survived.

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
