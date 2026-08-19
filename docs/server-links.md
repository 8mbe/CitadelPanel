# Server links

How a server connects to another of the owner's servers — the "Connect servers"
button in the Settings tab. Covers the pairwise link model, why the address is
a stable name and never an IP, and how links survive container recreation.

## The flow

A link is an explicit, owner-initiated connection between exactly two servers —
what a proxy (Velocity/BungeeCord) needs to reach its backends, or a plugin to
reach another server. The built-in Velocity blueprint is the worked example:
`velocity-proxy.md` covers the other half, turning a link's address into a
`servers` entry the proxy will use. The Settings tab's "Connected servers" card lists the
links and shows a copyable address for each; the "Connect servers" dialog picks
one of the caller's other servers and the published port to use.

Panel routes (all under `routes/servers.ts`, registered in the dispatcher):

- `GET /api/servers/:id/links` — gated by the `settings` permission (same
  reads-gate-with-writes rule as ports; the addresses reveal host ports).
- `POST /api/servers/:id/links` `{ targetId }` and
  `DELETE /api/servers/:id/links/:linkId` — **owner-or-admin of both
  servers**. A link attaches the target's container to a shared network, so a
  subuser with `settings` on one side must not be able to reach into a server
  they only partially control. Links are audited as `server.link.add` /
  `server.link.remove`.

Links are stored in `server_links` (`server_id`, `target_id`, `UNIQUE` per
ordered pair, `CHECK (server_id <> target_id)`). The row is directional but
the connectivity is not: the service rejects a link when the reverse row
exists (one pair, one row, one network), and `listServerLinks` returns both
directions because someone else's link *to* this server is just as much a
connection of this server's.

## The address: names, not IPs

Container IPs are **not stable** — Docker assigns them per container instance,
and the panel recreates containers routinely (env edits, port changes,
resource updates). Storing or displaying an IP would silently rot. So:

- **Same node → internal**: both containers are attached to their pairwise
  network (below), and the address is the peer's container name
  `citadel-<id12>:<port>`. Docker's embedded DNS resolves container names on
  user-defined networks, and the name derives from the server id — it survives
  every recreate. The port is the peer's published port, which is
  identity-mapped (`ports.md`), so the same number works on both sides of the
  network.
- **Different node → external**: the two nodes share no Docker daemon, so
  there is no bridge to build. The address is the peer node's public hostname
  plus port (`nodes.hostname`, the player-facing address) and the traffic
  crosses the network like any client. No agent call is made for cross-node
  links — they are a recorded address, not a network.

(Swarm-style overlay networks were considered for cross-node and rejected:
they couple independently-administered nodes into one cluster trust domain,
and only hide an address that `hostname:port` already provides.)

## The network: one per pair, never shared

Each server container lives on its own bridge with ICC disabled — "can reach
neither the control-plane nor another tenant's container"
(`apps/backend/src/docker/hardening.ts`). A link is the one sanctioned
exception, and it stays minimal:

- One network per linked pair: `citadel_link_<min(idA,idB)>_<max(...)>` — the
  id prefixes are sorted, so however the row is ordered, a pair resolves to
  one network. The name helper exists on both sides (`hardening.ts` on the
  agent, `services/serverLinks.ts` on the panel, which needs it for
  re-attaches) and must stay in sync.
- The network is created with **ICC enabled** — that is the feature. It holds
  exactly the two linked containers, so a compromised server can only ever
  reach servers its owner explicitly linked it to, never a third tenant.

Agent routes (`apps/backend/src/server.ts`): `POST /v1/servers/:id/links`
`{ targetId }` creates the network and attaches both containers (idempotent);
`DELETE /v1/servers/:id/links/:targetId` detaches both and removes the
now-empty network (idempotent; "still has endpoints" is not an error).

## Survival across recreates

Recreating a container drops its network attachments. The panel therefore
passes every link network of a server through `extraNetworks` at create time
(`extraNetworksForServer` in `services/serverManager.ts`, next to
`node_db_net`), and the agent re-attaches them post-create. This is the only
recreate handling links need — no recreate is triggered to create a link.

Removal is **fail-closed**: the agent detaches first, then the row is deleted.
An unreachable node fails the request with a 502 and the link stays active —
never a deleted row with a still-attached network. Creation rolls back the
other way (delete the row if the agent refuses) so a link always has its
network.

Deleting a server detaches all its links first (`detachAllServerLinks`) while
both containers still exist; the rows then cascade away with the server
record.
