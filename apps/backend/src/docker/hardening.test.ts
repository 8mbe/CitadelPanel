/**
 * Security-critical tests for the container hardening layer.
 *
 * These assert the guarantees promised in plan.md section 8. A regression here
 * silently weakens the isolation of every hosted server, so the assertions are
 * deliberately explicit about intent rather than just snapshotting the object.
 */

import { describe, expect, test } from "bun:test";
import {
  buildHardenedContainerConfig,
  buildIsolatedNetworkConfig,
  serverContainerName,
  serverNetworkName,
  type HardenedContainerSpec,
} from "./hardening";

const MB = 1024 * 1024;

function baseSpec(overrides: Partial<HardenedContainerSpec> = {}): HardenedContainerSpec {
  return {
    name: "citadel-test",
    image: "itzg/minecraft-server:latest",
    hostDataPath: "/var/lib/citadel/servers/abc",
    containerDataPath: "/data",
    env: { EULA: "TRUE", MEMORY: "2G" },
    ports: [{ hostPort: 25565, containerPort: 25565, protocol: "tcp" }],
    cpuLimit: 2,
    memoryLimitMb: 2048,
    networkName: "citadel_srv_abc",
    ...overrides,
  };
}

describe("privilege reduction", () => {
  test("never runs privileged and drops all capabilities", () => {
    const config = buildHardenedContainerConfig(baseSpec());

    expect(config.HostConfig?.Privileged).toBe(false);
    expect(config.HostConfig?.CapDrop).toEqual(["ALL"]);
    expect(config.HostConfig?.CapAdd).toEqual([]);
  });

  test("sets no-new-privileges so setuid binaries cannot escalate", () => {
    const config = buildHardenedContainerConfig(baseSpec());
    expect(config.HostConfig?.SecurityOpt).toContain("no-new-privileges");
  });

  test("does not share host PID, IPC, UTS or user namespaces", () => {
    const config = buildHardenedContainerConfig(baseSpec());

    expect(config.HostConfig?.PidMode).not.toBe("host");
    expect(config.HostConfig?.IpcMode).toBe("private");
    expect(config.HostConfig?.UTSMode).not.toBe("host");
    expect(config.HostConfig?.UsernsMode).not.toBe("host");
  });

  test("limits process count to blunt fork bombs", () => {
    const config = buildHardenedContainerConfig(baseSpec());
    expect(config.HostConfig?.PidsLimit).toBeGreaterThan(0);
  });

  test("pins the run-as user when a blueprint supplies one", () => {
    const config = buildHardenedContainerConfig(baseSpec({ user: "1000:1000" }));
    expect(config.User).toBe("1000:1000");
  });

  test("omits User by default so the image's own USER is used", () => {
    const config = buildHardenedContainerConfig(baseSpec());
    expect(config.User).toBeUndefined();
  });

  test("a pinned run-as user does not weaken the capability drop", () => {
    // Running non-root is a hardening win only if it does not buy back any
    // capabilities to do so. The itzg image's gosu/chown path is replaced by
    // the pin precisely so CapDrop can stay ALL.
    const config = buildHardenedContainerConfig(baseSpec({ user: "1000:1000" }));
    expect(config.HostConfig?.CapDrop).toEqual(["ALL"]);
    expect(config.HostConfig?.CapAdd).toEqual([]);
    expect(config.HostConfig?.SecurityOpt).toContain("no-new-privileges");
  });
});

describe("resource caps", () => {
  test("applies hard memory limit with swap disabled", () => {
    const config = buildHardenedContainerConfig(baseSpec({ memoryLimitMb: 4096 }));

    expect(config.HostConfig?.Memory).toBe(4096 * MB);
    // Memory === MemorySwap means the workload cannot spill past its cap.
    expect(config.HostConfig?.MemorySwap).toBe(config.HostConfig?.Memory);
  });

  test("translates fractional CPU limits into a quota over the period", () => {
    const config = buildHardenedContainerConfig(baseSpec({ cpuLimit: 1.5 }));

    const period = config.HostConfig?.CpuPeriod ?? 0;
    const quota = config.HostConfig?.CpuQuota ?? 0;
    expect(period).toBeGreaterThan(0);
    expect(quota / period).toBeCloseTo(1.5);
  });

  test("rejects unlimited CPU or memory", () => {
    expect(() => buildHardenedContainerConfig(baseSpec({ cpuLimit: 0 }))).toThrow(
      /cpuLimit/,
    );
    expect(() =>
      buildHardenedContainerConfig(baseSpec({ memoryLimitMb: 0 })),
    ).toThrow(/memoryLimitMb/);
  });
});

describe("networking", () => {
  test("attaches to the per-server network, never host networking", () => {
    const config = buildHardenedContainerConfig(
      baseSpec({ networkName: "citadel_srv_xyz" }),
    );

    expect(config.HostConfig?.NetworkMode).toBe("citadel_srv_xyz");
    expect(config.HostConfig?.NetworkMode).not.toBe("host");
  });

  test("refuses to build a spec without an explicit network", () => {
    expect(() => buildHardenedContainerConfig(baseSpec({ networkName: "" }))).toThrow(
      /networkName/,
    );
  });

  test("publishes only the declared ports", () => {
    const config = buildHardenedContainerConfig(
      baseSpec({
        ports: [
          { hostPort: 25565, containerPort: 25565, protocol: "tcp" },
          { hostPort: 19132, containerPort: 19132, protocol: "udp" },
        ],
      }),
    );

    expect(config.HostConfig?.PublishAllPorts).toBe(false);
    expect(config.HostConfig?.PortBindings).toEqual({
      "25565/tcp": [{ HostPort: "25565" }],
      "19132/udp": [{ HostPort: "19132" }],
    });
    expect(Object.keys(config.ExposedPorts ?? {})).toHaveLength(2);
  });

  test("rejects privileged host ports below 1024", () => {
    expect(() =>
      buildHardenedContainerConfig(
        baseSpec({ ports: [{ hostPort: 80, containerPort: 25565, protocol: "tcp" }] }),
      ),
    ).toThrow(/1024/);
  });

  test("keeps outbound internet access working for plugin and mod downloads", () => {
    // Regression guard for plan.md section 8: full egress blocking is NOT the
    // design. `Internal: true` would break plugin update checks.
    const network = buildIsolatedNetworkConfig("citadel_srv_abc");

    expect(network.Internal).toBe(false);
    expect(network.Options["com.docker.network.bridge.enable_ip_masquerade"]).toBe(
      "true",
    );
  });

  test("disables inter-container communication on managed networks", () => {
    const network = buildIsolatedNetworkConfig("citadel_srv_abc");
    expect(network.Options["com.docker.network.bridge.enable_icc"]).toBe("false");
  });
});

describe("filesystem", () => {
  test("bind-mounts exactly one writable data directory", () => {
    const config = buildHardenedContainerConfig(
      baseSpec({ hostDataPath: "/srv/data/abc", containerDataPath: "/data" }),
    );

    expect(config.HostConfig?.Binds).toEqual(["/srv/data/abc:/data:rw"]);
  });

  test("read-only rootfs adds a hardened tmpfs for scratch space", () => {
    const config = buildHardenedContainerConfig(
      baseSpec({ readOnlyRootFilesystem: true }),
    );

    expect(config.HostConfig?.ReadonlyRootfs).toBe(true);
    expect(config.HostConfig?.Tmpfs?.["/tmp"]).toContain("noexec");
    expect(config.HostConfig?.Tmpfs?.["/tmp"]).toContain("nosuid");
  });

  test("defaults to a writable rootfs for images that need it", () => {
    const config = buildHardenedContainerConfig(baseSpec());
    expect(config.HostConfig?.ReadonlyRootfs).toBe(false);
  });

  test("caps container log size so a node disk cannot be filled", () => {
    const config = buildHardenedContainerConfig(baseSpec());
    expect(config.HostConfig?.LogConfig?.Config?.["max-size"]).toBeDefined();
  });
});

describe("naming", () => {
  test("derives stable, distinct names from a server id", () => {
    const id = "3f8a1b2c-4d5e-4f60-8a71-9b2c3d4e5f60";

    expect(serverNetworkName(id)).toBe(serverNetworkName(id));
    expect(serverContainerName(id)).toBe(serverContainerName(id));
    expect(serverNetworkName(id)).not.toBe(serverContainerName(id));
  });
});

describe("environment and labels", () => {
  test("serialises env vars into Docker's KEY=VALUE form", () => {
    const config = buildHardenedContainerConfig(
      baseSpec({ env: { EULA: "TRUE", MEMORY: "2G" } }),
    );

    expect(config.Env).toContain("EULA=TRUE");
    expect(config.Env).toContain("MEMORY=2G");
  });

  test("labels containers as panel-managed for the watcher to discover", () => {
    const config = buildHardenedContainerConfig(baseSpec());
    expect(config.Labels?.["citadel.managed"]).toBe("true");
  });
});

describe("console attachment", () => {
  test("keeps stdin open so the console can send commands", () => {
    // Without OpenStdin the container has no stdin to attach to, and the
    // console silently becomes read-only — you can watch a server but never
    // type "stop" or "op someone".
    const config = buildHardenedContainerConfig(baseSpec());

    expect(config.OpenStdin).toBe(true);
    expect(config.AttachStdin).toBe(true);
    expect(config.StdinOnce).toBe(false);
  });

  test("does not allocate a TTY by default", () => {
    // Non-TTY is the safe default: stdout and stderr stay separately 8-byte
    // framed, which the attach and log-demux layers expect.
    const config = buildHardenedContainerConfig(baseSpec());
    expect(config.Tty).toBe(false);
  });

  test("allocates a TTY when the blueprint opts in", () => {
    // A TTY container merges stdout/stderr into a raw stream that carries the
    // server's own ANSI color codes — needed for software like JLine3 that
    // only emits color to a terminal. The attach layer detects this and reads
    // the stream without 8-byte framing.
    const config = buildHardenedContainerConfig(baseSpec({ tty: true }));
    expect(config.Tty).toBe(true);
  });
});
