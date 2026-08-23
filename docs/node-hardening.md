# Node hardening

Everything that keeps a compromised game server from becoming a compromised
*node*. The per-container isolation lives in one pure function
(`apps/backend/src/docker/hardening.ts`, tested by `hardening.test.ts`); this
doc is the why around it, plus the two host-level protections the agent cannot
apply for you (user-namespace remapping and a host firewall rule) and the
residual risks that remain by design.

Related: `docker.md` (the two images, the bind mount), `server-links.md` and
`ports.md` (the networking model this builds on), `backups.md` (the tool
containers, which share the runtime knob), `subusers.md` (who can reach the
file APIs these guards sit under).

## The threat model, stated once

The isolation boundary is **"a tenant cannot attack the panel or another
tenant"**, not "a tenant cannot reach the internet". Outbound HTTPS is left
intact on purpose — plugins and mods fetch from Modrinth/CurseForge/Maven at
runtime, and breaking that breaks normal use (`hardening.ts` top comment).

What we defend against is therefore lateral movement and host takeover from
*inside* a container the tenant controls (they own their data directory; a
malicious plugin runs with the game's privileges), and denial of service
against the node's other tenants.

## What every container already gets

Set unconditionally by `buildHardenedContainerConfig`:

| Control | Field | Stops |
| --- | --- | --- |
| No privileged mode | `Privileged: false` | the all-access escape hatch |
| Drop all capabilities | `CapDrop: ["ALL"]`, `CapAdd: []` | raw sockets, mount, `chown`, module loading |
| No privilege escalation | `SecurityOpt: ["no-new-privileges"]` | setuid binaries regaining what was dropped |
| Non-root run-as | `User` pinned to the data owner | uid-0-in-container being uid 0 on host (see remapping below) |
| Private IPC / UTS / PID / cgroup ns | `IpcMode: "private"`, `CgroupnsMode: "private"`, no `host` sharing | reading host cgroup topology, other tenants' SysV IPC |
| Isolated bridge, ICC off | per-server `NetworkMode` | reaching any other container |
| Hard memory cap, swap off | `Memory == MemorySwap` | one server starving the node of RAM |
| CPU quota | `CpuPeriod`/`CpuQuota` | one server pinning every core |
| PID limit | `PidsLimit: 512` | fork bombs |
| Init process | `Init: true` | zombie PIDs leaking until the PID limit starves the server |
| No core dumps | `Ulimits: [core=0]` | a crash loop writing multi-GB cores into the bind mount |
| OOM bias | `OomScoreAdj: 500` | the kernel killing dockerd/agent/sshd instead of a game under node-wide memory pressure |
| Capped logs | `LogConfig` 10m×3 | a chatty server filling the disk via the journal |

The last four are the node-*stability* additions: they assume the per-tenant
caps hold and defend the node's shared resources (disk, PID space, the OOM
killer's choice) against a tenant who stays within their CPU/memory plan but
behaves badly inside it.

## User-namespace remapping (the big host-level win)

Every control above limits what a container may *do*; none changes *who it is*.
Without remapping, `uid 0` inside a container is `uid 0` on the host, so a
single kernel-level container escape is instant host root. `dockerd`'s
`userns-remap` shifts container uids into an unprivileged subordinate range:
container uid *N* becomes host uid *base + N*, and an escape lands in an
otherwise-unused host account. This is most of what a sandbox runtime buys, at
none of the syscall cost — enable it before reaching for gVisor.

**Enable it on the node** (`/etc/docker/daemon.json`, then restart dockerd):

```json
{ "userns-remap": "default" }
```

Docker creates a `dockremap` user, allocates it a range in `/etc/subuid` and
`/etc/subgid` (e.g. `dockremap:231072:65536`), and stores remapped containers
under `/var/lib/docker/<base>.<base>/`. Enabling it **recreates the container
store** — existing containers vanish and the panel rebuilds each on next start,
which is also when their data directories get re-owned into the new range.

**The agent handles the bookkeeping** (`apps/backend/src/docker/userns.ts`).
Because every host uid it reads or writes is now shifted relative to what the
container sees, the agent:

- detects remapping at boot from the daemon's `SecurityOptions` and derives the
  **effective** offset as `daemon base − agent's own /proc/self/uid_map base`.
  The subtraction is what makes it correct in *both* deployments: a host-side
  (bare-process) agent sees the full shift; an agent that itself runs in a
  remapped container is already shifted the same amount, so its effective offset
  is zero and it treats file uids as container-side. The offset is logged at
  boot.
- owns server data as `offset + 1000` (the canonical `CONTAINER_DATA_UID`, the
  uid every shipped blueprint already pins), and re-owns a directory only when
  it finds a mismatch — steady state is one `stat`, not a walk.
- re-owns every file it writes on the tenant's behalf (editor save, upload,
  `pull-from-url`, SFTP write, rename/copy destinations) to that same owner, so
  the game can read and modify what the panel created. Backup/restic staging is
  re-owned to `offset + 0` instead, because those tool images run as root.
- defaults a user-less blueprint's run-as to the data owner rather than the
  image default (usually root): in-namespace root has no `CAP_DAC_OVERRIDE`
  under `CapDrop: ALL` and could not write its own bind mount.

**Requirements and caveats:**

- **Run the agent as root on a remapped node.** Only root can `chown` into the
  subordinate range and read what containers write there. The agent shouts one
  clear line at boot if it finds remapping on but itself non-root.
- If the daemon's data-root does not carry the `<base>.<base>` suffix (an exotic
  configuration), auto-detection can't find the base; set `USERNS_UID_OFFSET`
  and `USERNS_GID_OFFSET` on the agent to the base from `/etc/subuid`.
- Remapping is node-wide. A node that hosts the shared MariaDB (`node_db_net`)
  or restic containers remaps those too; the agent's root-uid alignment of the
  staging dirs is what keeps them working.

## Alternative OCI runtimes (opt-in)

For a node that hosts genuinely untrusted tenants and will accept a
syscall-performance cost, set `CONTAINER_RUNTIME` on the agent to a runtime
installed on that host — `runsc` (gVisor) or `kata-runtime`. It is threaded
into `HostConfig.Runtime` for both tenant containers and the backup tool
containers (which parse untrusted tenant data), and defaults to unset =
`runc`.

A per-node env var, not a panel setting, because it names a binary on *this*
host and the panel cannot know what a node has installed. The agent validates
the name's shape at boot and checks it against the daemon's registered runtimes,
so a typo is one log line rather than a failed create on every provision.

This is deliberately **not** the default. gVisor's gofer path taxes exactly the
file-heavy chunk I/O a Minecraft world does most, its netstack adds UDP
latency, and some native modpacks hit unimplemented syscalls and break — a
support cost, not a security win. Reach for it only after remapping, and only
for tenants you actually distrust.

## Host firewall: block container → host services

Outbound NAT is intact, which means a container can reach the **host's own IP**
and anything else on the node's LAN — including services bound to `0.0.0.0` on
the host: the agent (`:8081`, whose token is root-equivalent), the SFTP port,
SSH, a database, another node. The per-server bridge stops container↔container;
it does not stop container→host-network.

Close it with a `DOCKER-USER` rule on the node (Docker consults this chain
before its own, so it survives daemon restarts):

```bash
# Drop traffic from container bridges to the host and RFC-1918 space,
# while leaving container→internet intact. Adjust the bridge match to
# your setup (br-* are Docker's per-network bridges).
iptables -I DOCKER-USER -i br+ -d 10.0.0.0/8     -j DROP
iptables -I DOCKER-USER -i br+ -d 172.16.0.0/12  -j DROP
iptables -I DOCKER-USER -i br+ -d 192.168.0.0/16 -j DROP
iptables -I DOCKER-USER -i br+ -d 169.254.0.0/16 -j DROP   # link-local / cloud metadata
```

The metadata rule matters on cloud nodes: `169.254.169.254` hands out instance
credentials, and it is the classic SSRF-to-takeover pivot. The agent's own
`pull-from-url` guard blocks that address panel-side and again at the fetch
(`apps/backend/src/ssrf.ts`), but a rule here also covers a plugin making the
request directly, which the agent never sees.

## Residual risks (known, accepted, or mitigated elsewhere)

- **`node_db_net` has ICC on.** It must, so a server can reach the shared
  MariaDB. But two servers that *both* have a provisioned database sit on that
  bridge together with ICC enabled, so one could reach the other's game port
  directly — the per-server isolation network does not cover this path.
  Cross-tenant *database* access is still blocked by MariaDB's per-database user
  grants (`docs/database-explorer.md`); cross-tenant *network* reachability on
  this one bridge is the accepted gap. A node that needs it closed should run
  the DB tenants under an L3-filtered network policy or give MariaDB a
  per-server network fan-out.
- **No per-container disk quota.** The memory/CPU/PID caps have no disk
  equivalent — a server can fill `SERVER_DATA_ROOT` and starve its neighbours.
  Core dumps and logs are capped (above), but the game's own writes are not.
  Mitigate at the host: put `SERVER_DATA_ROOT` on its own filesystem/mount, or
  enable XFS project quotas per server directory. Tracked as future work; the
  panel already reads per-server disk usage (`servers.ts`) for the meter, which
  is the input a quota enforcer would need.
- **TOCTOU on writes.** `resolveWritableServerPath` closes the practical
  symlink-escape vector (a link planted *ahead* of an owner-triggered write),
  but a container racing a link into place between the check and the write has
  the same narrow window every non-`openat(O_NOFOLLOW)` path does. Bun does not
  expose per-component `openat`; the window stays documented in `paths.ts`.
- **The agent token is root-equivalent.** Nothing here changes that: a leaked
  `AGENT_TOKEN` owns the node. It is timing-safe-compared, per-node, and
  ≥32 chars by boot validation (`config.ts`), and the DOCKER-USER rule above
  keeps a tenant from reaching the port it authenticates.
