# Panel and node migration guide

Use this guide to move the panel to another host or connect an existing node to
a different panel. The panel owns accounts and metadata in PostgreSQL; nodes own
Docker containers and game files. Moving one does not move the other.

| What you want to move | Use | What survives |
| --- | --- | --- |
| The same panel onto a new panel host | Encrypted panel export/import | Accounts, settings, node and server identities, credentials and panel relationships |
| The same panel when its export is too large or its database has extensions | PostgreSQL dump and restore with the original boot secrets | The panel database, including its existing encrypted values |
| An existing node onto a different panel, without replacing that panel | Register the agent and recover its servers | Containers, files and recoverable server details; other panel records need separate setup |
| A game server onto a different node in the same panel | [Server migration](server-migration.md) | The server's identity and files, with a controlled node cutover |

For implementation details, see [panel export/import](panel-export.md),
[node recovery](node-recovery.md) and [Docker deployment](docker.md).

## Before either move

Keep a copy of the old panel database and its deployment configuration until
the new panel works. Store `.env` and exports privately. Node tokens grant full
control of their hosts, and private recovery manifests contain plaintext server
environment values.

Check out the same CitadelPanel revision on the destination. Encrypted import
requires matching database schemas; moving and upgrading in the same operation
can make the archive incompatible. Record the source revision with
`git rev-parse HEAD` and upgrade after the move is verified.

Plan a panel maintenance window. Pause server task schedules and, under
**Admin → Backups**, disable automatic backups and idle archiving. Record what
to enable again. Wait for builds, power actions, backups, migrations, archives,
restores and scheduled runs to finish. Game servers can keep running while the
panel moves.

Only one panel should control a node during cutover. Restrict user changes on the
source and stop its frontend before the destination takes over. A second panel
starts background workers even before users or DNS point at it. Draining a node
only prevents new provisioning; it does not block power actions or schedules.

## Move the whole panel to a new host

Encrypted export/import is the usual path. It retains the original user, node
and server ids, password hashes, two-factor settings, API keys, SFTP credentials,
ports, environment values, blueprints, subusers, plugins, links, schedules,
database credentials, audit history and backup pointers. The destination can use
new `PANEL_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` values because import
re-encrypts the stored secrets.

Game files remain on their nodes, MariaDB contents remain in the node database
volumes, and snapshots remain in S3. Keep those resources available. If the old
panel host also runs an agent, that host remains a node after its panel moves.
Retiring it requires a separate move of its game servers and databases.

### Prepare reachable addresses

In the source panel, check each node's **Agent URL** under
**Admin → Nodes → node → Edit**. The new panel must reach the same agent.
Replace local addresses such as `http://agent:8081`, `http://backend:8081` or
`http://localhost:8081` with a private address reachable from both panel hosts,
then test the connection before exporting. Allow the new panel host through the
node's firewall.

Those local names refer to the new host after a move. Starting the bundled
Compose stack there also creates an empty local agent; an imported local
address could therefore target the wrong Docker daemon and data root.

These addresses have different jobs:

| Setting | Where it belongs | Required address |
| --- | --- | --- |
| `FRONTEND_URL` | New panel environment | The exact public panel origin, such as `https://panel.example.com`; auth and trusted-origin checks use it |
| `PANEL_URL` | Every node agent's environment | The new panel's base URL as reachable from that agent; console and SFTP authentication call back here |
| Agent URL | Node record in the panel | The existing agent's HTTP or HTTPS address as reachable from the new panel |
| Console URL | Node record in the panel | The agent WebSocket address reachable by browsers; use `wss://` with an HTTPS panel |
| Hostname | Node record in the panel | The address players use to reach the game servers |

Keeping the public panel hostname avoids changing browser bookmarks, but a node
using `PANEL_URL=http://frontend:3000` still needs a new callback address. That
Docker alias points to the old frontend. Remote nodes already using the public
hostname can follow the DNS change instead. If the hostname changes, allow it
in any external captcha or other domain-restricted provider configuration before
signing in with the restored settings.

### Prepare a fresh destination

1. Deploy the source revision on the new panel host. Create its `.env` with
   `bun run env:init`, or fill in `.env.example` as described in
   [docker.md](docker.md). Set `FRONTEND_URL` and configure the reverse proxy and
   TLS for that origin. If keeping the same hostname, use a local hosts-file
   override on your operator workstation to reach the destination before public
   DNS cutover. Open the configured origin, since signing in through a different
   hostname or bare IP can fail the auth origin checks.
2. Start PostgreSQL and the frontend. When keeping every node on its existing
   host, the bundled Compose file can run just those services:

   ```bash
   # On the new panel host, from the repository root.
   docker compose up -d --wait postgres
   docker compose up -d --build --no-deps frontend
   ```

   `--wait` waits for the database healthcheck. `--no-deps` avoids starting the
   bundled local agent. Compose still needs an `AGENT_TOKEN` in `.env` to parse
   the file, even though this destination does not run its backend service.
3. Open `/setup` and choose **Restore an existing panel**. Create the temporary
   administrator if no account exists yet. Recovery then opens the encrypted
   import flow without configuring a node or building a first server.

Import requires a destination with no server records and replaces its users,
settings and nodes. Do not register the existing agents first: registration can
automatically recover servers and make the destination ineligible for import.
The temporary administrator exists only to authenticate the restore; import
replaces that account too.

If setup has already finished on an otherwise empty destination, the same import
is available under **Admin → Settings → Export and import panel**. There is no
merge of two panels or selective single-node import.

### Export and cut over

1. With automation paused and active work finished, open the source panel's
   **Admin → Settings → Export and import panel → Export panel**. Enter and
   repeat an archive passphrase of at least 12 characters, then click
   **Download export**. Keep the passphrase separately from the JSON archive.
2. Stop the source frontend immediately after the final export. With the
   bundled Compose deployment, run this on the old panel host:

   ```bash
   docker compose stop frontend
   ```

   Keep PostgreSQL, the node agent and its Docker networks intact. Use the
   equivalent frontend service stop for a Bun deployment. `docker compose down`
   also removes the bundled agent and networks, so it is unsuitable here.
3. In the destination's recovery flow, or **Import panel** in admin settings,
   select the export file, enter its passphrase and click **Preview import**.
   Check the export time, record counts and listed administrator emails.
4. Type `REPLACE PANEL` and click **Replace panel**. Import replaces metadata in
   one transaction. A failed validation or database transaction leaves the
   destination's previous metadata intact.
5. Click **Continue to sign in**. Use an administrator account from the old
   panel, with its original password and two-factor authentication. Browser
   sessions do not travel in the export. A completed source panel also brings
   its setup completion flag, so its restored accounts enter the panel directly.
6. Switch DNS or reverse-proxy routing to the new host when retaining the same
   public hostname. Set each agent's `PANEL_URL` to the destination if its current
   value does not already resolve there. Preserve the existing per-node bearer
   token, data root and Docker socket.
7. After editing a node's Compose environment, recreate only its agent, using
   the same Compose project and files that originally launched it:

   ```bash
   # On a node deployed with the standalone agent file.
   docker compose -f docker-compose.agent.yml up -d --no-deps backend

   # On the old panel host, if its bundled agent stays there.
   docker compose up -d --no-deps backend
   ```

   Use the command matching that node's deployment. A plain `restart` does not
   apply changed container environment. Recreating the agent leaves game
   containers running, but console and SFTP clients need to reconnect.

Do not generate new bearer tokens just because the panel moved. The export
already retains each node's token; changing only one side breaks authentication.
The agent process calls this value `NODE_TOKEN` in Compose, which maps it from
the host's `AGENT_TOKEN` variable.

### PostgreSQL restore as an alternative

Use a database backup when the encrypted export exceeds its 64 MB archive,
47 MB decoded metadata or 500,000-row limits, or additional database tables
prevent portable import. This path requires the exact original
`PANEL_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`. A raw dump retains ciphertext
and does not convert secrets to new keys. Copy the source deployment
configuration privately, then adapt the destination URLs and database connection
details.

Prepare node addresses and pause automation as above. Stop the source frontend
before dumping. For the bundled PostgreSQL service:

```bash
# On the old panel host, after active work has finished.
umask 077
docker compose stop frontend
docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > citadel-panel.dump
```

Transfer the dump privately. On the destination, start only PostgreSQL and
restore into its fresh database before starting the frontend or running setup
or migrations:

```bash
# On the new panel host, with the original panel encryption and auth secrets.
docker compose up -d --wait postgres
docker compose exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --single-transaction' \
  < citadel-panel.dump
docker compose up -d --build --no-deps frontend
```

The frontend performs its normal boot migrations after restore. Sign in with
the original administrator and complete the URL/callback cutover above; no
temporary administrator or setup import is needed. These examples assume the
stock database layout. Custom extensions and cluster-wide roles need separate
preparation. See PostgreSQL's [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
and [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) references.

## Move an existing node to a different panel

Choose node recovery when the destination is a separate panel whose own users
and servers must stay. It adopts the node's workloads; it does not merge the old
panel database. Use a whole-panel restore instead when you need the original
subusers, schedules, database explorer records or backup history.

1. If the old panel is available, update it and its agent to a version with
   recovery support, then run **Admin → Nodes → node → Scan for servers** there
   before disconnecting it. This seeds or refreshes the private recovery records
   with the old panel's ownership, blueprint and suspension metadata.
2. Back up the node's full `SERVER_DATA_ROOT`, including `.citadel`, and retain
   `/var/lib/citadel` and its SFTP host key for the stock deployment. Keep the
   existing Docker daemon, data mounts, MariaDB volume and agent configuration.
   Re-registering this machine does not require copying its game files.
3. Prepare owner accounts on the destination before registering the node.
   Matching accounts with different user ids must have verified email addresses.
   Without a valid owner match, recovery assigns the server to the admin who
   runs the scan and reports that choice. The scan writes the resolved owner
   back to the node; creating the account afterward does not undo that assignment.
4. Pause old-panel automation for the affected workloads, settle active work and
   stop or block the old panel's access to this node. For a permanent transfer
   while the old panel will continue serving other nodes, rotate this node's
   bearer token to a new value generated with `openssl rand -base64 48`. Keep
   the old panel's stored token unchanged so it can no longer control the node.
5. Set the node's `PANEL_URL` to the new panel's reachable base URL. When rotating
   its token, update `AGENT_TOKEN` too. Recreate only the existing agent service
   with the matching command above. In a custom launch configuration,
   `NODE_TOKEN` takes precedence over `AGENT_TOKEN`; update the value the process
   actually uses.
6. On the new panel, open **Admin → Nodes → Add node**. Enter the existing node's
   player hostname, reachable Agent URL, browser Console URL, token and capacity.
   Use **Test connection**, then **Register node**. Supply the agent's actual
   token instead of letting the form generate an unrelated one.
7. Registration automatically scans a reachable node. Read the recovery summary
   and skipped-server reasons. If the agent was unreachable or you need to retry,
   open its detail page and use **Recover existing servers → Scan for servers**.
8. Confirm ownership, suspension state, files, resource limits and published
   ports. Recovered servers keep their actual port numbers. Reserve currently
   free ports for future provisioning; the node scan does not restore its old
   port pool, and a range containing ports used by running servers fails the
   pool's host checks.

Recovery adopts intact containers and leaves their current power state alone.
It runs no installer over the files. Complete manifests retain the blueprint
and install recipe. Older containers without manifests may recover only a
runtime blueprint, with no original installer and with the scanning admin as
owner. Conflicting or ambiguous containers are skipped rather than guessed.
See [node-recovery.md](node-recovery.md) for the discovery rules.

### Reconnect the panel records recovery cannot restore

Node recovery cannot restore accounts or passwords, subusers, SFTP credentials,
schedules, plugin management records, audit history, backup snapshot pointers,
server links or individual server database credentials. Set those up again on
the destination. Generate new SFTP credentials from each server's Files tab.

Archived servers have already removed their node files and recovery manifests.
Their identities and S3 snapshot pointers need the panel export or database
backup; scanning the node cannot reconstruct them.

If the shared MariaDB container stays on the node and you have its admin
credential, use **Use an existing database** during node registration. This
connects the new panel to that database service; it does not recover individual
server database records. Preserve its data volume. **Delete and start over**
destroys its contents; changing MariaDB's initialization environment does not
reset credentials already stored there. See [node-database.md](node-database.md).

A running game may retain its existing database or server-link Docker network
connections after adoption. A later container rebuild uses the new panel's
records, so it can lose those connections. Reestablish the relationships before
reinstalling, changing ports or otherwise rebuilding the server.

Do not use **Delete server** on the old panel to detach transferred servers.
That operation removes node data. Keep the old panel isolated from the node;
its old records are not a harmless second control plane.

## Verify before retiring anything

Check the new panel with both an administrator and an ordinary owner account:

- Sign-in and two-factor authentication work, and each server has the intended
  owner and access permissions.
- Each node reports the expected capacity and servers. Open known files and
  compare them with the old installation.
- The browser console connects, a harmless command reaches the game and its
  audit entry appears. Successful node health checks alone do not test
  `PANEL_URL` callbacks.
- SFTP authentication works and the retained node has the expected host-key
  fingerprint.
- Provisioned database access and server links work where their panel records
  were restored or recreated.
- A whole-panel restore lists its existing backups and archived servers and can
  access their S3 repositories. Retain the bucket and repository passwords.

Enable the schedules, backups and idle archiving you paused on the panel that
will remain active. Keep the old panel frontend stopped until you have decided
whether to retain it for rollback.

## Rollback

Before the destination changes resources or metadata, stop its frontend, restore
the old node callback addresses and bearer token where changed, reverse the
panel routing change and start the old frontend again. Only that panel should
control the affected nodes. Keep its original database and boot secrets together.

After the destination changes users, ports, server files, database relationships
or backup snapshots, the old panel database can be stale. Restoring it blindly
can overwrite newer decisions or refer to resources that no longer exist. Take
a current export or PostgreSQL backup from the destination and restore that
state into a fresh database for a move back. Node-only recovery does not make
the destination's panel relationships portable by itself, so review any rebuilt
servers and recreated relationships before returning control to the old panel.
