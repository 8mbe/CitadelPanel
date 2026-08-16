/**
 * One-time per-node database setup.
 *
 * Each node that wants to offer auto-provisioned databases to its servers runs
 * this script. It creates:
 *
 *   1. The `node_db_net` Docker network — a dedicated bridge with inter-container
 *      communication enabled, so server containers attached to it can reach the
 *      MariaDB container. Tenant isolation does not come from network ICC: it
 *      comes from MariaDB itself, where each server's database has a dedicated
 *      user granted access to that one database only (see `provisionServerDatabase`).
 *      Disabling ICC here would block the game-server → database path too,
 *      since both sit on the same bridge.
 *   2. A MariaDB container on that network, with a randomly-generated root
 *      password. No host ports are published: the database is only reachable
 *      from containers attached to `node_db_net`, never from the host or the
 *      public internet.
 *
 * The script prints the connection details the operator must paste into the
 * panel's "register node" form (dbAdminHost, dbAdminPort, dbAdminUser,
 * dbAdminPassword). The host is the MariaDB container's IP on `node_db_net`,
 * which is what server containers will use to connect — the panel talks to the
 * database through the agent, which itself reaches MariaDB over `node_db_net`.
 *
 * Idempotent: re-running detects an existing network/container and reports the
 * current connection details instead of recreating them.
 *
 * Usage:
 *   bun run scripts/setup-node-db.ts
 *
 * Environment overrides:
 *   NODE_DB_NETWORK     (default: node_db_net)   Docker network name
 *   NODE_DB_CONTAINER   (default: citadel-node-db) Container name
 *   NODE_DB_ROOT_USER   (default: root)          MariaDB root username
 *   NODE_DB_MARIADB_IMAGE (default: mariadb:11)  Image to pull
 */

import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import { execInContainer } from "../src/docker/exec";

const NETWORK_NAME = process.env.NODE_DB_NETWORK ?? "node_db_net";
const CONTAINER_NAME = process.env.NODE_DB_CONTAINER ?? "citadel-node-db";
const ROOT_USER = process.env.NODE_DB_ROOT_USER ?? "root";
const IMAGE = process.env.NODE_DB_MARIADB_IMAGE ?? "mariadb:11";

const DOCKER_SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const docker = new Docker({ socketPath: DOCKER_SOCKET });

/** Generate a strong alphanumeric password (no shell/SQL-hostile chars). */
function generatePassword(length = 32): string {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/** Check whether a network with this name already exists. */
async function findNetwork(name: string): Promise<Docker.Network | null> {
  const networks = await docker.listNetworks({
    filters: { name: [name] },
  });
  const exact = networks.find((n) => n.Name === name);
  return exact ? docker.getNetwork(exact.Id) : null;
}

/** Check whether a container with this name already exists. */
async function findContainer(name: string): Promise<Docker.ContainerInfo | null> {
  const containers = await docker.listContainers({
    all: true,
    filters: { name: [name] },
  });
  return (
    containers.find((c) => (c.Names ?? []).some((n) => n === `/${name}`)) ?? null
  );
}

/**
 * The network config: a bridge with inter-container communication enabled, so
 * server containers on it can reach the MariaDB container. Outbound NAT is left
 * on (not strictly necessary here, but harmless and consistent with the
 * per-server network posture).
 *
 * We deliberately do NOT set `enable_icc=false`. That flag blocks all
 * inter-container traffic on the bridge — including the game-server → MariaDB
 * path this whole feature depends on. Tenant isolation is enforced by MariaDB's
 * per-database user grants, not by the network.
 */
function networkConfig(name: string) {
  return {
    Name: name,
    Driver: "bridge",
    CheckDuplicate: true,
    Internal: false,
    Options: {
      "com.docker.network.bridge.enable_ip_masquerade": "true",
    },
    Labels: { "citadel.managed": "true", "citadel.role": "node-db" },
  };
}

async function ensureNetwork(): Promise<Docker.Network> {
  const existing = await findNetwork(NETWORK_NAME);
  if (existing) {
    console.log(`✓ Network "${NETWORK_NAME}" already exists — reusing.`);
    return existing;
  }

  console.log(`Creating network "${NETWORK_NAME}"…`);
  await docker.createNetwork(networkConfig(NETWORK_NAME));
  console.log(`✓ Network created.`);
  return docker.getNetwork(NETWORK_NAME);
}

/** Pull an image if it is not already present (mirrors docker/container.ts). */
async function ensureImage(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // not present — pull below
  }
  console.log(`Pulling image "${image}"…`);
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Create and start the MariaDB container with a random root password.
 *
 * No host ports are published — the database is reachable only from containers
 * on `node_db_net`. `MARIADB_ROOT_PASSWORD` is the one env var MariaDB requires
 * to initialize; the root user is created with `GRANT ALL ON *.*` by default,
 * which is exactly what the panel needs to create per-server databases and
 * users later.
 */
async function ensureContainer(rootPassword: string): Promise<Docker.ContainerInfo> {
  const existing = await findContainer(CONTAINER_NAME);
  if (existing) {
    console.log(`✓ Container "${CONTAINER_NAME}" already exists — reusing.`);
    if (existing.State !== "running") {
      console.log(`Starting existing container…`);
      await docker.getContainer(existing.Id).start();
    }
    return existing;
  }

  await ensureImage(IMAGE);

  console.log(`Creating MariaDB container "${CONTAINER_NAME}"…`);
  const container = await docker.createContainer({
    name: CONTAINER_NAME,
    Image: IMAGE,
    Env: [`MARIADB_ROOT_PASSWORD=${rootPassword}`],
    HostConfig: {
      // Attach to the node DB network only — no host port bindings, no default
      // bridge. Restart unless-stopped so a node reboot brings the DB back.
      NetworkMode: NETWORK_NAME,
      RestartPolicy: { Name: "unless-stopped" },
      PublishAllPorts: false,
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      },
    },
    Labels: { "citadel.managed": "true", "citadel.role": "node-db" },
  });

  await container.start();
  console.log(`✓ Container created and started.`);

  // Re-list to get the full info with network settings.
  const info = await findContainer(CONTAINER_NAME);
  if (!info) throw new Error("Container was created but could not be found afterwards.");
  return info;
}

/**
 * Resolve the MariaDB container's IP on `node_db_net`.
 *
 * This is the address server containers (and the panel, via the agent) use to
 * reach the database. Docker assigns it when the container starts.
 */
function containerIp(info: Docker.ContainerInfo, networkName: string): string | null {
  const nets = info.NetworkSettings?.Networks ?? {};
  const net = nets[networkName];
  return net?.IPAddress ?? null;
}

/**
 * Wait for MariaDB to accept connections.
 *
 * MariaDB runs its initialisation (system tables, root user) on first boot,
 * which can take 10-30s. The container is "running" before it is ready, so we
 * poll `mariadb-admin ping` until it succeeds.
 *
 * NB: the mariadb:11 image ships `mariadb-admin` but not the `mysqladmin`
 * symlink — using the wrong name makes every probe exec fail with "executable
 * file not found".
 *
 * The password is passed via `MYSQL_PWD` (not a `-p` CLI arg), so it never
 * appears in the process list and avoids the "using a password on the command
 * line can be insecure" warning — matching the convention in
 * `src/docker/database.ts` `execSql`.
 *
 * Exec output is captured via `execInContainer` rather than dockerode's
 * `exec.start({ hijack: true })`: hijack relies on Node's `http` upgrade
 * mechanics, which Bun does not implement (see `src/docker/exec.ts`).
 */
async function waitForReady(containerId: string, rootPassword: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  console.log("Waiting for MariaDB to become ready (this can take ~20s on first boot)…");

  while (Date.now() < deadline) {
    try {
      const { stdout, stderr } = await execInContainer(docker, DOCKER_SOCKET, containerId, {
        cmd: ["mariadb-admin", "ping", "-h", "127.0.0.1", "-u", ROOT_USER],
        env: [`MYSQL_PWD=${rootPassword}`],
      });
      if (`${stdout}${stderr}`.includes("mysqld is alive")) {
        console.log("✓ MariaDB is ready.");
        return;
      }
    } catch {
      // exec failed — container may not be ready yet
    }
    await sleep(2_000);
  }
  throw new Error("MariaDB did not become ready within 120 seconds.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Entry point --------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== CitadelPanel node database setup ===\n");

  await ensureNetwork();

  // For a new container we generate a fresh password; for an existing one we
  // cannot recover the stored password, so we report that the operator should
  // already have it from the first run.
  const existing = await findContainer(CONTAINER_NAME);
  const rootPassword = existing ? null : generatePassword(32);

  const info = await ensureContainer(rootPassword ?? "");

  if (rootPassword) {
    await waitForReady(info.Id, rootPassword);
  }

  const ip = containerIp(info, NETWORK_NAME);
  const port = 3306;

  console.log("\n=== Node database ready ===\n");
  console.log("Enter these values when registering the node in the panel:\n");
  console.log(`  dbAdminHost:     ${ip ?? "(could not resolve IP — check 'docker network inspect " + NETWORK_NAME + "')"}`);
  console.log(`  dbAdminPort:     ${port}`);
  console.log(`  dbAdminUser:     ${ROOT_USER}`);
  if (rootPassword) {
    console.log(`  dbAdminPassword: ${rootPassword}`);
    console.log("\n  ⚠  Copy the password now — it is NOT stored by this script and");
    console.log("     cannot be recovered. The panel encrypts it on registration.");
  } else {
    console.log(`  dbAdminPassword: (use the password from the first run of this script)`);
  }
  console.log(`\n  Network:         ${NETWORK_NAME}`);
  console.log(`  Container:       ${CONTAINER_NAME}`);
  console.log("");
}

main().catch((error) => {
  console.error("\n✗ Setup failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
