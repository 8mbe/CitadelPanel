/**
 * The userns translation layer is pure arithmetic over three inputs (daemon
 * base, agent's own namespace base, canonical data owner), and every consumer
 * — data-dir ownership, Docker `User`, chown targets — trusts it blindly. So
 * the arithmetic is what gets pinned here, plus the detection parsers for the
 * two /proc- and API-shaped inputs they read.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  __setDetectedUserns,
  computeEffectiveOffsets,
  containerOwnerForHost,
  defaultRunAsUser,
  parseIdMapBase,
  parseRemapBaseFromRootDir,
} from "./userns";
import type Docker from "dockerode";

// defaultRunAsUser only consults the memoized detection, so a client that
// throws on contact proves no daemon call happens once the seam is set.
const unreachableDocker = new Proxy({} as Docker, {
  get() {
    throw new Error("the daemon must not be contacted when detection is seeded");
  },
});

afterEach(() => __setDetectedUserns(null));

describe("parseIdMapBase", () => {
  test("identity mapping (host process) parses to 0", () => {
    expect(parseIdMapBase("         0          0 4294967295\n")).toBe(0);
  });

  test("remapped process reports its subordinate base", () => {
    expect(parseIdMapBase("         0     231072      65536\n")).toBe(231072);
  });

  test("only the mapping containing id 0 counts", () => {
    const map = "      1000     100000      1\n         0     231072      65536\n";
    expect(parseIdMapBase(map)).toBe(231072);
  });

  test("an unreadable or empty map is treated as identity", () => {
    expect(parseIdMapBase("")).toBe(0);
    expect(parseIdMapBase("garbage")).toBe(0);
  });
});

describe("parseRemapBaseFromRootDir", () => {
  test("extracts the uid.gid suffix a remapped daemon appends", () => {
    expect(parseRemapBaseFromRootDir("/var/lib/docker/231072.231072")).toEqual({
      uid: 231072,
      gid: 231072,
    });
  });

  test("tolerates a trailing slash and distinct uid/gid", () => {
    expect(parseRemapBaseFromRootDir("/data/docker/100000.100500/")).toEqual({
      uid: 100000,
      gid: 100500,
    });
  });

  test("a plain daemon root dir yields null, not a guessed base", () => {
    expect(parseRemapBaseFromRootDir("/var/lib/docker")).toBeNull();
    expect(parseRemapBaseFromRootDir("")).toBeNull();
  });

  test("a version-like directory name is not mistaken for a base", () => {
    // Only <digits>.<digits> as the final component counts.
    expect(parseRemapBaseFromRootDir("/var/lib/docker-24.0/data")).toBeNull();
  });
});

describe("computeEffectiveOffsets", () => {
  test("host-side agent next to a remapped daemon sees the full shift", () => {
    expect(
      computeEffectiveOffsets({ uid: 231072, gid: 231072 }, { uid: 0, gid: 0 }),
    ).toEqual({ uid: 231072, gid: 231072 });
  });

  test("agent inside a remapped container sees no shift — ids already align", () => {
    expect(
      computeEffectiveOffsets({ uid: 231072, gid: 231072 }, { uid: 231072, gid: 231072 }),
    ).toEqual({ uid: 0, gid: 0 });
  });

  test("an agent in a deeper namespace clamps to zero instead of underflowing", () => {
    expect(
      computeEffectiveOffsets({ uid: 100000, gid: 100000 }, { uid: 200000, gid: 200000 }),
    ).toEqual({ uid: 0, gid: 0 });
  });
});

describe("containerOwnerForHost", () => {
  test("no remap: host ids pass through unchanged (pre-remap behaviour)", () => {
    expect(containerOwnerForHost(1000, 1000, { uid: 0, gid: 0 })).toBe("1000:1000");
    expect(containerOwnerForHost(0, 0, { uid: 0, gid: 0 })).toBe("0:0");
  });

  test("remap: the shifted host owner translates back to container-side ids", () => {
    expect(containerOwnerForHost(232072, 232072, { uid: 231072, gid: 231072 })).toBe(
      "1000:1000",
    );
  });

  test("an owner below the shift range falls back to the canonical data owner", () => {
    // A directory still owned by a pre-remap uid: ensureServerDataDir heals the
    // files; the container must be pointed at the owner they are healed to.
    expect(containerOwnerForHost(1000, 1000, { uid: 231072, gid: 231072 })).toBe(
      "1000:1000",
    );
  });
});

describe("defaultRunAsUser", () => {
  test("no remap: undefined, so the image's own USER stands", async () => {
    __setDetectedUserns({ daemonRemapActive: false, offsets: { uid: 0, gid: 0 } });
    expect(await defaultRunAsUser(unreachableDocker)).toBeUndefined();
  });

  test("remap: pins the canonical data owner", async () => {
    __setDetectedUserns({
      daemonRemapActive: true,
      offsets: { uid: 231072, gid: 231072 },
    });
    expect(await defaultRunAsUser(unreachableDocker)).toBe("1000:1000");
  });
});
