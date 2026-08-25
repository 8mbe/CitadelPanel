import { describe, expect, test } from "bun:test";

import { rotate, runWithBudget } from "./boundedWork";

describe("rotate", () => {
  test("starts the queue at the offset and wraps", () => {
    expect(rotate([1, 2, 3, 4], 0)).toEqual([1, 2, 3, 4]);
    expect(rotate([1, 2, 3, 4], 2)).toEqual([3, 4, 1, 2]);
    expect(rotate([1, 2, 3, 4], 6)).toEqual([3, 4, 1, 2]);
    expect(rotate([], 3)).toEqual([]);
  });
});

describe("runWithBudget", () => {
  test("runs every job when the deadline is out of reach", async () => {
    const seen: number[] = [];
    const resumeAt = await runWithBudget([1, 2, 3, 4, 5], {
      concurrency: 2,
      startDeadlineAt: Infinity,
      run: async (job) => void seen.push(job),
    });

    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(resumeAt).toBe(5);
  });

  test("never has more than `concurrency` jobs in flight", async () => {
    let inFlight = 0;
    let peak = 0;

    await runWithBudget([1, 2, 3, 4, 5, 6, 7, 8], {
      concurrency: 3,
      startDeadlineAt: Infinity,
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
    });

    expect(peak).toBe(3);
  });

  test("stops starting jobs at the deadline and says where to resume", async () => {
    // A clock the test drives: every job costs 10 units, deadline at 25.
    let clock = 0;
    const seen: number[] = [];
    let deferred = -1;

    const resumeAt = await runWithBudget([1, 2, 3, 4, 5, 6], {
      concurrency: 1,
      startDeadlineAt: 25,
      now: () => clock,
      onDeferred: (count) => {
        deferred = count;
      },
      run: async (job) => {
        seen.push(job);
        clock += 10;
      },
    });

    // Started at 0, 10 and 20; the fourth check sees 30 and gives up.
    expect(seen).toEqual([1, 2, 3]);
    expect(resumeAt).toBe(3);
    expect(deferred).toBe(3);
  });

  test("the next pass covers what the previous one deferred", async () => {
    const jobs = [1, 2, 3, 4, 5, 6];
    let clock = 0;
    const firstPass: number[] = [];

    const resumeAt = await runWithBudget(jobs, {
      concurrency: 1,
      startDeadlineAt: 25,
      now: () => clock,
      run: async (job) => {
        firstPass.push(job);
        clock += 10;
      },
    });

    const secondPass: number[] = [];
    await runWithBudget(rotate(jobs, resumeAt), {
      concurrency: 1,
      startDeadlineAt: Infinity,
      run: async (job) => void secondPass.push(job),
    });

    expect(firstPass).toEqual([1, 2, 3]);
    // The deferred tail is asked first, which is the whole point: the same
    // nodes must not be the ones dropped every time.
    expect(secondPass.slice(0, 3)).toEqual([4, 5, 6]);
  });

  test("an empty queue is a no-op, not a crash", async () => {
    expect(await runWithBudget([], { concurrency: 4, startDeadlineAt: 0, run: async () => {} })).toBe(0);
  });
});
