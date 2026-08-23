/**
 * SQL dumps of the databases provisioned on this node.
 *
 * These belong to the **administrator's** backup, not a server owner's. The
 * split is deliberate and is the shape of the whole feature:
 *
 *   - a server owner backs up their server's **files**;
 *   - an administrator backs up the **databases** every server on a node uses.
 *
 * Reading one tenant's database is a per-server operation; reading all of them
 * at once needs the node's MariaDB admin credential, which is root-equivalent on
 * that instance. Only an administrator has a reason to hold it, so only an
 * administrator can take this backup. Folding it into a per-server backup would
 * have meant the owner-triggered path touching a shared database instance on
 * behalf of everyone on the node.
 *
 * Two decisions worth stating, because the obvious alternatives are wrong:
 *
 * **A throwaway container, not `execInContainer`.** `docker/exec.ts` buffers a
 * command's whole stdout into a string, which is fine for a `CREATE DATABASE`
 * and fatal for a multi-gigabyte dump. Running `mariadb-dump` in its own
 * container with the staging directory bind-mounted lets the dump stream to disk
 * and never enter the agent's memory.
 *
 * **One file per database, not `--all-databases`.** A single stream would also
 * capture `mysql.user`, every tenant's password hash, and would make a
 * per-database restore impossible. The panel is already the source of truth for
 * database credentials (it stores them encrypted and can re-provision the user
 * and its grants), so the dumps only need to carry *data*.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { docker } from "../docker/client";
import { alignOwnership } from "../docker/userns";
import { config } from "../config";
import { serviceUnavailable } from "../http";
import { assertValidDbIdentifier } from "../docker/database";
import { ensureDirectory } from "../dataRoot";
import { runToolContainer } from "./toolContainer";
import { DUMPS_MOUNT } from "./restic";

/** The MariaDB admin credential for this node, supplied per request. */
export interface DbAdminCredential {
  user: string;
  password: string;
}

/** Wall-clock ceiling for one database's dump or import. */
const DUMP_TIMEOUT_MS = 60 * 60_000;

/**
 * Where a node's database dumps are staged.
 *
 * Under `config.backupStagingRoot`, which is a sibling of the server data root.
 * A dump inside a server's own data directory would be readable through the file
 * manager and over SFTP by anyone with the `files` permission, which is not the
 * same set of people as those with `database`. Here it is worse still: this is
 * *every* tenant's data, so it must not be under any one server's tree.
 */
export function nodeStagingPath(): string {
  return join(config.backupStagingRoot, "node-databases");
}

/**
 * Prepare an empty staging directory.
 *
 * Emptied rather than reused: a dump left over from a previous run for a database
 * that has since been deleted would silently ride along into the next snapshot,
 * and a restore would recreate it.
 */
export async function resetNodeStagingDir(): Promise<string> {
  const path = nodeStagingPath();
  await rm(path, { recursive: true, force: true });
  const dir = await ensureDirectory(path, "the database backup staging directory");
  // The dump/restic containers run as image root, in-namespace uid 0 on a
  // userns-remapped node, which is unmapped against an agent-owned directory
  // and could not write a single dump. Hand the staging tree to that uid
  // (a no-op when remapping is off). See docker/userns.ts.
  await alignOwnership(docker, dir, { containerUid: 0, containerGid: 0, recursive: true });
  return dir;
}

/** Ensure the staging directory exists without emptying it (restore path). */
export async function ensureNodeStagingDir(): Promise<string> {
  const path = nodeStagingPath();
  await mkdir(path, { recursive: true });
  await alignOwnership(docker, path, { containerUid: 0, containerGid: 0 });
  return path;
}

/**
 * Remove the staging directory.
 *
 * Always called once a snapshot is written or a restore finishes: leaving
 * plaintext SQL for every database on the node sitting on disk between backups is
 * the largest needless exposure in this whole path.
 */
export async function clearNodeStagingDir(): Promise<void> {
  await rm(nodeStagingPath(), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Resolve the image to run the MariaDB client from.
 *
 * The node's own database container is inspected for its image rather than
 * pinning a version here: whatever engine is serving the data ships a
 * `mariadb-dump` that can read it, and a mismatched client is a class of dump
 * corruption that only shows up at restore time. A missing container fails
 * loudly. A silent fallback to some other MariaDB version is the thing being
 * avoided.
 */
async function resolveDbClientImage(): Promise<string> {
  const containerName = config.nodeDbContainer;
  const matches = await docker.listContainers({
    all: true,
    filters: { name: [containerName] },
  });
  const info = matches.find((c) => (c.Names ?? []).some((n) => n === `/${containerName}`));

  if (!info?.Image) {
    throw serviceUnavailable(
      `The node database container "${containerName}" was not found, so its ` +
        `databases cannot be dumped. Run "bun run setup-db" on this node.`,
    );
  }
  return info.Image;
}

/** The filename a database's dump takes inside the staging directory. */
export function dumpFileName(dbName: string): string {
  return `${dbName}.sql`;
}

export interface DumpResult {
  name: string;
  fileName: string;
  sizeBytes: number;
}

/**
 * Dump every named database into the staging directory.
 *
 * Sequential, not parallel: these run against a MariaDB instance shared by every
 * server on the node, and N concurrent dumps of large tables is exactly the sort
 * of load that makes other tenants' servers time out. An admin backup of a busy
 * node is allowed to be slow; it is not allowed to be an outage.
 *
 * `--single-transaction` takes a consistent InnoDB snapshot without locking the
 * tables, so games keep writing while the dump runs.
 *
 * A database that cannot be dumped does **not** fail the whole run. On a node
 * with fifty databases, one that was dropped out from under us (or is corrupt)
 * must not cost the other forty-nine their backup. The failure is reported and
 * the sweep continues.
 */
export async function dumpNodeDatabases(
  databases: string[],
  admin: DbAdminCredential,
  onLog: (message: string, level?: "info" | "warn" | "error") => void,
): Promise<{ dumped: DumpResult[]; failed: { name: string; error: string }[] }> {
  const dumped: DumpResult[] = [];
  const failed: { name: string; error: string }[] = [];

  if (databases.length === 0) return { dumped, failed };

  const image = await resolveDbClientImage();
  const staging = await resetNodeStagingDir();

  for (const name of databases) {
    // The panel generated these names, but this is the agent defending itself:
    // the value is interpolated into a shell redirect and a SQL identifier below.
    assertValidDbIdentifier(name, "name");

    const fileName = dumpFileName(name);
    onLog(`Dumping ${name}…`);

    // The redirect needs a shell, so the entrypoint is a shell and the pipeline
    // is one argument. The identifier is validated above and the password travels
    // in the environment, so nothing interpolated here is attacker-controlled.
    const script =
      `set -o pipefail; mariadb-dump --single-transaction --no-tablespaces ` +
      `--routines --events --default-character-set=utf8mb4 ` +
      `-h "$DB_HOST" -u "$DB_USER" "$DB_NAME" > "${DUMPS_MOUNT}/${fileName}"`;

    try {
      const result = await runToolContainer({
        image,
        entrypoint: ["/bin/sh", "-c"],
        command: [script],
        env: {
          DB_HOST: config.nodeDbContainer,
          DB_USER: admin.user,
          DB_NAME: name,
          // MYSQL_PWD keeps the password out of argv, matching `docker/database.ts`.
          MYSQL_PWD: admin.password,
          MYSQL_DATABASE: name,
        },
        mounts: [{ hostPath: staging, containerPath: DUMPS_MOUNT }],
        extraNetworks: [config.nodeDbNetwork],
        timeoutMs: DUMP_TIMEOUT_MS,
      });

      if (result.exitCode !== 0) {
        const detail = result.output.trim().slice(-500);
        failed.push({ name, error: `exit ${result.exitCode}: ${detail}` });
        onLog(`Could not dump ${name} (exit ${result.exitCode}): ${detail}`, "warn");
        // Remove the partial file so a truncated dump never lands in a snapshot
        // and get silently restored later.
        await rm(join(staging, fileName), { force: true }).catch(() => undefined);
        continue;
      }

      const sizeBytes = Bun.file(join(staging, fileName)).size;
      dumped.push({ name, fileName, sizeBytes });
      onLog(`Dumped ${name} (${formatBytes(sizeBytes)}).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ name, error: message });
      onLog(`Could not dump ${name}: ${message}`, "warn");
      await rm(join(staging, fileName), { force: true }).catch(() => undefined);
    }
  }

  return { dumped, failed };
}

/**
 * Re-import databases from a restored staging directory.
 *
 * `CREATE DATABASE IF NOT EXISTS` runs first, because the reason to restore a
 * node's databases is usually that they are gone. The panel re-provisions the
 * scoped *users* and their grants separately from its own encrypted records,
 * which is why the dumps only need to carry data.
 *
 * As with dumping, one database's failure does not abort the rest: a restore that
 * recovers forty-nine of fifty databases and says which one it could not is far
 * more useful than one that stops at the first problem.
 *
 * An import is not transactional. `mariadb-dump` output contains its own
 * `DROP`/`CREATE TABLE` DDL, which MariaDB cannot roll back, so a failure
 * leaves that one database partially restored. That is reported, not hidden.
 */
export async function importNodeDatabases(
  databases: string[],
  admin: DbAdminCredential,
  onLog: (message: string, level?: "info" | "warn" | "error") => void,
): Promise<{ restored: string[]; failed: { name: string; error: string }[] }> {
  const restored: string[] = [];
  const failed: { name: string; error: string }[] = [];

  if (databases.length === 0) return { restored, failed };

  const image = await resolveDbClientImage();
  const staging = await ensureNodeStagingDir();

  for (const name of databases) {
    assertValidDbIdentifier(name, "name");

    const fileName = dumpFileName(name);
    if (!(await Bun.file(join(staging, fileName)).exists())) {
      onLog(
        `No dump for ${name} in this snapshot. It was created after the backup ` +
          `was taken. Leaving it untouched.`,
        "warn",
      );
      continue;
    }

    onLog(`Restoring ${name}…`);

    const script =
      `mariadb --default-character-set=utf8mb4 -h "$DB_HOST" -u "$DB_USER" ` +
      `-e "CREATE DATABASE IF NOT EXISTS \\\`$DB_NAME\\\` ` +
      `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" && ` +
      `mariadb --default-character-set=utf8mb4 -h "$DB_HOST" -u "$DB_USER" ` +
      `"$DB_NAME" < "${DUMPS_MOUNT}/${fileName}"`;

    try {
      const result = await runToolContainer({
        image,
        entrypoint: ["/bin/sh", "-c"],
        command: [script],
        env: {
          DB_HOST: config.nodeDbContainer,
          DB_USER: admin.user,
          DB_NAME: name,
          MYSQL_PWD: admin.password,
        },
        mounts: [{ hostPath: staging, containerPath: DUMPS_MOUNT, readOnly: true }],
        extraNetworks: [config.nodeDbNetwork],
        timeoutMs: DUMP_TIMEOUT_MS,
      });

      if (result.exitCode !== 0) {
        const detail = result.output.trim().slice(-500);
        failed.push({ name, error: `exit ${result.exitCode}: ${detail}` });
        onLog(
          `Could not restore ${name} (exit ${result.exitCode}). It may be ` +
            `partially restored. ${detail}`,
          "error",
        );
        continue;
      }

      restored.push(name);
      onLog(`Restored ${name}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ name, error: message });
      onLog(`Could not restore ${name}: ${message}`, "error");
    }
  }

  return { restored, failed };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
