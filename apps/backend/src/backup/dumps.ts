/**
 * SQL dumps of a server's provisioned databases, on the way into and out of a
 * snapshot.
 *
 * A game server's state is split across two stores: files under
 * `<serverDataRoot>/<id>`, and whatever it keeps in the databases its owner
 * provisioned on the node's shared MariaDB (`docker/database.ts`). A backup of
 * only the files restores a world whose economy, permissions and player records
 * are from a different point in time — so both go into the same snapshot, and a
 * restore puts both back.
 *
 * Two decisions worth stating, because the obvious alternatives are wrong:
 *
 * **A throwaway container, not `execInContainer`.** `docker/exec.ts` buffers a
 * command's whole stdout into a string, which is fine for a `CREATE DATABASE`
 * and fatal for a multi-gigabyte dump. Running `mariadb-dump` in its own
 * container with the staging directory bind-mounted lets the dump stream to
 * disk and never enter the agent's memory.
 *
 * **The scoped per-database user, not the DB admin.** The panel already
 * decrypts each database's own credentials for the database explorer, and those
 * grants cover exactly one database. Dumping as that user means MariaDB itself
 * contains a bug here to the one database being backed up; the root-equivalent
 * admin credential never enters the backup path at all.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { docker } from "../docker/client";
import { config } from "../config";
import { serviceUnavailable } from "../http";
import { assertValidDbIdentifier } from "../docker/database";
import { ensureDirectory } from "../dataRoot";
import { runToolContainer } from "./toolContainer";
import { DUMPS_MOUNT } from "./restic";

/** One database to dump or restore, with its own scoped credentials. */
export interface DatabaseCredential {
  name: string;
  user: string;
  password: string;
}

/** Wall-clock ceiling for one database's dump or import. */
const DUMP_TIMEOUT_MS = 30 * 60_000;

/**
 * Where a server's dumps are staged on the node.
 *
 * Under `config.backupStagingRoot`, which is a sibling of the data root — a
 * dump inside the server's own data directory would be readable through the
 * file manager and SFTP by anyone with the `files` permission, which is not the
 * same set of people as those with `database` permission.
 */
export function stagingPath(serverId: string): string {
  return join(config.backupStagingRoot, serverId);
}

/**
 * Prepare an empty staging directory for a server.
 *
 * Emptied rather than reused: a dump left over from a previous run for a
 * database that has since been deleted would silently ride along into the next
 * snapshot, and a restore would recreate it.
 */
export async function resetStagingDir(serverId: string): Promise<string> {
  const path = stagingPath(serverId);
  await rm(path, { recursive: true, force: true });
  return ensureDirectory(path, `the backup staging directory for server ${serverId}`);
}

/** Remove a server's staging directory once its snapshot is written. */
export async function clearStagingDir(serverId: string): Promise<void> {
  await rm(stagingPath(serverId), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Resolve the image to run the MariaDB client from.
 *
 * The node's own database container is inspected for its image rather than
 * pinning a version here: whatever engine is serving the data is guaranteed to
 * ship a `mariadb-dump` that can read it, and a mismatched client is a class of
 * dump corruption that only shows up at restore time. Falls back to the
 * configured container name's image being unavailable by failing loudly — a
 * silent fallback to some other MariaDB version is the thing being avoided.
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
 * Dump every one of a server's databases into its staging directory.
 *
 * Sequential, not parallel: these run against a MariaDB instance shared by
 * every server on the node, and N concurrent dumps of large tables is exactly
 * the sort of load that makes other tenants' servers time out.
 *
 * `--single-transaction` takes a consistent InnoDB snapshot without locking the
 * tables, so the game keeps writing while the dump runs. `--no-tablespaces`
 * avoids needing the global `PROCESS` privilege, which the scoped user
 * deliberately does not have.
 */
export async function dumpDatabases(
  serverId: string,
  databases: DatabaseCredential[],
  onLog: (message: string) => void,
): Promise<DumpResult[]> {
  if (databases.length === 0) return [];

  const image = await resolveDbClientImage();
  const hostStaging = await resetStagingDir(serverId);
  const results: DumpResult[] = [];

  for (const database of databases) {
    assertValidDbIdentifier(database.name, "name");
    assertValidDbIdentifier(database.user, "user");

    const fileName = dumpFileName(database.name);
    onLog(`Dumping database ${database.name}…`);

    // The redirect needs a shell, so the entrypoint is a shell and the whole
    // pipeline is one argument. The identifiers are validated above and the
    // password travels in the environment, so nothing interpolated here is
    // attacker-controlled or secret.
    const script =
      `set -o pipefail; mariadb-dump --single-transaction --no-tablespaces ` +
      `--routines --events --default-character-set=utf8mb4 ` +
      `-h "$DB_HOST" -u "$DB_USER" "$DB_NAME" > "${DUMPS_MOUNT}/${fileName}"`;

    const result = await runToolContainer({
      image,
      entrypoint: ["/bin/sh", "-c"],
      command: [script],
      env: {
        DB_HOST: config.nodeDbContainer,
        DB_USER: database.user,
        DB_NAME: database.name,
        // MYSQL_PWD keeps the password out of argv, matching `docker/database.ts`.
        MYSQL_PWD: database.password,
      },
      mounts: [{ hostPath: hostStaging, containerPath: DUMPS_MOUNT }],
      extraNetworks: [config.nodeDbNetwork],
      timeoutMs: DUMP_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Dumping database ${database.name} failed (exit ${result.exitCode}): ` +
          result.output.trim().slice(-800),
      );
    }

    const sizeBytes = Bun.file(join(hostStaging, fileName)).size;
    onLog(`Dumped ${database.name} (${formatBytes(sizeBytes)}).`);
    results.push({ name: database.name, fileName, sizeBytes });
  }

  return results;
}

/**
 * Re-import each database's dump after a restore has written it back to the
 * staging directory.
 *
 * A dump that is absent from the snapshot is skipped with a log line rather
 * than failing the restore: it means the database was provisioned after that
 * backup was taken, and losing the rest of the restore over it would be worse.
 *
 * The import is not wrapped in a transaction — a `mariadb-dump` file contains
 * its own `DROP TABLE` / `CREATE TABLE` DDL, which MariaDB cannot roll back. A
 * failed import therefore leaves that one database partially restored, which is
 * reported rather than hidden.
 */
export async function importDatabases(
  serverId: string,
  databases: DatabaseCredential[],
  onLog: (message: string) => void,
): Promise<void> {
  if (databases.length === 0) return;

  const image = await resolveDbClientImage();
  const hostStaging = stagingPath(serverId);

  for (const database of databases) {
    assertValidDbIdentifier(database.name, "name");
    assertValidDbIdentifier(database.user, "user");

    const fileName = dumpFileName(database.name);
    const dumpFile = Bun.file(join(hostStaging, fileName));

    if (!(await dumpFile.exists())) {
      onLog(
        `No dump for ${database.name} in this snapshot — it was created after ` +
          `the backup was taken. Leaving it untouched.`,
      );
      continue;
    }

    onLog(`Restoring database ${database.name}…`);

    const script =
      `mariadb --default-character-set=utf8mb4 -h "$DB_HOST" -u "$DB_USER" ` +
      `"$DB_NAME" < "${DUMPS_MOUNT}/${fileName}"`;

    const result = await runToolContainer({
      image,
      entrypoint: ["/bin/sh", "-c"],
      command: [script],
      env: {
        DB_HOST: config.nodeDbContainer,
        DB_USER: database.user,
        DB_NAME: database.name,
        MYSQL_PWD: database.password,
      },
      mounts: [{ hostPath: hostStaging, containerPath: DUMPS_MOUNT, readOnly: true }],
      extraNetworks: [config.nodeDbNetwork],
      timeoutMs: DUMP_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Restoring database ${database.name} failed (exit ${result.exitCode}). ` +
          `That database may be partially restored. ` +
          result.output.trim().slice(-800),
      );
    }

    onLog(`Restored ${database.name}.`);
  }
}

/** Ensure the staging directory exists without emptying it (restore path). */
export async function ensureStagingDir(serverId: string): Promise<string> {
  const path = stagingPath(serverId);
  await mkdir(path, { recursive: true });
  return path;
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
