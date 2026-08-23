import { describe, expect, test } from "bun:test";

import {
  computeBlockIoBytes,
  computeMemoryUsageMb,
  computeNetworkBytes,
  cpuPercentBetween,
  normalizeStats,
  readCpuCounters,
} from "./stats";

const MB = 1024 * 1024;

describe("readCpuCounters", () => {
  test("reads the cumulative counters and the core count", () => {
    expect(
      readCpuCounters({
        cpu_stats: {
          cpu_usage: { total_usage: 500 },
          system_cpu_usage: 9_000,
          online_cpus: 8,
        },
      }),
    ).toEqual({ total: 500, system: 9_000, cpuCount: 8 });
  });

  test("falls back to the per-CPU array length when online_cpus is absent", () => {
    const counters = readCpuCounters({
      cpu_stats: {
        cpu_usage: { total_usage: 1, percpu_usage: [1, 2, 3, 4] },
        system_cpu_usage: 2,
      },
    });
    expect(counters.cpuCount).toBe(4);
  });

  test("defaults to a single core when the payload says nothing", () => {
    expect(readCpuCounters({}).cpuCount).toBe(1);
  });
});

describe("cpuPercentBetween", () => {
  test("one fully saturated core reads as 100%", () => {
    // The container consumed 1/4 of the host's total CPU time across 4 cores.
    const percent = cpuPercentBetween(
      { total: 0, system: 0, cpuCount: 4 },
      { total: 250, system: 1_000, cpuCount: 4 },
    );
    expect(percent).toBeCloseTo(100, 6);
  });

  test("scales past 100% for a container using more than one core", () => {
    const percent = cpuPercentBetween(
      { total: 0, system: 0, cpuCount: 4 },
      { total: 500, system: 1_000, cpuCount: 4 },
    );
    expect(percent).toBeCloseTo(200, 6);
  });

  test("an idle container reads as 0%", () => {
    expect(
      cpuPercentBetween(
        { total: 100, system: 5_000, cpuCount: 2 },
        { total: 100, system: 6_000, cpuCount: 2 },
      ),
    ).toBe(0);
  });

  test("two readings taken at the same instant yield 0 rather than Infinity", () => {
    expect(
      cpuPercentBetween(
        { total: 100, system: 5_000, cpuCount: 2 },
        { total: 100, system: 5_000, cpuCount: 2 },
      ),
    ).toBe(0);
  });

  test("a restarted container (counter went backwards) yields 0, not a negative", () => {
    // The container's counter resets on restart while the host's keeps climbing,
    // so the pair spans two different processes and means nothing.
    expect(
      cpuPercentBetween(
        { total: 9_000, system: 5_000, cpuCount: 2 },
        { total: 10, system: 6_000, cpuCount: 2 },
      ),
    ).toBe(0);
  });
});

describe("computeMemoryUsageMb", () => {
  test("subtracts page cache, which Docker counts as usage", () => {
    const mb = computeMemoryUsageMb({
      memory_stats: { usage: 100 * MB, stats: { inactive_file: 40 * MB } },
    });
    expect(mb).toBeCloseTo(60, 6);
  });

  test("falls back to `cache` when `inactive_file` is absent", () => {
    const mb = computeMemoryUsageMb({
      memory_stats: { usage: 100 * MB, stats: { cache: 25 * MB } },
    });
    expect(mb).toBeCloseTo(75, 6);
  });

  test("never reports negative usage", () => {
    const mb = computeMemoryUsageMb({
      memory_stats: { usage: 10 * MB, stats: { inactive_file: 40 * MB } },
    });
    expect(mb).toBe(0);
  });
});

describe("computeNetworkBytes", () => {
  test("sums every interface", () => {
    expect(
      computeNetworkBytes({
        networks: {
          eth0: { rx_bytes: 10, tx_bytes: 1 },
          eth1: { rx_bytes: 5, tx_bytes: 2 },
        },
      }),
    ).toEqual({ rx: 15, tx: 3 });
  });

  test("a container with no interfaces reads as zero", () => {
    expect(computeNetworkBytes({})).toEqual({ rx: 0, tx: 0 });
  });
});

describe("computeBlockIoBytes", () => {
  test("sums by operation, ignoring the ops we do not report", () => {
    expect(
      computeBlockIoBytes({
        blkio_stats: {
          io_service_bytes_recursive: [
            { op: "Read", value: 100 },
            { op: "read", value: 50 },
            { op: "Write", value: 7 },
            { op: "Sync", value: 999 },
          ],
        },
      }),
    ).toEqual({ read: 150, write: 7 });
  });

  test("tolerates the null cgroup v2 sometimes reports", () => {
    expect(
      computeBlockIoBytes({
        blkio_stats: { io_service_bytes_recursive: null },
      }),
    ).toEqual({ read: 0, write: 0 });
  });
});

describe("normalizeStats", () => {
  test("takes the CPU percentage from the caller and derives the rest", () => {
    const stats = normalizeStats(
      "abc123",
      {
        memory_stats: { usage: 512 * MB, limit: 1024 * MB },
        pids_stats: { current: 12 },
      },
      42.5,
    );

    expect(stats.containerId).toBe("abc123");
    expect(stats.cpuPercent).toBe(42.5);
    expect(stats.memoryUsageMb).toBeCloseTo(512, 6);
    expect(stats.memoryLimitMb).toBeCloseTo(1024, 6);
    expect(stats.memoryPercent).toBeCloseTo(50, 6);
    expect(stats.pids).toBe(12);
    // Filled in by the caller, which knows the data directory.
    expect(stats.diskUsageMb).toBe(0);
  });

  test("an unlimited container reports 0% rather than dividing by zero", () => {
    const stats = normalizeStats("abc123", {
      memory_stats: { usage: 512 * MB, limit: 0 },
    }, 0);
    expect(stats.memoryPercent).toBe(0);
  });
});
