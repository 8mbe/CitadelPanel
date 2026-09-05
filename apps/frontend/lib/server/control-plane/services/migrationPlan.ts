/**
 * The decisions a server migration makes, as pure functions.
 *
 * Same reasoning as `statusReconcile.ts`: `serverMigration.ts` connects to the
 * database at import time, so the parts of it that are actually *judgement* --
 * how much free space to insist on, when a copy counts as complete, which port
 * numbers can be carried over -- live here where they can be tested without a
 * database, two node agents and a world to copy.
 *
 * These are the rules a migration is safe or unsafe by. Everything else in
 * `serverMigration.ts` is sequencing and cleanup around them.
 */

/**
 * Free space the destination must have **beyond** the size of the world.
 *
 * A destination that ends a migration with 200 MB free has not gained a server,
 * it has gained an outage: the game writes as it runs, and a full data root
 * fails every write on that node, not just this server's. So the requirement is
 * the data plus headroom, and the headroom is proportional to what is being
 * placed with a floor under it, because 20% of a small server is not enough
 * room for anything to happen in.
 */
export const DISK_HEADROOM_FRACTION = 0.2;
export const DISK_HEADROOM_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;

/** Bytes the destination must have free to take a world of `dataSizeBytes`. */
export function requiredFreeBytes(dataSizeBytes: number): number {
  const size = Math.max(0, dataSizeBytes);
  return size + Math.max(size * DISK_HEADROOM_FRACTION, DISK_HEADROOM_FLOOR_BYTES);
}

/**
 * How much smaller than the source the destination's copy may measure before
 * the transfer is called a failure.
 *
 * Not zero, deliberately: `du` counts directory entries, and two filesystems do
 * not have to agree on what an inode costs, so an honest copy can measure a
 * little differently at either end. What this has to catch is a *truncated*
 * archive -- one cut at a member boundary, which `tar` extracts without
 * complaining -- and that is a loss measured in percent, not in kilobytes.
 */
export const SIZE_TOLERANCE_FRACTION = 0.02;

/**
 * Whether the copy that landed on the destination accounts for the source.
 *
 * A floor, not a band: a copy that measures *larger* than the source is fine
 * and happens routinely (different block sizes, different directory overhead),
 * and refusing it would fail migrations that worked perfectly.
 */
export function transferIsComplete(
  sourceBytes: number,
  destinationBytes: number,
): boolean {
  if (sourceBytes <= 0) return destinationBytes >= 0;
  return destinationBytes >= sourceBytes * (1 - SIZE_TOLERANCE_FRACTION);
}

/** One published port as a migration carries it. */
export interface PlannablePort {
  port: number;
  isPrimary: boolean;
  isAdditional: boolean;
  label: string | null;
}

/**
 * Which of a server's port numbers the destination can carry over unchanged.
 *
 * Keeping a number is worth real effort, and it is worth stating why, because
 * "just allocate fresh ones" looks simpler: a preserved port is a player
 * address that does not change, a config file nobody has to edit, and a
 * server-link peer that keeps working. Every reassigned number is churn in all
 * three, and the last one is not even the owner's server.
 *
 * A number is keepable when it is in the destination's pool, not already
 * allocated to another server there, and free on that host right now. All three
 * are necessary and none implies another: a pool entry can be fully allocated,
 * and an unallocated number can still be held by some process the panel does
 * not manage.
 */
export function keepablePorts(
  wanted: PlannablePort[],
  pool: number[],
  allocatedOnDestination: number[],
  freeOnHost: number[],
): number[] {
  const inPool = new Set(pool);
  const allocated = new Set(allocatedOnDestination);
  const free = new Set(freeOnHost);

  return wanted
    .map((entry) => entry.port)
    .filter((port) => inPool.has(port) && !allocated.has(port) && free.has(port));
}

/**
 * The port numbers that changed, paired old-to-new.
 *
 * Positional, because a migration plans the destination's ports by walking the
 * source's list in order and never reorders it: entry *i* on the destination is
 * entry *i* from the source, kept or reassigned. That is what makes "25565 →
 * 25578" a sentence somebody can act on rather than two unrelated lists.
 */
export function changedPorts(
  source: PlannablePort[],
  destination: PlannablePort[],
): { from: number; to: number; isPrimary: boolean }[] {
  const changes: { from: number; to: number; isPrimary: boolean }[] = [];
  for (const [index, entry] of destination.entries()) {
    const before = source[index];
    if (!before || before.port === entry.port) continue;
    changes.push({ from: before.port, to: entry.port, isPrimary: entry.isPrimary });
  }
  return changes;
}

/**
 * Whether the destination's pool can hold this server at all.
 *
 * Checked before anything is stopped, because "the destination ran out of
 * ports" is a fact about the node that is just as true while the server is
 * happily running, and finding it out afterwards costs an outage for nothing.
 */
export function poolHasRoom(
  wantedCount: number,
  pool: number[],
  allocatedOnDestination: number[],
): boolean {
  const allocated = new Set(allocatedOnDestination);
  return pool.filter((port) => !allocated.has(port)).length >= wantedCount;
}

/**
 * A byte count for an operator to read.
 *
 * Local to the migration rather than reusing the browser's `formatBytes`: these
 * strings go into the migration log and into API messages, which are written on
 * the server and read by whoever is on call.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
