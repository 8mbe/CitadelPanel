import { expect, test } from "bun:test";

import { buildToolConfig } from "./toolContainer";
import { config } from "../config";

function spec(overrides: Partial<Parameters<typeof buildToolConfig>[0]> = {}) {
  return buildToolConfig({
    image: "restic/restic:0.19.1",
    command: ["snapshots", "--json"],
    env: { RESTIC_PASSWORD: "secret" },
    mounts: [
      { hostPath: "/srv/cache", containerPath: "/cache" },
      { hostPath: "/srv/data", containerPath: "/data", readOnly: true },
    ],
    timeoutMs: 1000,
    ...overrides,
  });
}

test("keeps the file-access capabilities a backup needs", () => {
  // Regression: with `CapDrop: ALL` alone, root inside the container cannot
  // write a host directory owned by the agent's user, so restic failed with
  // "open /cache/CACHEDIR.TAG: permission denied" before any backup started.
  const built = spec();
  expect(built.HostConfig?.CapDrop).toEqual(["ALL"]);
  expect(built.HostConfig?.CapAdd).toContain("DAC_OVERRIDE");
  expect(built.HostConfig?.CapAdd).toContain("CHOWN");
  expect(built.HostConfig?.CapAdd).toContain("FOWNER");
});

test("drops the dangerous capabilities", () => {
  const added = spec().HostConfig?.CapAdd ?? [];
  for (const capability of ["SYS_ADMIN", "NET_RAW", "SETUID", "SETGID", "MKNOD"]) {
    expect(added).not.toContain(capability);
  }
  expect(spec().HostConfig?.SecurityOpt).toEqual(["no-new-privileges"]);
});

test("labels and names the container so a leak is identifiable", () => {
  const first = spec();
  expect(first.Labels?.["citadel.tool"]).toBe("backup");
  // Not `citadel.managed`. That label means "a tenant's game server" and is
  // what the stats collector lists.
  expect(first.Labels?.["citadel.managed"]).toBeUndefined();
  expect(first.name).toMatch(/^citadel-backup-[0-9a-f]{8}$/);
  // Unique per call, or a second concurrent run would collide on the name.
  expect(spec().name).not.toBe(first.name);
});

test("binds mounts read-only only where asked, and publishes no ports", () => {
  const built = spec();
  expect(built.HostConfig?.Binds).toEqual(["/srv/cache:/cache", "/srv/data:/data:ro"]);
  expect(built.HostConfig?.PortBindings).toBeUndefined();
  expect(built.HostConfig?.NetworkMode).toBe(config.backupNetwork);
  // The exit code and log tail are read after the process exits, which an
  // auto-removing container makes impossible.
  expect(built.HostConfig?.AutoRemove).toBe(false);
});

test("passes the environment through and overrides the entrypoint on request", () => {
  expect(spec().Env).toEqual(["RESTIC_PASSWORD=secret"]);
  expect(spec().Entrypoint).toBeUndefined();
  expect(spec({ entrypoint: ["/bin/sh", "-c"] }).Entrypoint).toEqual(["/bin/sh", "-c"]);
});
