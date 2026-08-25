/**
 * Run a queue of jobs with bounded concurrency and a deadline for *starting*
 * new ones.
 *
 * Extracted from the abuse watcher's sweep because the interesting property is
 * hard to see inline and easy to get wrong: when a pass runs out of time, the
 * jobs it did not start have to be identifiable, so the next pass can begin
 * there instead of at the front. A sweep that always restarts at the front and
 * always runs out of time never looks at the tail of the fleet, which is a
 * permanent blind spot in the thing that watches for abuse.
 *
 * The deadline bounds when the last job *starts*, not when it ends, because
 * that is all a caller can enforce without abandoning work in flight. The
 * worst case is therefore the deadline plus one job's own timeout, which is how
 * the watcher picks both numbers.
 */
export interface BoundedWorkOptions<T> {
  /** How many jobs may be in flight at once. */
  concurrency: number;
  /**
   * Timestamp after which no further job is started. `Infinity` runs the whole
   * queue, for a caller that asked for completeness over promptness.
   */
  startDeadlineAt: number;
  /** The work itself. Must contain its own error handling: a rejection here stops the queue. */
  run: (job: T) => Promise<void>;
  /** Called once with the number of jobs abandoned, when the deadline hits. */
  onDeferred?: (count: number) => void;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * @returns the index of the first job that was never started, which is
 *   `jobs.length` when the queue finished.
 */
export async function runWithBudget<T>(
  jobs: T[],
  options: BoundedWorkOptions<T>,
): Promise<number> {
  const now = options.now ?? Date.now;

  // The shared cursor is the queue: every worker takes the next index, so a
  // slow job costs its own worker and nothing else. Safe without a lock
  // because the increment cannot be interrupted (single-threaded event loop).
  let next = 0;
  let deferred = false;

  const workers = Array.from(
    { length: Math.max(0, Math.min(options.concurrency, jobs.length)) },
    async () => {
      while (!deferred && next < jobs.length) {
        if (now() >= options.startDeadlineAt) {
          // Leave `next` where it is: it is the answer this function returns.
          options.onDeferred?.(jobs.length - next);
          deferred = true;
          return;
        }
        await options.run(jobs[next++]!);
      }
    },
  );
  await Promise.all(workers);

  return next;
}

/**
 * Rotate a queue so it starts at `offset`, wrapping.
 *
 * The companion to {@link runWithBudget}'s return value: a caller that stopped
 * at index N last time starts at N this time, and still visits everything.
 */
export function rotate<T>(items: T[], offset: number): T[] {
  if (items.length === 0) return [];
  const start = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}
