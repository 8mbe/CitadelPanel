/**
 * Container hardening options applied to EVERY game-server container
 * (plan.md section 8).
 *
 * Design intent, restated because it is easy to get wrong later:
 *
 *   The isolation boundary is "cannot attack the panel or other tenants",
 *   NOT "cannot reach the internet".
 *
 * Outbound internet access is deliberately LEFT INTACT, because Minecraft
 * plugins and mods routinely need outbound HTTPS (version checks, Modrinth /
 * CurseForge / Spigot API calls, dependency downloads). Blocking it would break
 * normal, legitimate use. What we do block is lateral movement: each server
 * lives on its own bridge network and can reach neither the control-plane nor
 * another tenant's container.
 *
 * Everything here is pure: it computes a dockerode container spec from inputs
 * and touches no I/O, which makes it directly unit-testable.
 */

import type Docker from "dockerode";

/** A port the game needs published on the host. */
export interface PortBinding {
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
}

export interface HardenedContainerSpec {
  /** Container name; also used to derive the per-server network name. */
  name: string;
  image: string;
  /** Absolute path on the NODE's disk, bind-mounted as the server data dir. */
  hostDataPath: string;
  /** Mount point inside the container. */
  containerDataPath: string;
  env: Record<string, string>;
  ports: PortBinding[];
  cpuLimit: number;
  memoryLimitMb: number;
  /** Per-server isolated bridge network to attach to. */
  networkName: string;
  /**
   * Optional override of the image's ENTRYPOINT. Used by the install step to
   * run a provisioning script (`["/bin/sh", "-c"]` + the script as `command`)
   * regardless of what entrypoint the installer image ships with.
   */
  entrypoint?: string[];
  /** Optional override of the image's default command. */
  command?: string[];
  /**
   * Optional `uid` or `uid:gid` to run the container as (Docker `--user`).
   *
   * Images that drop privileges internally — e.g. itzg/minecraft-server runs as
   * root then `gosu`s to `minecraft` and `chown`s `/data` — cannot do that under
   * this layer's `CapDrop: ALL` + `no-new-privileges`, because `setuid`/`chown`
   * need capabilities we deliberately drop. Pinning the run-as user to the one
   * that owns the data directory lets such an image run non-root with no
   * capability escalation, which is strictly safer than the image's own drop.
   */
  user?: string;
  /**
   * Whether the image tolerates a read-only root filesystem. Off by default
   * because many game images write outside the data dir at startup; enabling it
   * per-preset is a hardening win where supported.
   */
  readOnlyRootFilesystem?: boolean;

  /**
   * Allocate a pseudo-TTY for the container's primary process.
   *
   * Some server software (notably itzg/minecraft-server via JLine3) only emits
   * ANSI color when stdout is a TTY; without one it strips all color, leaving
   * the panel's ANSI console renderer with nothing to render. A TTY also
   * changes the attach stream from Docker's 8-byte multiplexed framing to a raw
   * byte stream (stdout and stderr merged), which the attach layer detects
   * per-container. Off by default — most servers don't need it and non-TTY
   * keeps stdout/stderr cleanly separated.
   */
  tty?: boolean;

  /**
   * Additional networks to attach the container to after creation, beyond its
   * primary isolated `networkName`. Used for `node_db_net` — a server whose
   * owner has provisioned a database must reach the shared MariaDB, so the
   * panel passes that network name here and the agent attaches it post-create.
   */
  extraNetworks?: string[];
}

/** Bytes per megabyte, for Docker's byte-denominated memory limits. */
const MB = 1024 * 1024;

/** Docker expresses fractional CPUs as a quota over a 100ms period. */
const CPU_PERIOD = 100_000;

/**
 * Guard against a caller passing values that would weaken isolation or let a
 * tenant escape its resource plan. These are invariants, not user-facing
 * validation, so they throw rather than returning a result object.
 */
function assertSpecIsSane(spec: HardenedContainerSpec): void {
  if (spec.cpuLimit <= 0) {
    throw new Error("cpuLimit must be greater than 0 — unlimited CPU is not allowed");
  }
  if (spec.memoryLimitMb <= 0) {
    throw new Error(
      "memoryLimitMb must be greater than 0 — unlimited memory is not allowed",
    );
  }
  if (!spec.networkName) {
    throw new Error(
      "networkName is required — a container must never fall back to the default bridge",
    );
  }
  for (const port of spec.ports) {
    if (port.hostPort < 1024 || port.hostPort > 65535) {
      throw new Error(
        `Invalid host port ${port.hostPort}: must be in the unprivileged range 1024-65535`,
      );
    }
  }
}

/**
 * Build the fully-hardened dockerode container creation options.
 *
 * Any change to this function changes the security posture of every hosted
 * server, so it is covered by `hardening.test.ts`.
 */
export function buildHardenedContainerConfig(
  spec: HardenedContainerSpec,
): Docker.ContainerCreateOptions {
  assertSpecIsSane(spec);

  const exposedPorts: Record<string, {}> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};

  for (const port of spec.ports) {
    const key = `${port.containerPort}/${port.protocol}`;
    exposedPorts[key] = {};
    // Only the game's required ports are published inbound; nothing else.
    portBindings[key] = [{ HostPort: String(port.hostPort) }];
  }

  return {
    name: spec.name,
    Image: spec.image,
    ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
    ...(spec.command ? { Cmd: spec.command } : {}),
    ...(spec.user ? { User: spec.user } : {}),
    Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
    ExposedPorts: exposedPorts,
    WorkingDir: spec.containerDataPath,

    // Keep stdin open and attachable so the console can send commands to the
    // running game server ("op someone", "save-all", "stop"). Without this the
    // console is read-only, and `attach` has nothing to write to.
    //
    // No TTY: a pty would make the server emit escape sequences and echo input
    // back, which is wrong for a log stream. Non-TTY also keeps stdout and
    // stderr separately framed, which is what `stripDockerLogHeaders` expects.
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,

    // Labels let the watcher and cleanup routines identify panel-managed
    // containers without keeping a separate index.
    Labels: {
      "citadel.managed": "true",
      "citadel.container-name": spec.name,
    },

    HostConfig: {
      // --- Resource caps (bounds the blast radius of an undetected miner) ---
      Memory: spec.memoryLimitMb * MB,
      // Equal to Memory => swap is disabled, so the memory cap is a hard cap
      // rather than something a workload can spill past onto disk.
      MemorySwap: spec.memoryLimitMb * MB,
      CpuPeriod: CPU_PERIOD,
      CpuQuota: Math.round(spec.cpuLimit * CPU_PERIOD),
      PidsLimit: 512, // blunt fork bombs

      // --- Privilege reduction ---
      Privileged: false,
      // Drop every capability. Game servers are ordinary userspace processes
      // and need none of them; add back explicitly if a preset ever requires it.
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges"],

      // --- Host namespace separation ---
      // Never share the host's PID, IPC, UTS or network namespaces.
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      UsernsMode: "",

      // --- Networking: isolated per-server bridge, outbound NAT intact ---
      NetworkMode: spec.networkName,
      PortBindings: portBindings,
      // Do not let Docker pick arbitrary host ports for unlisted EXPOSEd ports.
      PublishAllPorts: false,

      // --- Filesystem ---
      ReadonlyRootfs: spec.readOnlyRootFilesystem === true,
      Binds: [`${spec.hostDataPath}:${spec.containerDataPath}:rw`],
      // A writable /tmp is still needed when the rootfs is read-only; keep it
      // small, noexec and nosuid so it cannot be used to stage a binary.
      Tmpfs: spec.readOnlyRootFilesystem
        ? { "/tmp": "rw,noexec,nosuid,size=64m" }
        : undefined,

      // --- Lifecycle ---
      // "unless-stopped" would fight the panel's own state machine; restarts are
      // driven explicitly so that a suspended server stays suspended.
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },

      // Cap log growth so a chatty or malicious server cannot fill the node disk.
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      },
    },
  };
}

/**
 * Options for the per-server bridge network.
 *
 * `enable_icc=false` is what prevents two containers that end up on the same
 * network from reaching each other. For a single-server network it is belt and
 * braces; for the shared `node_db_net` it is load-bearing (plan.md 7.1.1).
 */
export function buildIsolatedNetworkConfig(networkName: string) {
  return {
    Name: networkName,
    Driver: "bridge",
    CheckDuplicate: true,
    Internal: false, // outbound NAT must keep working for plugin/mod downloads
    Options: {
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.enable_ip_masquerade": "true",
    },
    Labels: { "citadel.managed": "true" },
  };
}

/** Deterministic per-server network name, derived from the server id. */
export function serverNetworkName(serverId: string): string {
  return `citadel_srv_${serverId.slice(0, 12)}`;
}

/** Deterministic per-server container name. */
export function serverContainerName(serverId: string): string {
  return `citadel-${serverId.slice(0, 12)}`;
}

/**
 * Deterministic name for a server's one-time install container.
 *
 * Distinct from the runtime container name so the two never collide while the
 * install step runs against the same data volume; it is removed as soon as the
 * script exits.
 */
export function serverInstallContainerName(serverId: string): string {
  return `citadel-install-${serverId.slice(0, 12)}`;
}
