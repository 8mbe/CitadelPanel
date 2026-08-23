/**
 * User-namespace remapping support (`dockerd --userns-remap`).
 *
 * Why this exists: every other layer in `hardening.ts` reduces what a container
 * may *do*; none of them changes who the container *is*. Without remapping,
 * uid 0 inside a container is uid 0 on the host, so a single kernel escape is
 * an instant host root. With the daemon's `userns-remap` enabled, container
 * uid N is host uid `base + N` for a subordinate range from `/etc/subuid`, so
 * a kernel escape then lands in an unprivileged, otherwise-unused host uid.
 * It is most of what a sandbox runtime buys, at none of the syscall cost.
 *
 * The agent's job here is bookkeeping, not enforcement: the daemon does the
 * remapping (`UsernsMode: ""` in `hardening.ts` inherits it), but every host
 * uid the agent reads or sets is now shifted relative to what the container
 * sees. This module owns that translation:
 *
 *   host uid = container uid + offset
 *
 * where `offset` is *effective*, not absolute: the agent itself may run inside
 * a remapped container (the docker-compose deployment), in which case its own
 * `/proc/self/uid_map` already applies the same shift and the effective offset
 * is zero, and file uids the agent sees are container-side already. Only a
 * host-side (bare-process) agent next to a remapped daemon sees a nonzero
 * offset. Computing `daemon base − own base` handles both deployments.
 *
 * Detection is best-effort by design. When the daemon is unreachable at boot
 * the offsets resolve to zero and the next caller retries; nothing here may
 * take the agent down. This is the same posture as `dataRoot.ts`.
 */

import { lchown, readdir, readFile } from "node:fs/promises";
import type Docker from "dockerode";
import { join } from "node:path";
import { config } from "../config";

/**
 * The canonical *container-side* owner of server data.
 *
 * Not a new invention: every shipped blueprint already pins `user: "1000:1000"`
 * (see `blueprints/definitions/`), and a non-remapped node works because the
 * agent conventionally runs as uid 1000 too. Remapping makes the convention
 * explicit. The host-side owner becomes `offset + 1000`, and this constant is
 * the single place the `1000` comes from.
 */
export const CONTAINER_DATA_UID = 1000;
export const CONTAINER_DATA_GID = 1000;

/** Effective uid/gid shift between container-side and agent-visible ids. */
export interface UsernsOffsets {
  uid: number;
  gid: number;
}

const ZERO_OFFSETS: UsernsOffsets = { uid: 0, gid: 0 };

/**
 * Parse the base of an id map (`/proc/self/uid_map` format).
 *
 * An identity map ("0 0 4294967295") means no namespace shift and parses to 0.
 * A remapped process maps in-namespace 0 to its subordinate base
 * ("0 231072 65536" → 231072). Only the mapping that contains id 0 matters.
 * That is the line the data owner and the tool containers' root live under.
 */
export function parseIdMapBase(mapText: string): number {
  for (const line of mapText.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const inside = Number.parseInt(fields[0]!, 10);
    const outside = Number.parseInt(fields[1]!, 10);
    if (inside === 0 && Number.isFinite(outside)) return outside;
  }
  return 0;
}

/**
 * Parse the daemon's remap base out of `DockerRootDir`.
 *
 * A remapped daemon keeps its state in `<data-root>/<uid>.<gid>` (e.g.
 * `/var/lib/docker/231072.231072`). The suffix is the subordinate range base
 * and is the one place the API exposes it. Returns null when the directory has
 * no such suffix, which is what a non-remapped daemon reports.
 */
export function parseRemapBaseFromRootDir(
  dockerRootDir: string,
): { uid: number; gid: number } | null {
  const match = /(?:^|\/)(\d+)\.(\d+)\/?$/.exec(dockerRootDir);
  if (!match) return null;
  return { uid: Number.parseInt(match[1]!, 10), gid: Number.parseInt(match[2]!, 10) };
}

/**
 * Effective offsets from the daemon's base and the agent's own namespace base.
 *
 * A negative result means the agent sits in a *deeper* namespace than the
 * containers it manages. No coherent translation exists, so it clamps to zero
 * (treat ids as aligned) rather than producing uids that underflow.
 */
export function computeEffectiveOffsets(
  daemonBase: { uid: number; gid: number },
  selfBase: { uid: number; gid: number },
): UsernsOffsets {
  return {
    uid: Math.max(0, daemonBase.uid - selfBase.uid),
    gid: Math.max(0, daemonBase.gid - selfBase.gid),
  };
}

/** What detection concluded, kept for the boot report and health. */
export interface UsernsState {
  /** True when the daemon reports `name=userns` in SecurityOptions. */
  daemonRemapActive: boolean;
  offsets: UsernsOffsets;
  /** Set when remap is active but the base could not be determined. */
  error?: string;
}

let detected: UsernsState | null = null;

async function readSelfBase(): Promise<{ uid: number; gid: number }> {
  const [uidMap, gidMap] = await Promise.all([
    readFile("/proc/self/uid_map", "utf8").catch(() => ""),
    readFile("/proc/self/gid_map", "utf8").catch(() => ""),
  ]);
  return { uid: parseIdMapBase(uidMap), gid: parseIdMapBase(gidMap) };
}

/**
 * Detect the daemon's remap state and compute the effective offsets.
 *
 * Memoized on success: the daemon's remap configuration cannot change without
 * a daemon restart, which recreates every managed container anyway. A failed
 * detection (daemon unreachable) is *not* memoized. It returns inactive/zero
 * and the next caller retries, so an agent that boots before Docker heals
 * itself once the socket comes back.
 */
export async function detectUserns(client: Docker): Promise<UsernsState> {
  if (detected) return detected;

  // An explicit operator override skips daemon introspection entirely, for
  // daemons whose data-root naming defeats the suffix parse.
  if (config.usernsUidOffset >= 0 || config.usernsGidOffset >= 0) {
    detected = {
      daemonRemapActive: true,
      offsets: {
        uid: Math.max(0, config.usernsUidOffset),
        gid: Math.max(0, config.usernsGidOffset >= 0 ? config.usernsGidOffset : config.usernsUidOffset),
      },
    };
    return detected;
  }

  let info: { SecurityOptions?: string[]; DockerRootDir?: string };
  try {
    info = (await client.info()) as typeof info;
  } catch {
    return { daemonRemapActive: false, offsets: ZERO_OFFSETS };
  }

  const active = (info.SecurityOptions ?? []).some((opt) => opt.includes("name=userns"));
  if (!active) {
    detected = { daemonRemapActive: false, offsets: ZERO_OFFSETS };
    return detected;
  }

  const daemonBase = parseRemapBaseFromRootDir(info.DockerRootDir ?? "");
  if (!daemonBase) {
    // Remap is on but the base is unknown: translating with a guessed offset
    // would chown tenant data to arbitrary uids, so surface the gap and treat
    // ids as aligned until the operator sets USERNS_UID_OFFSET.
    detected = {
      daemonRemapActive: true,
      offsets: ZERO_OFFSETS,
      error:
        `userns-remap is active but the subordinate base could not be read from ` +
        `DockerRootDir ("${info.DockerRootDir ?? ""}"). Set USERNS_UID_OFFSET / ` +
        `USERNS_GID_OFFSET on this agent to the base from /etc/subuid.`,
    };
    return detected;
  }

  const selfBase = await readSelfBase();
  detected = {
    daemonRemapActive: true,
    offsets: computeEffectiveOffsets(daemonBase, selfBase),
  };
  return detected;
}

/** Test seam: force a detection result (pass null to re-detect). */
export function __setDetectedUserns(state: UsernsState | null): void {
  detected = state;
}

/**
 * The effective offsets, detecting on first use.
 *
 * Callers are all async file paths (provisioning, file manager, SFTP, backup
 * staging), so a lazy await here costs nothing and spares each of them the
 * "has detection run yet" question.
 */
export async function usernsOffsets(client: Docker): Promise<UsernsOffsets> {
  return (await detectUserns(client)).offsets;
}

/**
 * The `uid:gid` a container must run as when nothing else pinned one, or
 * undefined when the image's own USER should stand.
 *
 * Under remapping the data directory is owned by `offset + 1000` on the host,
 * which is in-container uid 1000. An image-default root (in-container uid 0)
 * has no `CAP_DAC_OVERRIDE` under `CapDrop: ALL` and could not write its own
 * data dir. Pinning the default to the data owner keeps user-less blueprints
 * working; without remapping the historical behaviour (image default) stands.
 */
export async function defaultRunAsUser(client: Docker): Promise<string | undefined> {
  const offsets = await usernsOffsets(client);
  if (offsets.uid === 0 && offsets.gid === 0) return undefined;
  return `${CONTAINER_DATA_UID}:${CONTAINER_DATA_GID}`;
}

/**
 * Translate an agent-visible owner to the container-side `uid:gid` for
 * Docker's `User`. An owner below the offset predates remapping (or was
 * written by a misconfigured tool); the canonical data owner is the only
 * sensible answer for it. `ensureServerDataDir` will have healed the actual
 * files by the time a container starts.
 */
export function containerOwnerForHost(
  hostUid: number,
  hostGid: number,
  offsets: UsernsOffsets,
): string {
  const uid = hostUid - offsets.uid;
  const gid = hostGid - offsets.gid;
  if (uid < 0 || gid < 0) return `${CONTAINER_DATA_UID}:${CONTAINER_DATA_GID}`;
  return `${uid}:${gid}`;
}

/**
 * Best-effort chown of an agent-written path to a container-side owner.
 *
 * No-op when the effective offset is zero: the agent's own uid then *is* the
 * container-side view, which is exactly the pre-remap behaviour. Under a
 * nonzero offset every file the agent creates (editor save, upload, SFTP
 * write, staged dump) is owned by the agent's host uid, which is unmapped in
 * the container's namespace. The game could read it at best and never write
 * or delete it. Chowning to `offset + containerUid` puts it in range.
 *
 * Failures are swallowed after a one-line log: the write this trails already
 * succeeded, and a chown the agent lacks privilege for is a boot-reported
 * misconfiguration (non-root agent on a remapped node), not a reason to fail
 * the user's save.
 */
export async function alignOwnership(
  client: Docker,
  path: string,
  options: {
    containerUid?: number;
    containerGid?: number;
    recursive?: boolean;
  } = {},
): Promise<void> {
  const offsets = await usernsOffsets(client);
  if (offsets.uid === 0 && offsets.gid === 0) return;

  const uid = offsets.uid + (options.containerUid ?? CONTAINER_DATA_UID);
  const gid = offsets.gid + (options.containerGid ?? CONTAINER_DATA_GID);

  try {
    if (options.recursive) {
      await chownTree(path, uid, gid);
    } else {
      // lchown, not chown: the path may be a symlink a tenant planted, and
      // following it would re-own something outside the tree being aligned.
      await lchown(path, uid, gid);
    }
  } catch (error) {
    console.error(
      `[agent] could not align ownership of ${path} to ${uid}:${gid}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Recursive lchown. Depth-first with the same bounded-parallelism shape as the
 * disk-usage walker in `servers.ts`; never follows symlinks.
 */
async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  await lchown(path, uid, gid);

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return; // not a directory
  }

  await Promise.all(
    entries.map(async (entry) => {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        await chownTree(full, uid, gid);
      } else {
        await lchown(full, uid, gid).catch(() => undefined);
      }
    }),
  );
}

/**
 * Log the remap state at boot, and the one misconfiguration worth shouting
 * about: a remapped daemon with a non-root host-side agent, which can neither
 * chown data into the subordinate range nor read what containers write there.
 */
export async function reportUsernsAtBoot(client: Docker): Promise<void> {
  const state = await detectUserns(client);

  if (!state.daemonRemapActive) {
    console.log(
      "[agent] docker userns-remap: off (container uid 0 is host uid 0; " +
        "see docs/node-hardening.md for how to enable remapping)",
    );
    return;
  }

  if (state.error) {
    console.error(`[agent] docker userns-remap: ${state.error}`);
    return;
  }

  console.log(
    `[agent] docker userns-remap: on (effective uid offset ${state.offsets.uid}, ` +
      `gid offset ${state.offsets.gid})`,
  );

  if (state.offsets.uid > 0 && process.getuid?.() !== 0) {
    console.error(
      `[agent] userns-remap is active but the agent runs as uid ${process.getuid?.()}, ` +
        "not root. It cannot chown server data into the subordinate range or read " +
        "files containers create there. Run the agent as root on remapped nodes.",
    );
  }
}
