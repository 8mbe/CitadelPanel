/**
 * Per-node database setup, from the node's own shell.
 *
 * The panel can do this with one button (the node's admin page → Shared
 * database → "Set up database"), which is the path to prefer: it stores the
 * generated root password encrypted for you, so there is nothing to copy and
 * nothing to lose. This script exists for the cases where the panel is not the
 * one asking: bringing a node up before it is registered, or recovering one
 * whose stored credentials are gone.
 *
 * It is a thin CLI over `src/docker/nodeDb.ts`, the same code the agent's
 * `/v1/database/setup` route runs, so the button and the script cannot drift.
 * What that module creates:
 *
 *   1. The `node_db_net` bridge, with inter-container communication ENABLED so
 *      server containers on it can reach MariaDB. Tenant isolation comes from
 *      MariaDB's per-database user grants, not the bridge.
 *   2. A named volume for the data directory, so the container is disposable.
 *   3. A MariaDB container with no published host ports, reachable only from
 *      `node_db_net`, plus the panel's own admin account inside it.
 *
 * Idempotent, with one caveat: this script generates a fresh account each run,
 * and an existing container will not accept it. Re-running against a container
 * this script already created therefore reports the mismatch and tells you what
 * to do, rather than recreating anything. (The panel's button does not have that
 * problem: it presents the credential it already stored.)
 *
 * Usage:
 *   bun run scripts/setup-node-db.ts
 *
 * Environment overrides (all shared with the agent, see src/config.ts):
 *   NODE_DB_NETWORK    (default: node_db_net)          Docker network name
 *   NODE_DB_CONTAINER  (default: citadel-node-db)      Container name
 *   NODE_DB_VOLUME     (default: citadel-node-db-data)  Data volume name
 *   NODE_DB_IMAGE      (default: mariadb:11)           Image to pull
 */

import { randomBytes } from "node:crypto";
import { config } from "../src/config";
import { generateRootPassword, setUpNodeDb } from "../src/docker/nodeDb";

async function main(): Promise<void> {
  console.log("=== CitadelPanel node database setup ===\n");
  console.log(`Network:   ${config.nodeDbNetwork}`);
  console.log(`Container: ${config.nodeDbContainer}`);
  console.log(`Volume:    ${config.nodeDbVolume}`);
  console.log(`Image:     ${config.nodeDbImage}\n`);
  console.log("Creating (first boot initialises MariaDB, ~20s)…");

  // A generated account rather than root, matching what the panel's button
  // creates. The name carries randomness so two nodes never share one.
  const admin = {
    user: `citadel_${randomBytes(4).toString("hex")}`,
    password: generateRootPassword(32),
  };
  const status = await setUpNodeDb(admin);

  console.log("\n=== Node database ready ===\n");
  console.log("Enter these values when registering the node in the panel:\n");
  console.log(
    `  dbAdminHost:     ${
      status.host ??
      `(could not resolve IP, check "docker network inspect ${status.networkName}")`
    }`,
  );
  console.log(`  dbAdminPort:     ${status.port}`);
  console.log(`  dbAdminUser:     ${admin.user}`);
  console.log(`  dbAdminPassword: ${admin.password}`);
  console.log("\n  ⚠  Copy the password now. It is NOT stored by this script and");
  console.log("     cannot be recovered. The panel encrypts it on registration.");
  console.log("");
}

main().catch((error) => {
  console.error("\n✗ Setup failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
