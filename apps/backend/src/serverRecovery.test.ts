import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Docker from "dockerode";
import {
  discoverContainerSpec,
  listServerManifests,
  parseRecoveryMetadata,
  parseServerContainerRequest,
  readServerManifest,
  rememberedContainerIdentities,
  recoverySpecMatchesContainer,
  removeServerManifest,
  serverDataPresent,
  writeServerManifest,
  type ServerRecoveryMetadata,
} from "./serverRecovery";
import type { CreateContainerRequest } from "./servers";
import {
  buildHardenedContainerConfig,
  serverContainerName,
  serverNetworkName,
} from "./docker/hardening";

const serverId = "11111111-2222-3333-4444-555555555555";
const roots: string[] = [];
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "citadel-recovery-test-"));
  roots.push(root);
  return root;
}
afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

const spec: CreateContainerRequest = {
  image: "example/game:1",
  containerDataPath: "/data",
  env: { SERVER_PORT: "25565", PASSWORD: "node-local-secret" },
  ports: [
    { hostPort: 25565, containerPort: 25565, protocol: "tcp" },
    { hostPort: 25565, containerPort: 25565, protocol: "udp" },
  ],
  cpuLimit: 1.5,
  memoryLimitMb: 1024,
  command: ["/bin/sh", "-c", "exec game --name 'my server'"],
  user: "1000:1000",
  tty: true,
};
const recovery: ServerRecoveryMetadata = {
  name: "Existing game",
  ownerId: "owner-1",
  ownerEmail: "owner@example.test",
  blueprint: { key: "game", name: "Game", dockerImage: spec.image },
  diskLimitMb: 4096,
  ports: [
    { hostPort: 25565, isPrimary: true, isAdditional: false, label: null },
  ],
  secretEnvKeys: ["PASSWORD"],
  status: "suspended",
  suspensionReason: "Operator review",
};

function container(root: string): Docker.ContainerInspectInfo {
  return {
    Id: "container-1",
    Name: `/${serverContainerName(serverId)}`,
    Config: {
      Image: spec.image,
      Labels: { "citadel.managed": "true" },
      Env: ["SERVER_PORT=25565", "PASSWORD=value=with=equals"],
      Cmd: spec.command,
      User: spec.user,
      Tty: true,
    },
    Mounts: [
      { Type: "bind", Source: join(root, serverId), Destination: "/data" },
    ],
    HostConfig: {
      CpuQuota: 150000,
      CpuPeriod: 100000,
      Memory: 1024 * 1024 * 1024,
      PortBindings: {
        "25565/tcp": [{ HostPort: "25565", HostIp: "0.0.0.0" }],
        "25565/udp": [{ HostPort: "25565", HostIp: "" }],
      },
      ReadonlyRootfs: false,
    },
    NetworkSettings: {
      Networks: { [serverNetworkName(serverId)]: {}, node_db_net: {} },
    },
  } as unknown as Docker.ContainerInspectInfo;
}

describe("node inventory persistence", () => {
  test("keeps secrets private outside tenant files and atomically replaces a complete manifest", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, serverId));
    await writeServerManifest(serverId, { ...spec, recovery }, undefined, root);
    const initial = await readServerManifest(serverId, root);
    expect(initial?.recovery?.ownerEmail).toBe(recovery.ownerEmail);
    expect(initial?.spec.env.PASSWORD).toBe(spec.env.PASSWORD);
    expect(initial?.spec.recovery).toBeUndefined();
    expect((await stat(join(root, ".citadel"))).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(root, ".citadel", `${serverId}.json`))).mode & 0o777,
    ).toBe(0o600);
    expect(await readdir(join(root, serverId))).toEqual([]);

    await Promise.all(
      Array.from({ length: 10 }, (_, number) =>
        writeServerManifest(
          serverId,
          { ...spec, env: { REVISION: String(number) } },
          recovery,
          root,
        ),
      ),
    );
    const saved = await readServerManifest(serverId, root);
    expect(saved?.spec.env.REVISION).toMatch(/^[0-9]$/);
    expect(saved?.recovery?.status).toBe("suspended");
    expect(saved?.recovery?.suspensionReason).toBe("Operator review");
    expect(await readdir(join(root, ".citadel"))).toEqual([`${serverId}.json`]);
  });

  test("a corrupt record does not hide other remembered servers", async () => {
    const root = await temporaryRoot();
    await writeServerManifest(serverId, spec, recovery, root);
    const brokenId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await writeFile(join(root, ".citadel", `${brokenId}.json`), "{", {
      mode: 0o600,
    });
    const result = await listServerManifests(root);
    expect(result.manifests.map((manifest) => manifest.serverId)).toEqual([
      serverId,
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toContain("node-local-secret");
  });

  test("refuses symlinked metadata directories and records", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, ".citadel"));
    await expect(
      writeServerManifest(serverId, spec, recovery, root),
    ).rejects.toThrow(/real directory/);
    expect(await readdir(outside)).toEqual([]);
    await rm(join(root, ".citadel"));
    await mkdir(join(root, ".citadel"), { mode: 0o700 });
    const canary = join(outside, "canary");
    await writeFile(canary, "keep me", { mode: 0o600 });
    await symlink(canary, join(root, ".citadel", `${serverId}.json`));
    await expect(readServerManifest(serverId, root)).rejects.toThrow();
    // Atomic rename replaces a planted link rather than following it.
    await writeServerManifest(serverId, spec, recovery, root);
    expect(await readFile(canary, "utf8")).toBe("keep me");
  });

  test("requires a real data directory and clears forgotten server identity idempotently", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    expect(await serverDataPresent(serverId, root)).toBe(false);
    await symlink(outside, join(root, serverId));
    expect(await serverDataPresent(serverId, root)).toBe(false);
    await rm(join(root, serverId));
    await mkdir(join(root, serverId));
    expect(await serverDataPresent(serverId, root)).toBe(true);
    await writeServerManifest(serverId, spec, recovery, root);
    await removeServerManifest(serverId, root);
    await removeServerManifest(serverId, root);
    expect(await readServerManifest(serverId, root)).toBeNull();
    expect(await serverDataPresent(serverId, root)).toBe(true);
  });
});

describe("existing container discovery", () => {
  test("observes renamed or unlabelled workloads that already occupy remembered data", () => {
    const summary = {
      Names: ["/manually-renamed"],
      Labels: {},
      Mounts: [{ Type: "bind", Source: `/node/servers/${serverId}` }],
    } as Pick<Docker.ContainerInfo, "Names" | "Labels" | "Mounts">;
    expect(
      rememberedContainerIdentities(summary, [serverId], ["/node/servers"]),
    ).toEqual([serverId]);
    expect(
      rememberedContainerIdentities(
        {
          ...summary,
          Mounts: [],
          Names: [`/${serverContainerName(serverId)}`],
        },
        [serverId],
        ["/node/servers"],
      ),
    ).toEqual([serverId]);
    expect(
      rememberedContainerIdentities(
        { ...summary, Mounts: [], Labels: { "citadel.server-id": serverId } },
        [serverId],
        ["/node/servers"],
      ),
    ).toEqual([serverId]);
    expect(
      rememberedContainerIdentities(
        summary,
        [serverId],
        ["/different/servers"],
      ),
    ).toEqual([]);
    expect(
      rememberedContainerIdentities(
        {
          ...summary,
          Mounts: summary.Mounts.map((mount) => ({ ...mount, RW: false })),
        },
        [serverId],
        ["/node/servers"],
      ),
    ).toEqual([]);
  });
  test("recovers full UUID and runtime settings from a legacy container, without guessing its owner", () => {
    const found = discoverContainerSpec(
      container("/node/servers"),
      "/node/servers",
    );
    expect(found?.serverId).toBe(serverId);
    expect(found?.spec.command).toEqual(spec.command);
    expect(found?.spec.env.PASSWORD).toBe("value=with=equals");
    expect(found?.spec.cpuLimit).toBe(1.5);
    expect(found?.spec.memoryLimitMb).toBe(1024);
    expect(found?.spec.extraNetworks).toEqual(["node_db_net"]);
    expect(found?.spec.recovery).toBeUndefined();
    expect(found?.spec).not.toHaveProperty("hostDataPath");
  });

  test("new runtime labels keep the full identity without changing tenant hardening", () => {
    const configuration = buildHardenedContainerConfig({
      ...spec,
      name: serverContainerName(serverId),
      hostDataPath: `/node/servers/${serverId}`,
      networkName: serverNetworkName(serverId),
      serverId,
    });
    expect(configuration.Labels?.["citadel.server-id"]).toBe(serverId);
    expect(configuration.Labels?.["citadel.kind"]).toBe("server");
    expect(configuration.HostConfig?.Privileged).toBe(false);
    expect(configuration.HostConfig?.CapDrop).toEqual(["ALL"]);
  });

  test("skips unrelated workloads, installer names and identities that disagree with their bind mount", () => {
    for (const change of [
      (info: Docker.ContainerInspectInfo) => {
        info.Config.Labels = {};
      },
      (info: Docker.ContainerInspectInfo) => {
        info.Name = `/citadel-install-${serverId.slice(0, 12)}`;
      },
      (info: Docker.ContainerInspectInfo) => {
        info.Config.Labels["citadel.kind"] = "backup";
      },
      (info: Docker.ContainerInspectInfo) => {
        info.Config.Labels["citadel.server-id"] =
          "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      },
      (info: Docker.ContainerInspectInfo) => {
        info.Mounts[0]!.Source = `/node/servers-other/${serverId}`;
      },
      (info: Docker.ContainerInspectInfo) => {
        info.Mounts[0]!.Source = `/node/servers/${serverId.slice(0, 12)}`;
      },
      (info: Docker.ContainerInspectInfo) => {
        info.Mounts[0]!.Source = `/node/servers/other/../${serverId}`;
      },
    ]) {
      const info = container("/node/servers");
      change(info);
      expect(discoverContainerSpec(info, "/node/servers")).toBeNull();
    }
  });

  test("refuses non-identity ports, extra host mounts and uncapped legacy resources", () => {
    const info = container("/node/servers");
    info.HostConfig.PortBindings = { "25565/tcp": [{ HostPort: "25566" }] };
    expect(discoverContainerSpec(info, "/node/servers")).toBeNull();
    const mounted = container("/node/servers");
    mounted.Mounts.push({
      Type: "bind",
      Source: "/",
      Destination: "/host",
    } as (typeof mounted.Mounts)[number]);
    expect(discoverContainerSpec(mounted, "/node/servers")).toBeNull();
    const unlimited = container("/node/servers");
    unlimited.HostConfig.Memory = 0;
    expect(discoverContainerSpec(unlimited, "/node/servers")).toBeNull();
  });

  test("does not hide changed runtime ports, environment or resource caps behind a saved spec", () => {
    expect(recoverySpecMatchesContainer(spec, spec)).toBe(true);
    expect(
      recoverySpecMatchesContainer(spec, { ...spec, memoryLimitMb: 2048 }),
    ).toBe(false);
    expect(
      recoverySpecMatchesContainer(spec, {
        ...spec,
        env: { ...spec.env, SERVER_PORT: "25566" },
      }),
    ).toBe(false);
    expect(
      recoverySpecMatchesContainer(spec, {
        ...spec,
        ports: [{ hostPort: 25566, containerPort: 25566, protocol: "tcp" }],
      }),
    ).toBe(false);
    // Image defaults and subsequently attached link networks do not change a
    // panel-specified setting, and are normal additional Docker facts.
    expect(
      recoverySpecMatchesContainer(spec, {
        ...spec,
        env: { ...spec.env, IMAGE_DEFAULT: "1" },
        extraNetworks: ["citadel_link_peer"],
      }),
    ).toBe(true);
  });
});

test("the same runtime/recovery validation protects requests and persisted manifests", async () => {
  expect(() => parseServerContainerRequest({ ...spec, env: ["BAD"] })).toThrow(
    /env/,
  );
  expect(() =>
    parseServerContainerRequest({
      ...spec,
      ports: [{ hostPort: 80, containerPort: 80, protocol: "tcp" }],
    }),
  ).toThrow(/range/);
  expect(() => parseServerContainerRequest({ ...spec, user: "root" })).toThrow(
    /uid/,
  );
  expect(() => parseRecoveryMetadata({ ...recovery, ownerEmail: "" })).toThrow(
    /ownerEmail/,
  );
  expect(() => parseRecoveryMetadata({ ...recovery, backupLimit: -1 })).toThrow(
    /backupLimit/,
  );
  await expect(
    readServerManifest("../escape", "/node/servers"),
  ).rejects.toThrow(/UUID/);
});
