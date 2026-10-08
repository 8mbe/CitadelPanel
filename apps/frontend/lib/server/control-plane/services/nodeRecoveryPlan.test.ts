import { describe, expect, test } from "bun:test";
import type { DiscoveredServer } from "../nodes/nodeRecoveryApi";
import { legacyRecoveryBlueprint, recoveryBlueprintSignature, recoveryPorts, recoveryStatus } from "./nodeRecoveryPlan";
import { interpolateCommand } from "../blueprints/types";

const server: DiscoveredServer = {
  serverId: "12345678-1234-1234-1234-123456789abc", containerId: "container", state: "running",
  dataPresent: true, source: "container", spec: { image: "game:stable", containerDataPath: "/data",
    env: { PASSWORD: "private", SERVER_PORT: "25565" }, cpuLimit: 1, memoryLimitMb: 1024,
    ports: [{ hostPort: 25565, containerPort: 25565, protocol: "tcp" }, { hostPort: 25565, containerPort: 25565, protocol: "udp" }],
    command: ["/bin/sh", "-c", "printf '%s' \"hello\""], user: "1000:1000", tty: true },
};

describe("node recovery decisions", () => {
  test("blueprint equality includes install and plugin behavior", () => {
    const blueprint = legacyRecoveryBlueprint(server);
    expect(recoveryBlueprintSignature({ ...blueprint, name: "A new display name" })).toBe(recoveryBlueprintSignature(blueprint));
    expect(recoveryBlueprintSignature({ ...blueprint, install: { image: "installer", script: "echo updated" } })).not.toBe(recoveryBlueprintSignature(blueprint));
    expect(recoveryBlueprintSignature({ ...blueprint, stopCommand: "quit" })).not.toBe(recoveryBlueprintSignature(blueprint));
  });
  test("collapses dual bindings without changing port identity", () => {
    expect(recoveryPorts(server)).toEqual([{ hostPort: 25565, isPrimary: true, isAdditional: false, label: null }]);
  });
  test("rejects runtime mappings the panel cannot preserve", () => {
    expect(() => recoveryPorts({ ...server, spec: { ...server.spec, ports: [{ hostPort: 25565, containerPort: 12345, protocol: "tcp" }] } })).toThrow("cannot preserve");
    expect(() => recoveryPorts({ ...server, spec: { ...server.spec, ports: [server.spec.ports[0]!] } })).toThrow("both TCP and UDP");
  });
  test("does not silently change mismatched remembered ports", () => {
    const recovery = { name: "game", ownerId: "owner", ownerEmail: "owner@example.com", blueprint: legacyRecoveryBlueprint(server),
      diskLimitMb: 1024, secretEnvKeys: ["PASSWORD"], ports: [{ hostPort: 25566, isPrimary: true, isAdditional: false }] };
    expect(() => recoveryPorts({ ...server, recovery })).toThrow("do not match");
  });
  test("retains suspension even when Docker reports running", () => {
    const recovery = { name: "game", ownerId: "owner", ownerEmail: "owner@example.com", blueprint: legacyRecoveryBlueprint(server),
      diskLimitMb: 1024, secretEnvKeys: [], ports: recoveryPorts(server), status: "suspended" };
    expect(recoveryStatus({ ...server, recovery })).toBe("suspended");
    expect(recoveryStatus({ ...server, state: "missing" })).toBe("stopped");
    expect(recoveryStatus({ ...server, dataPresent: false })).toBe("error");
  });
  test("legacy recovery has no install recipe and masks unknown env secrets", async () => {
    const blueprint = legacyRecoveryBlueprint(server);
    expect(blueprint.install).toBeUndefined();
    expect(blueprint.envSchema.PASSWORD?.secret).toBe(true);
    expect(blueprint.user).toBe("1000:1000");
    const output = await Bun.$`sh -c ${blueprint.startupCommand!}`.quiet().text();
    expect(output).toBe("hello");
  });
  test("preserves literal template text in recovered command arguments", async () => {
    const blueprint = legacyRecoveryBlueprint({ ...server, spec: { ...server.spec,
      command: ["/bin/sh", "-c", "printf '%s' '{{PASSWORD}}'"] } });
    const command = interpolateCommand(blueprint.startupCommand!, { PASSWORD: "private" });
    expect(await Bun.$`sh -c ${command}`.quiet().text()).toBe("{{PASSWORD}}");
  });
});
