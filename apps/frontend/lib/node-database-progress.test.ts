/**
 * The phase mapping is the whole basis of what an operator is told during a
 * minute-long setup, so it is worth pinning: a wrong phase here is a UI that
 * says "downloading" while the database is already up, which is how progress
 * output loses its credibility.
 */

import { describe, expect, test } from "bun:test";
import { nodeDatabasePhase, nodeDatabasePhaseLabel } from "./node-database-progress";
import type { NodeDatabaseStatus } from "./types";

const base: NodeDatabaseStatus = {
  exists: true,
  state: "running",
  ready: true,
  host: "172.18.0.2",
  port: 3306,
  containerName: "citadel-node-db",
  networkName: "node_db_net",
  volumeName: "citadel-node-db-data",
  image: "mariadb:11",
};

describe("nodeDatabasePhase", () => {
  test("not asked yet reads as the image pull, the first thing that happens", () => {
    expect(nodeDatabasePhase(null)).toBe("pulling");
    expect(nodeDatabasePhase(undefined)).toBe("pulling");
  });

  test("no container yet means the image is still coming down", () => {
    expect(nodeDatabasePhase({ ...base, exists: false, state: null, ready: false })).toBe(
      "pulling",
    );
  });

  test("a created-but-not-running container is starting", () => {
    expect(nodeDatabasePhase({ ...base, state: "created", ready: false })).toBe(
      "starting",
    );
    expect(nodeDatabasePhase({ ...base, state: "exited", ready: false })).toBe(
      "starting",
    );
  });

  test("running without answering is the first-boot initialisation", () => {
    expect(nodeDatabasePhase({ ...base, ready: false })).toBe("initialising");
  });

  test("answering as the panel's account is done", () => {
    expect(nodeDatabasePhase(base)).toBe("ready");
  });
});

describe("nodeDatabasePhaseLabel", () => {
  test("every phase has a sentence, and none of them is empty", () => {
    for (const phase of ["pulling", "starting", "initialising", "ready"] as const) {
      expect(nodeDatabasePhaseLabel(phase).length).toBeGreaterThan(10);
    }
  });

  test("the slow phase says so, because that is the one that looks stuck", () => {
    expect(nodeDatabasePhaseLabel("pulling")).toMatch(/30-60s/);
  });
});
