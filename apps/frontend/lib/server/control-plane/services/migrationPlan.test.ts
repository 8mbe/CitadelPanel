/**
 * Tests for the rules a migration is safe by.
 *
 * The interesting assertions are the refusals. A migration that goes ahead when
 * it should not stops somebody's game server and may fill a node's disk; the
 * checks below are the ones standing between those outcomes and an operator
 * clicking a button.
 */

import { describe, expect, test } from "bun:test";
import {
  changedPorts,
  formatBytes,
  keepablePorts,
  poolHasRoom,
  requiredFreeBytes,
  transferIsComplete,
  type PlannablePort,
} from "./migrationPlan";

const GB = 1024 ** 3;

function port(
  number: number,
  overrides: Partial<PlannablePort> = {},
): PlannablePort {
  return {
    port: number,
    isPrimary: false,
    isAdditional: false,
    label: null,
    ...overrides,
  };
}

describe("requiredFreeBytes", () => {
  test("a small server still demands the floor of headroom", () => {
    // 20% of 100 MB is 20 MB, which is not room for a game server to do
    // anything in. The floor is what stops a "successful" migration from
    // leaving a node one world-save away from a full disk.
    const required = requiredFreeBytes(100 * 1024 * 1024);
    expect(required).toBeGreaterThan(2 * GB);
  });

  test("a large server's headroom scales with it", () => {
    expect(requiredFreeBytes(100 * GB)).toBeCloseTo(120 * GB, -6);
  });

  test("an empty server still needs the floor", () => {
    expect(requiredFreeBytes(0)).toBe(2 * GB);
  });
});

describe("transferIsComplete", () => {
  test("an exact copy passes", () => {
    expect(transferIsComplete(10_000_000, 10_000_000)).toBe(true);
  });

  test("a slightly larger copy passes", () => {
    // Different block sizes and directory overhead at either end; a copy that
    // measures bigger is not evidence of anything wrong.
    expect(transferIsComplete(10_000_000, 10_400_000)).toBe(true);
  });

  test("a copy a fraction of a percent smaller passes", () => {
    expect(transferIsComplete(10_000_000, 9_990_000)).toBe(true);
  });

  test("a truncated copy fails", () => {
    // The case this exists for: `tar` extracts an archive cut at a member
    // boundary without complaining, and the only evidence is the size.
    expect(transferIsComplete(10_000_000, 6_000_000)).toBe(false);
  });

  test("nothing arriving for a non-empty source fails", () => {
    expect(transferIsComplete(10_000_000, 0)).toBe(false);
  });

  test("an empty source is satisfied by an empty destination", () => {
    expect(transferIsComplete(0, 0)).toBe(true);
  });
});

describe("keepablePorts", () => {
  const wanted = [port(25565, { isPrimary: true }), port(25570), port(25580)];

  test("keeps a number that is in the pool, unallocated and free on the host", () => {
    expect(
      keepablePorts(wanted, [25565, 25570, 25580], [], [25565, 25570, 25580]),
    ).toEqual([25565, 25570, 25580]);
  });

  test("drops a number the destination's pool does not contain", () => {
    expect(
      keepablePorts(wanted, [25565, 25570], [], [25565, 25570, 25580]),
    ).toEqual([25565, 25570]);
  });

  test("drops a number already allocated to another server there", () => {
    expect(
      keepablePorts(wanted, [25565, 25570, 25580], [25570], [25565, 25570, 25580]),
    ).toEqual([25565, 25580]);
  });

  test("drops a number held by a process the panel does not manage", () => {
    // Unallocated in the panel's own table and still not bindable: the host
    // check is not redundant with the allocation check.
    expect(
      keepablePorts(wanted, [25565, 25570, 25580], [], [25565, 25580]),
    ).toEqual([25565, 25580]);
  });
});

describe("poolHasRoom", () => {
  test("counts only what is not already allocated", () => {
    expect(poolHasRoom(2, [1, 2, 3], [1])).toBe(true);
    expect(poolHasRoom(3, [1, 2, 3], [1])).toBe(false);
  });

  test("an empty pool holds nothing", () => {
    // A node with no port pool cannot host servers at all, which is the same
    // rule provisioning applies.
    expect(poolHasRoom(1, [], [])).toBe(false);
  });
});

describe("changedPorts", () => {
  test("reports nothing when every number was kept", () => {
    const ports = [port(25565, { isPrimary: true }), port(25570)];
    expect(changedPorts(ports, ports)).toEqual([]);
  });

  test("pairs each reassignment with the number it replaced", () => {
    expect(
      changedPorts(
        [port(25565, { isPrimary: true }), port(25570)],
        [port(25565, { isPrimary: true }), port(25999)],
      ),
    ).toEqual([{ from: 25570, to: 25999, isPrimary: false }]);
  });

  test("flags a changed primary, which is the address players type", () => {
    const changes = changedPorts(
      [port(25565, { isPrimary: true })],
      [port(25999, { isPrimary: true })],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.isPrimary).toBe(true);
  });
});

describe("formatBytes", () => {
  test("picks a unit an operator can read at a glance", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4 * 1024 * 1024)).toBe("4 MB");
    expect(formatBytes(3 * GB)).toBe("3.0 GB");
  });
});
