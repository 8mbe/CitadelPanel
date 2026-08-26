/**
 * Lifecycle of this node's shared MariaDB container.
 *
 * `database.ts` is the *use* of the node database (create a per-server database,
 * run explorer SQL). This module is its *existence*: create the network, the
 * data volume and the container, start it, stop it, report its state. The panel
 * drives all four from the node's admin page, which is why this exists at all:
 * the agent already holds the Docker socket, so a node database is one API call
 * away, and asking an operator to SSH in and run a script was the only reason
 * it ever looked like a manual step.
 *
 * `scripts/setup-node-db.ts` is a thin CLI over the same functions, so the
 * button and the script cannot drift apart.
 *
 * Two properties are deliberate and load-bearing:
 *
 * 1. **No published host ports.** MariaDB is reachable only from containers on
 *    `node_db_net`, never from the host's network or the internet. Nothing here
 *    may add a `PortBindings` entry.
 * 2. **ICC enabled on `node_db_net`.** Tenant isolation comes from MariaDB's
 *    per-database user grants (see `provisionServerDatabase`), not from the
 *    bridge. With ICC off, no game server could reach the database at all; see
 *    {@link ensureNodeDbNetwork} for the bug that taught us this.
 */

import type Docker from "dockerode";
import { randomBytes } from "node:crypto";
import { docker } from "./client";
import { ensureImage, ensureNetwork, removeNetwork } from "./container";
import { execInContainer } from "./exec";
import { config } from "../config";
import { badRequest, conflict, notFound } from "../http";

/** The standard MariaDB/MySQL port. Not published on the host. */
export const NODE_DB_PORT = 3306;

/** MariaDB's data directory inside the container; the volume's mount point. */
const DATA_DIR = "/var/lib/mysql";

/**
 * How long to wait for MariaDB to answer a ping.
 *
 * First boot runs the whole initialisation (system tables, root user), which is
 * comfortably the slowest case at 10-30s on a busy node. A restart of an
 * initialised volume is a few seconds. The panel's HTTP timeout for setup is
 * wider than this on purpose, so the timeout the operator hits is this one, with
 * its own message, rather than a bare fetch abort.
 */
const READY_TIMEOUT_MS = 120_000;

/** Docker returns 404 for "no such container/volume". */
function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number } | null)?.statusCode === 404;
}

/**
 * Generate the MariaDB root password.
 *
 * Alphanumeric only: this value is passed to the `mariadb` client through
 * `MYSQL_PWD` and interpolated into no SQL, but keeping it free of shell- and
 * SQL-hostile characters removes a whole class of quoting surprise from every
 * future call site. 32 chars of this alphabet is ~190 bits.
 *
 * Normally the *panel* generates the password (it has to store it encrypted
 * either way, so it owns the secret) and passes it in. This exists for the CLI
 * script, which has no panel behind it.
 */
export function generateRootPassword(length = 32): string {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/**
 * The bridge `node_db_net` is created with.
 *
 * ICC **on**, for the reason in the module header. Outbound NAT stays on to
 * match the posture of every other managed network (MariaDB does not need it,
 * but a network that behaves differently from its siblings is a trap).
 */
export function nodeDbNetworkConfig(networkName: string): Docker.NetworkCreateOptions {
  return {
    Name: networkName,
    Driver: "bridge",
    CheckDuplicate: true,
    Internal: false,
    Options: {
      "com.docker.network.bridge.enable_icc": "true",
      "com.docker.network.bridge.enable_ip_masquerade": "true",
    },
    Labels: { "citadel.managed": "true", "citadel.role": "node-db" },
  } as Docker.NetworkCreateOptions;
}

/**
 * The container spec for the node database.
 *
 * Pure, so the two properties that matter can be unit-tested without a daemon:
 * no host port bindings, and the data directory on a named volume.
 *
 * The volume is why the container is disposable. Without it MariaDB's data would
 * live in the container's writable layer, and every `docker rm` (an image bump,
 * a botched setup, a manual cleanup) would silently destroy every tenant's
 * database. With it, removing and recreating the container is a restart.
 *
 * `RestartPolicy: unless-stopped` is the opposite of the game containers' `no`
 * (see `hardening.ts`). Their state machine lives in the panel and a container
 * that came back on its own would fight it. The node database has no such
 * state: it should be up whenever the node is, and an admin who stopped it from
 * the panel wants it to stay stopped across a reboot, which is exactly what
 * `unless-stopped` means.
 */
export function nodeDbContainerConfig(spec: {
  containerName: string;
  image: string;
  networkName: string;
  volumeName: string;
  rootPassword: string;
}): Docker.ContainerCreateOptions {
  return {
    name: spec.containerName,
    Image: spec.image,
    // The one env var MariaDB requires to initialise. The image creates
    // root@'%' with GRANT ALL ON *.*, which is what per-server provisioning
    // needs later.
    Env: [`MARIADB_ROOT_PASSWORD=${spec.rootPassword}`],
    Labels: { "citadel.managed": "true", "citadel.role": "node-db" },
    HostConfig: {
      // Attach to node_db_net only: not the default bridge, and no host ports.
      NetworkMode: spec.networkName,
      Binds: [`${spec.volumeName}:${DATA_DIR}`],
      RestartPolicy: { Name: "unless-stopped" },
      PublishAllPorts: false,
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      },
    },
  };
}

/**
 * Create `node_db_net`, repairing a legacy one that cannot work.
 *
 * Early versions of the setup script created this bridge with
 * `enable_icc=false`, on the mistaken belief that it isolated tenants while
 * still allowing database access. It does not: ICC=false drops all
 * inter-container traffic on the bridge, so a game server attached to it can
 * never reach MariaDB and the TCP connect just times out. Isolation comes from
 * MariaDB's per-database grants (see `provisionServerDatabase`), never from
 * here.
 *
 * A network is only metadata, so when nothing is attached we recreate it rather
 * than handing the operator a shell command: the whole point of the setup button
 * is that a node with a legacy network ends up working, not informed. With
 * containers still attached, recreating would silently detach them, so that case
 * is refused with the instructions instead.
 */
export async function ensureNodeDbNetwork(): Promise<void> {
  const networkName = config.nodeDbNetwork;

  let existing: Docker.NetworkInspectInfo | null = null;
  try {
    existing = await docker.getNetwork(networkName).inspect();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (existing?.Options?.["com.docker.network.bridge.enable_icc"] === "false") {
    const attached = Object.keys(existing.Containers ?? {}).length;
    if (attached > 0) {
      throw conflict(iccDisabledMessage(networkName, attached));
    }
    await removeNetwork(docker, networkName);
  }

  await ensureNetwork(docker, networkName, nodeDbNetworkConfig(networkName));
}

/**
 * Reject a `node_db_net` that has ICC disabled, at use time.
 *
 * {@link ensureNodeDbNetwork} repairs this during setup; this is the guard on
 * every later operation, for a network an operator recreated by hand. Shared
 * with `database.ts` so the diagnosis is written once.
 */
export async function assertNodeDbNetworkAllowsIcc(networkName: string): Promise<void> {
  let net: Docker.NetworkInspectInfo | null = null;
  try {
    net = await docker.getNetwork(networkName).inspect();
  } catch {
    // Network missing entirely; the caller's "no container" message covers it.
    return;
  }
  if (net.Options?.["com.docker.network.bridge.enable_icc"] === "false") {
    throw conflict(
      iccDisabledMessage(networkName, Object.keys(net.Containers ?? {}).length),
    );
  }
}

/** The one explanation of an ICC-disabled node DB network, and the way out. */
function iccDisabledMessage(networkName: string, attached: number): string {
  return (
    `The "${networkName}" Docker network has inter-container communication ` +
    `disabled (enable_icc=false), which blocks server containers from reaching ` +
    `the database, and ${attached} container${attached === 1 ? " is" : "s are"} ` +
    `still attached to it. Stop those containers, then recreate the network: ` +
    `"docker network rm ${networkName} && docker network create --driver bridge ` +
    `-o com.docker.network.bridge.enable_icc=true ${networkName}". Tenant ` +
    `isolation is enforced by MariaDB user grants, not the network.`
  );
}

/**
 * Find the node DB container, whatever its state.
 *
 * Shared with `database.ts` so "which container is the node database" is
 * decided once. Name filters are substring matches in Docker, hence the exact
 * `/name` comparison.
 */
export async function findNodeDbContainer(): Promise<Docker.ContainerInfo | null> {
  const containerName = config.nodeDbContainer;
  const matches = await docker.listContainers({
    all: true,
    filters: { name: [containerName] },
  });
  return (
    matches.find((c) => (c.Names ?? []).some((n) => n === `/${containerName}`)) ??
    null
  );
}

/** What the panel shows on the node's database card. */
export interface NodeDbStatus {
  /** False when the container does not exist: the "Set up" case. */
  exists: boolean;
  /** Docker's status string ("running", "exited", …), or null when absent. */
  state: string | null;
  /** True once MariaDB answers a ping, so "running" means "usable". */
  ready: boolean;
  /** The container's IP on `node_db_net`; null when absent or detached. */
  host: string | null;
  port: number;
  containerName: string;
  networkName: string;
  volumeName: string;
  /** The image the container actually runs, or the configured default. */
  image: string;
}

/**
 * Report the container's state and address.
 *
 * `ready` is only probed when the container is running and a password was
 * supplied, because a ping costs an exec (~50ms) and the answer is meaningless
 * for a stopped container. The panel passes the stored admin password, so the
 * status card can distinguish "running" from "running and accepting
 * connections", which is the difference between a working node and one whose
 * first boot is still initialising.
 */
export async function getNodeDbStatus(rootPassword?: string): Promise<NodeDbStatus> {
  const info = await findNodeDbContainer();
  const base = {
    containerName: config.nodeDbContainer,
    networkName: config.nodeDbNetwork,
    volumeName: config.nodeDbVolume,
    port: NODE_DB_PORT,
  };

  if (!info) {
    return {
      ...base,
      exists: false,
      state: null,
      ready: false,
      host: null,
      image: config.nodeDbImage,
    };
  }

  const running = info.State === "running";
  const ready =
    running && rootPassword ? await pingSucceeds(info.Id, rootPassword) : false;

  return {
    ...base,
    exists: true,
    state: info.State ?? null,
    ready,
    // Docker reports an empty string, not a missing field, for a stopped
    // container's IP. `|| null` collapses both into "no address".
    host: info.NetworkSettings?.Networks?.[base.networkName]?.IPAddress || null,
    image: info.Image ?? config.nodeDbImage,
  };
}

/**
 * Create the network, volume and container, and wait until MariaDB answers.
 *
 * Idempotent by design, because the operation it wraps is slow enough to time
 * out on a first-boot image pull: a retry with the *same* password finds the
 * existing container, verifies the password against it, and returns the same
 * answer. That matters because the panel stores the password before calling
 * here (it generated it), so a retry that recreated the container with a fresh
 * password would strand every database on the old one.
 *
 * A container that exists but rejects the password is a 409, not a silent
 * recreate. It means either a previous panel install owns this node's database
 * or the operator ran the script by hand; both are recoverable by hand, and
 * neither is worth destroying data over.
 */
export async function setUpNodeDb(rootPassword: string): Promise<NodeDbStatus> {
  if (rootPassword.length < 16) {
    throw badRequest('"rootPassword" must be at least 16 characters.');
  }

  const networkName = config.nodeDbNetwork;
  const containerName = config.nodeDbContainer;

  await ensureNodeDbNetwork();

  const existing = await findNodeDbContainer();
  if (existing) {
    // Start it before probing: a stopped container cannot answer, and "setup"
    // on an existing-but-stopped database should leave it usable.
    if (existing.State !== "running") {
      await docker.getContainer(existing.Id).start();
    }
    await waitUntilReady(existing.Id, rootPassword, {
      // An already-initialised volume comes back in seconds. If it does not, the
      // likely cause is a wrong password, and the message below says so.
      onTimeout: () =>
        conflict(
          `The container "${containerName}" already exists on this node but did ` +
            `not accept the panel's stored credentials. It was probably created ` +
            `by another panel install or by hand. Either register this node with ` +
            `that database's credentials, or remove the container ` +
            `("docker rm -f ${containerName}") and set it up again. Its data ` +
            `volume "${config.nodeDbVolume}" is kept either way.`,
        ),
    });
    return getNodeDbStatus(rootPassword);
  }

  await ensureVolume(config.nodeDbVolume);
  await ensureImage(docker, config.nodeDbImage);

  const container = await docker.createContainer(
    nodeDbContainerConfig({
      containerName,
      image: config.nodeDbImage,
      networkName,
      volumeName: config.nodeDbVolume,
      rootPassword,
    }),
  );
  await container.start();
  await waitUntilReady(container.id, rootPassword);

  return getNodeDbStatus(rootPassword);
}

/**
 * Start the node database and wait until it accepts connections.
 *
 * "Started" is reported only once MariaDB answers a ping, so the admin who
 * clicked Start does not get a green badge over a database that is still
 * replaying its redo log. Already running is success, not a conflict.
 */
export async function startNodeDb(rootPassword?: string): Promise<NodeDbStatus> {
  const info = await requireNodeDbContainer();

  if (info.State !== "running") {
    try {
      await docker.getContainer(info.Id).start();
    } catch (error) {
      // 304 = already started, which a concurrent request can produce.
      if ((error as { statusCode?: number }).statusCode !== 304) throw error;
    }
  }

  if (rootPassword) await waitUntilReady(info.Id, rootPassword);
  return getNodeDbStatus(rootPassword);
}

/**
 * Stop the node database.
 *
 * 30s of grace, because mysqld's shutdown flushes to disk and a SIGKILL there
 * is how you get a crash recovery on the next boot. Already stopped is success.
 *
 * Nothing is detached from `node_db_net`: the server containers stay attached
 * and simply fail to connect while this is down, which is what makes Start a
 * complete undo.
 */
export async function stopNodeDb(): Promise<NodeDbStatus> {
  const info = await requireNodeDbContainer();

  if (info.State === "running") {
    try {
      await docker.getContainer(info.Id).stop({ t: 30 });
    } catch (error) {
      // 304 = already stopped.
      if ((error as { statusCode?: number }).statusCode !== 304) throw error;
    }
  }

  return getNodeDbStatus();
}

/** The container, or a 404 naming the setup action that creates it. */
async function requireNodeDbContainer(): Promise<Docker.ContainerInfo> {
  const info = await findNodeDbContainer();
  if (!info) {
    throw notFound(
      `The node database container "${config.nodeDbContainer}" does not exist ` +
        `on this node. Set it up first.`,
    );
  }
  return info;
}

/** Create the data volume if it is not already there. */
async function ensureVolume(name: string): Promise<void> {
  try {
    await docker.getVolume(name).inspect();
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await docker.createVolume({
    Name: name,
    Labels: { "citadel.managed": "true", "citadel.role": "node-db" },
  });
}

/**
 * True when MariaDB answers `mariadb-admin ping` with the given password.
 *
 * The image ships `mariadb-admin`, not the `mysqladmin` symlink: the wrong name
 * fails with "executable file not found" on every probe, which reads exactly
 * like a database that never came up. The password goes through `MYSQL_PWD`
 * rather than `-p`, so it stays out of the container's process list.
 */
async function pingSucceeds(containerId: string, rootPassword: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execInContainer(
      docker,
      config.dockerSocket,
      containerId,
      {
        cmd: ["mariadb-admin", "ping", "-h", "127.0.0.1", "-u", "root"],
        env: [`MYSQL_PWD=${rootPassword}`],
      },
    );
    return `${stdout}${stderr}`.includes("mysqld is alive");
  } catch {
    // Exec failed: the container is still booting, or has no shell yet.
    return false;
  }
}

/**
 * Poll until MariaDB answers, or throw.
 *
 * The container reports "running" long before mysqld listens, so every caller
 * that promises a usable database has to wait here.
 */
async function waitUntilReady(
  containerId: string,
  rootPassword: string,
  options: { onTimeout?: () => Error } = {},
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingSucceeds(containerId, rootPassword)) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw (
    options.onTimeout?.() ??
    conflict(
      `The node database did not accept connections within ` +
        `${Math.round(READY_TIMEOUT_MS / 1000)}s. Check the container's logs ` +
        `("docker logs ${config.nodeDbContainer}").`,
    )
  );
}
