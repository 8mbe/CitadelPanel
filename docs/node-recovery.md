# Node server recovery

A node keeps enough information to identify its servers after the panel loses
its metadata. Adding a reachable node inventories its existing Citadel servers
before the operator creates new ones. The panel can adopt an intact container
and its files without running an install script over the existing world.

Related: [server-lifecycle.md](server-lifecycle.md) explains container rebuilds,
[ports.md](ports.md) explains port identity and allocation, and
[node-hardening.md](node-hardening.md) explains the tenant containment boundary.
Panel export/import is described in [panel-export.md](panel-export.md).

## The agent remembers identity, the panel still owns it

The agent has no users, sessions or SQL database. It now writes a small recovery
manifest for each runtime server. That manifest records the full server UUID,
the runtime spec and the panel-supplied recovery metadata: name, owner identity
and email, blueprint definition, disk limit, published-port roles, secret env
keys and administrative status.

The full blueprint matters for an operator's custom blueprint, which may exist
only in the panel that was lost. The owner email gives a replacement panel a
way to match an existing account when the original user ID no longer exists.
Neither piece grants access on the agent. It remains the panel's job to validate
the blueprint, resolve an owner and insert permission-protected records.

The administrative status is separate from Docker's observed state. In
particular, an exited container cannot tell whether the panel suspended the
server. Recovery must retain that decision rather than return a suspended
server to ordinary owner power controls.

## The record lives outside tenant files

Manifests live in `SERVER_DATA_ROOT/.citadel/<server-uuid>.json`, while the
game container mounts only `SERVER_DATA_ROOT/<server-uuid>`. The `.citadel`
directory is owned by the agent with permissions `0700`; files are `0600`.
The file manager and SFTP resolve through a validated UUID and cannot reach
this sibling directory. Copying a game world through a file transfer does not
copy its ownership metadata.

Runtime environment values already have to reach Docker in plaintext. They
also appear in this private recovery record, so losing the panel's encryption
key does not make the existing game unrecoverable. The record contains no node
bearer token or panel credential. The panel must treat the values as secrets
again when it stores recovered env rows, using its current encryption key.

The agent refuses symlinked metadata directories and reads manifest files with
`O_NOFOLLOW`. It writes to a new private temporary file, syncs the file, renames
it over the previous record and syncs the directory. A restart during an update
therefore leaves a complete old or new manifest. A corrupt record produces an
inventory warning and does not hide healthy records beside it.

## The lifecycle ordering

The runtime create path writes its manifest before calling Docker. If Docker
creates a container and the connection dies before the panel records its ID,
the node still remembers what that container belongs to. A failed create can
leave a manifest with no container. Discovery reports `missing` and whether the
data directory exists; the panel decides whether the record can be adopted.

Rebuilding a container retains its manifest when `deleteData=false` and replaces
its runtime spec when the replacement is created. A destructive delete removes
the record only after the data directory has been removed. Keeping files keeps
their recovery identity. Archive cleanup and successful migration cleanup use
the destructive path, so old source records cannot be rediscovered as live
servers after the data has gone.

`PUT /v1/servers/:id/recovery` lets the panel refresh ownership and administrative
state without replacing the container. It also seeds old containers that were
created before manifests existed. A supplied runtime spec replaces the stored
one; otherwise the agent retains its existing spec or inspects the legacy
container.

## Discovering older containers

`GET /v1/servers/discovery` combines manifests with a Docker inventory. It is
authenticated with the existing node bearer token and performs no power action.
The result includes the server UUID, current container ID and state, runtime
spec, recovery metadata when present and whether real server data exists.
The panel receives no host path.

When a container is present, its image, data mount, limits, explicit command,
environment and published ports must agree with the remembered runtime spec.
A manually changed or unreadable container produces a warning and is excluded
from adoption. The agent does not present its stale manifest as a missing
container and thereby conceal the conflict.

The initial Docker list also observes renamed or unlabelled containers that
occupy a remembered server's name, UUID label or data bind. Those workloads
block adoption of the stale manifest even though they do not qualify for
recovery themselves. Otherwise a rename could make the panel believe the world
has no container and rebuild a second workload over files already in use.

New runtime containers carry `citadel.server-id` and `citadel.kind=server` in
addition to the existing managed label. Older names contain only the first
twelve characters of the UUID, so names alone cannot recover an identity. The
legacy fallback requires a managed container with the exact runtime name and a
bind source that is a direct UUID-named child of this node's configured data
root. An explicit UUID label must agree with that bind source.

Install containers, backup tools, node database containers and unrelated Docker
workloads are excluded. Extra host binds, ambiguous identities, unsupported
port mappings and unlimited resource caps are also excluded. The agent does
not manufacture an owner or a blueprint from an image name. Legacy discovery
returns the runtime facts, and the panel can recover only what those facts and
its remaining metadata support.

The discovery does not follow a symlinked per-server data root. Host paths and
mounts are therefore not a way to turn an unrelated directory into a recovered
tenant server. Existing container environment variables retain values with
embedded `=` characters, and commands retain their argument array so recovery
does not silently change a launch command.

## How the panel adopts a server

Registration scans a reachable node automatically. The node detail page also
has **Scan for servers**, which calls the admin-only
`POST /api/admin/nodes/:id/recover` endpoint. Use it after reconnecting an agent,
upgrading an older agent or restoring accounts to the panel. A failed inventory
does not undo node registration. The response says what was found, what was
restored, what already existed and why individual servers were skipped.

The saved owner ID belongs to the old panel, so the owner email also travels
with the record. The replacement panel resolves that identity against its own
accounts. An exact original ID must also match the saved email. Matching a
different account by email requires a verified address, because otherwise a
new account could claim the former owner's email without proving ownership.
When neither match establishes the former owner, recovery assigns the server
to the admin who ran the scan and reports that assignment. It never
creates an account or invents a password from node metadata. After adoption,
the node receives the resolved ownership for future recovery.

A server already registered on this node keeps its existing panel records.
The scan refreshes the node's recovery metadata from those authoritative rows.
If that UUID belongs to another registered node, the scan refuses to adopt it.
Discovery cannot perform a migration or override a completed migration's
cutover just because source files were left behind.

Each new server is restored in its own database transaction. The server row,
blueprint when needed, port assignments and encrypted environment values commit
together. An advisory lock on the UUID serializes concurrent scans of the same
identity. A conflict with an existing port assignment rolls back that server,
and recovery continues with the others. Ports keep their actual numbers; the
scan never allocates replacement ports. A legacy container must already publish
each identity-mapped port on both TCP and UDP to fit this panel's port model.

The saved blueprint can be absent from a replacement panel or share a key with
a different definition. Recovery restores a missing definition. When the key
already names a different functional definition, recovery keeps the saved one
under `recovered-<server-uuid>` rather than change the existing panel blueprint.
The key also includes a signature of the saved functional definition, so
different recovered definitions cannot reuse each other's record. The database
conflict handler verifies the functional fields again before returning a
blueprint ID. A concurrent conflicting definition therefore skips that server
rather than let a stale registry cache choose a different install recipe.
The server retains its original runtime and install recipe.

An older container with no saved blueprint gets a definition assembled from its
runtime image, data mount, command, limits and published ports. This definition
has no install step, because Docker cannot reveal the script that originally
populated the world. The panel marks every discovered environment value secret,
since Docker cannot reveal which fields the old panel intended to hide. A
runtime-only recovery also assigns the server to the scanning admin and says
so in the result.

Adoption runs no install script. It inserts records around files that already
exist, and leaves the container's current power state alone. Suspension is
retained separately from that state, including the saved reason.

## Limits of node recovery

The manifest is a server recovery record, not a replacement for a panel export.
It cannot reconstruct subusers, schedules, audit history, backup snapshots,
links or a provisioned database's panel-side credentials. Files containing a
game's own connection details survive with the world, but that is different
from recreating the panel's database explorer access. A complete panel export
preserves the control-plane relationships that node discovery cannot infer.

An existing container may still be attached to its node database bridge or a
pairwise server-link network, so its game can keep using those connections
immediately after adoption. A later container rebuild attaches networks from
the panel's database and link records. Node recovery alone cannot recreate
those records, so a rebuild can lose those connections. Import the complete
panel export or reestablish the missing relationships before reinstalling,
changing ports or otherwise rebuilding such a server.

Discovery also leaves running servers running. Adopting a server changes the
panel's records, not the workload on the node. An unreachable node can be
registered, but its inventory remains unavailable until the agent responds.
