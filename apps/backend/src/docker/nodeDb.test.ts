/**
 * The node database's container and network specs are pure, so the properties
 * that make it safe are testable without a Docker daemon. Two of them would be
 * silent, remote-code-execution-grade regressions if someone "fixed" them:
 * publishing MariaDB on a host port, and turning ICC off on `node_db_net`
 * (which does not isolate tenants, it just stops every game server reaching its
 * own database).
 */

import { describe, expect, test } from "bun:test";
import {
  generateRootPassword,
  nodeDbContainerConfig,
  nodeDbNetworkConfig,
} from "./nodeDb";

/** A throwaway credential for the pure config builders; never a real one. */
const FAKE_ROOT_PW = "x".repeat(32);

const spec = {
  containerName: "citadel-node-db",
  image: "mariadb:11",
  networkName: "node_db_net",
  volumeName: "citadel-node-db-data",
  rootPassword: FAKE_ROOT_PW,
};

describe("nodeDbContainerConfig", () => {
  test("publishes no host ports", () => {
    const config = nodeDbContainerConfig(spec);
    expect(config.HostConfig?.PortBindings).toBeUndefined();
    expect(config.HostConfig?.PublishAllPorts).toBe(false);
    expect(config.ExposedPorts).toBeUndefined();
  });

  test("attaches only to the node DB network", () => {
    expect(nodeDbContainerConfig(spec).HostConfig?.NetworkMode).toBe("node_db_net");
  });

  test("keeps the data directory on the named volume", () => {
    expect(nodeDbContainerConfig(spec).HostConfig?.Binds).toEqual([
      "citadel-node-db-data:/var/lib/mysql",
    ]);
  });

  test("passes the root credential as MariaDB's init env var", () => {
    expect(nodeDbContainerConfig(spec).Env).toEqual([
      `MARIADB_ROOT_PASSWORD=${FAKE_ROOT_PW}`,
    ]);
  });

  test("comes back with the node, unlike a game container", () => {
    expect(nodeDbContainerConfig(spec).HostConfig?.RestartPolicy).toEqual({
      Name: "unless-stopped",
    });
  });

  test("caps its log growth", () => {
    expect(nodeDbContainerConfig(spec).HostConfig?.LogConfig).toEqual({
      Type: "json-file",
      Config: { "max-size": "10m", "max-file": "3" },
    });
  });
});

describe("nodeDbNetworkConfig", () => {
  test("enables ICC, or no server could reach the database", () => {
    const config = nodeDbNetworkConfig("node_db_net");
    expect(config.Options?.["com.docker.network.bridge.enable_icc"]).toBe("true");
  });

  test("is a managed bridge with outbound NAT", () => {
    const config = nodeDbNetworkConfig("node_db_net");
    expect(config.Driver).toBe("bridge");
    expect(config.Internal).toBe(false);
    expect(config.Options?.["com.docker.network.bridge.enable_ip_masquerade"]).toBe(
      "true",
    );
    expect(config.Labels?.["citadel.managed"]).toBe("true");
  });
});

describe("generateRootPassword", () => {
  test("is alphanumeric, so it is safe in MYSQL_PWD and in a shell", () => {
    expect(generateRootPassword(64)).toMatch(/^[A-Za-z0-9]{64}$/);
  });

  test("defaults long enough for the panel's 16-char floor", () => {
    expect(generateRootPassword().length).toBe(32);
  });

  test("does not repeat", () => {
    expect(generateRootPassword()).not.toBe(generateRootPassword());
  });
});
