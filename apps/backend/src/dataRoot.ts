/**
 * Readiness of the per-server data root.
 *
 * Every directory the agent creates lives under `config.serverDataRoot` and is
 * created as the agent's own user. When that root is missing, owned by another
 * user, or on a read-only mount, *every* provision fails at `mkdir` — and the
 * original symptom was an unhandled `EACCES` that reached the panel as a bare
 * "Internal agent error", which tells the admin nothing about the actual fix.
 *
 * So writability is treated as a first-class piece of node health:
 *   - probed at boot and logged with the exact command that fixes it;
 *   - reported by `/v1/health`, so the panel can refuse to place a server on a
 *     node that cannot store its data, and say why;
 *   - re-probed per call rather than cached, so a `chown` on the node takes
 *     effect without restarting the agent.
 *
 * The probe writes a real file rather than calling `access`: permission bits are
 * only one of the ways a directory can be unwritable (read-only mounts and full
 * filesystems are others), and a write is the operation that actually matters.
 */

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import { docker } from "./docker/client";
import {
  alignOwnership,
  CONTAINER_DATA_GID,
  CONTAINER_DATA_UID,
  containerOwnerForHost,
  usernsOffsets,
} from "./docker/userns";
import { serviceUnavailable } from "./http";
import { serverDataPath } from "./paths";

/** Whether this node can store server data right now. */
export interface DataRootStatus {
  path: string;
  writable: boolean;
  /** Operator-facing cause plus remediation. Only set when not writable. */
  error?: string;
}

const PROBE_FILE = ".citadel-write-probe";

const agentUid = (): number => process.getuid?.() ?? 0;
const agentGid = (): number => process.getgid?.() ?? 0;

/**
 * Turn a filesystem error into something an admin can act on.
 *
 * The distinctions matter because the fixes differ: an ownership problem is a
 * `chown`, a read-only mount is not, and a full disk is neither.
 */
export function explainDataRootError(error: unknown, fallbackPath: string): string {
  const err = error as { code?: string; message?: string; path?: string };
  const target = err.path ?? fallbackPath;
  const root = config.serverDataRoot;

  switch (err.code) {
    case "EACCES":
    case "EPERM":
      return (
        `The node agent (uid ${agentUid()}) is not allowed to write to ${target}. ` +
        `Fix it on the node with: sudo mkdir -p ${root} && ` +
        `sudo chown -R ${agentUid()}:${agentGid()} ${root}`
      );
    case "EROFS":
      return (
        `${target} is on a read-only filesystem. Remount it read-write, or point ` +
        `the agent elsewhere with SERVER_DATA_ROOT.`
      );
    case "ENOSPC":
      return `The filesystem holding ${target} is full.`;
    case "ENOTDIR":
      return `A component of ${target} exists but is not a directory.`;
    default:
      return `${target} could not be written: ${err.message ?? String(error)}`;
  }
}

/**
 * Check that a directory exists and the agent can write into it.
 *
 * Never throws: an unusable root is a state the panel needs to display, not an
 * exception to propagate out of a health check.
 *
 * Takes the path rather than reading `config` so it is testable against a
 * temporary directory; production callers go through {@link probeDataRoot}.
 */
export async function probeDirectoryWritable(path: string): Promise<DataRootStatus> {
  const probe = join(path, PROBE_FILE);

  try {
    await mkdir(path, { recursive: true });
    await writeFile(probe, "");
    return { path, writable: true };
  } catch (error) {
    // A failed write reports the probe file as its path, which is an internal
    // detail; the admin needs to be told about the directory.
    const cause = error as { code?: string; message?: string };
    return {
      path,
      writable: false,
      error: explainDataRootError({ code: cause.code, message: cause.message, path }, path),
    };
  } finally {
    // Leaving the probe behind would put a stray dotfile in every node's data
    // root; `force` makes the cleanup a no-op when the write never happened.
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

/** Whether this node's configured data root is usable right now. */
export async function probeDataRoot(): Promise<DataRootStatus> {
  return probeDirectoryWritable(config.serverDataRoot);
}

/**
 * Create a directory, or fail with something the admin can fix.
 *
 * 503 rather than 500: the node is correctly refusing work it cannot do, and the
 * panel maps the status straight through to the admin who asked for the server.
 *
 * @param subject What the directory is for, in the failure message.
 */
export async function ensureDirectory(
  path: string,
  subject: string,
): Promise<string> {
  try {
    await mkdir(path, { recursive: true });
    return path;
  } catch (error) {
    throw serviceUnavailable(
      `This node cannot create ${subject}. ${explainDataRootError(error, path)}`,
    );
  }
}

/** Create a server's data directory below the configured root. */
export async function ensureServerDataDir(serverId: string): Promise<string> {
  const path = await ensureDirectory(
    serverDataPath(serverId),
    `the data directory for server ${serverId}`,
  );

  // Under userns-remap the directory must be owned by the *shifted* data uid
  // (offset + 1000) or the container cannot write into its own bind mount.
  // Healed here rather than only chowned at first create because this runs on
  // every provision, install and rebuild: a node that turns remapping on gets
  // its pre-existing trees migrated the first time each container is rebuilt
  // (which enabling remap forces anyway — the daemon starts with a fresh
  // container store). Recursive only on mismatch, so the steady state is one
  // stat per call, not a walk of a fifty-gigabyte world.
  const offsets = await usernsOffsets(docker);
  if (offsets.uid !== 0 || offsets.gid !== 0) {
    const expectedUid = offsets.uid + CONTAINER_DATA_UID;
    const expectedGid = offsets.gid + CONTAINER_DATA_GID;
    const info = await stat(path).catch(() => null);
    if (info && (info.uid !== expectedUid || info.gid !== expectedGid)) {
      await alignOwnership(docker, path, { recursive: true });
    }
  }

  return path;
}

/**
 * The `uid:gid` a container must run as to own this directory's bytes
 * (Docker's `--user`, so **container-side** ids).
 *
 * A container the agent creates has `CapDrop: ALL`, which takes
 * `CAP_DAC_OVERRIDE` with it — so uid 0 inside that container is *not* the root
 * that ignores permission bits. Against a data directory the agent created as
 * itself (uid 1000, mode 0755) a nominally-root container gets plain "other"
 * access, and the first write into `/server` fails with EACCES.
 *
 * Hence: don't guess a uid, read the one that actually owns the bytes. The panel
 * cannot supply this — the owner is whatever uid the node's agent runs as, which
 * is a per-node fact — and hardcoding 1000 would break the equally common
 * root-owned root. It is the same reasoning as a blueprint's `run_as`, applied
 * to the container the blueprint doesn't get to configure.
 *
 * Under userns-remap the stat reports the *host-side* owner, which is shifted
 * relative to what Docker's `User` means — so the owner is translated back
 * through the effective offset (see `docker/userns.ts`) before it is returned.
 *
 * Falls back to the agent's own uid: it created the directory, so on the odd
 * filesystem that cannot report an owner it remains the best guess available.
 */
export async function directoryOwner(path: string): Promise<string> {
  const offsets = await usernsOffsets(docker);
  try {
    const info = await stat(path);
    return containerOwnerForHost(info.uid, info.gid, offsets);
  } catch {
    return containerOwnerForHost(agentUid(), agentGid(), offsets);
  }
}

/**
 * Log the data root's state at boot.
 *
 * Deliberately does not exit on failure. The agent is still useful when the root
 * is broken — health, stats, port probes and existing containers all work — and
 * a process that refuses to start reads to the panel as "node unreachable",
 * which is exactly the wrong diagnosis to hand an operator.
 */
export async function reportDataRootAtBoot(): Promise<void> {
  const status = await probeDataRoot();

  if (status.writable) {
    console.log(`[agent] server data root: ${status.path} (writable)`);
    return;
  }

  console.error(`[agent] server data root: ${status.path} (NOT WRITABLE)`);
  console.error(`[agent] ${status.error}`);
  console.error(
    "[agent] server creation will be refused with this message until it is fixed.",
  );
}
