/**
 * Unit tests for the Velocity blueprint.
 *
 * The Minecraft blueprints are plain data; this one carries an install script
 * whose output has to line up with the runtime env (the port variable, the
 * patch-definition path) and with what Velocity will accept at boot. Those
 * couplings are invisible to the type system and expensive to discover on a
 * real node, so they are pinned here.
 */

import { describe, expect, test } from "bun:test";

import { velocity } from "./velocity";
import { parsePluginSupport, resolvePluginSupport } from "../plugins";
import { primaryPort, resolveEnv } from "../types";

const script = velocity.install!.script;

describe("port handling", () => {
  test("the primary port env is panel-owned, not part of the schema", () => {
    expect(velocity.primaryPortEnv).toBe("CFG_PROXY_PORT");
    // Present in envSchema it would be editable by owners and injectable at
    // create time — the whole point of primaryPortEnv is that only the panel
    // writes it.
    expect(velocity.envSchema).not.toHaveProperty("CFG_PROXY_PORT");
  });

  test("the port env keeps the prefix the config patcher expands", () => {
    // `mc-image-helper patch` only substitutes placeholders for variables with
    // its --patch-env-prefix (default CFG_). Rename this without renaming the
    // placeholder and the bind silently stops tracking the allocation.
    expect(velocity.primaryPortEnv).toStartWith("CFG_");
  });

  test("one primary TCP port, Velocity's own default number", () => {
    expect(velocity.defaultPorts).toHaveLength(1);
    expect(primaryPort(velocity)).toEqual({
      container: 25565,
      protocol: "tcp",
      primary: true,
    });
  });
});

describe("install script", () => {
  test("writes the patch file the runtime container is pointed at", () => {
    const target = velocity.envSchema.PATCH_DEFINITIONS?.default;
    expect(target).toBe("/server/.citadel/velocity-bind.json");
    expect(script).toContain(`cat > ${target}`);
  });

  test("the bind patch reads the panel's port variable, unexpanded", () => {
    // The shell must leave this alone: the patcher expands it on every start,
    // which is what re-syncs a reallocated port into velocity.toml.
    expect(script).toContain(`"value": "0.0.0.0:\${${velocity.primaryPortEnv}}"`);
    expect(script).toContain('"path": "$.bind"');
  });

  test("seeds bind from the allocated port, expanded by the shell", () => {
    expect(script).toContain(`bind = "0.0.0.0:$${velocity.primaryPortEnv}"`);
  });

  test("seeds the two keys Velocity would otherwise default to bad examples", () => {
    // Without these, Velocity falls back to the packaged default config's
    // example forced hosts and "lobby" try-list and refuses to start:
    // "Your configuration is invalid."
    expect(script).toContain("servers = { try = [] }");
    expect(script).toContain("forced-hosts = {}");
  });

  test("generates a per-server forwarding secret, only when absent", () => {
    expect(script).toContain("if [ ! -f forwarding.secret ]");
    expect(script).toContain("/dev/urandom");
    // A trailing newline would end up part of the secret the owner pastes into
    // each backend, so the write must be exactly N bytes.
    expect(script).toContain("head -c 32 > forwarding.secret");
  });

  test("does not try to fix up ownership itself", () => {
    // The agent runs the install container as the data directory's owner, so
    // what the script writes is already owned by the uid the proxy and the
    // panel's file tools use. Working around that here — a chown it has no
    // CAP_CHOWN for, or a world-writable umask — would only widen the mode.
    expect(script).not.toContain("umask");
    expect(script).not.toContain("chown");
    expect(velocity.user).toBe("1000:1000");
  });
});

describe("environment", () => {
  test("defaults resolve to a Velocity proxy with panel-owned wiring", () => {
    const { values, secretKeys } = resolveEnv(velocity, {});
    expect(values.TYPE).toBe("VELOCITY");
    expect(values.PATCH_DEFINITIONS).toBe("/server/.citadel/velocity-bind.json");
    expect(values.SKIP_PRIVILEGE_DROP).toBe("true");
    expect(values.SKIP_CHOWN_DATA).toBe("true");
    expect(values.ENABLE_RCON).toBe("false");
    expect(secretKeys).toEqual([]);
  });

  test("the proxy software cannot be switched to another type", () => {
    expect(() => resolveEnv(velocity, { TYPE: "BUNGEECORD" })).toThrow(
      /must be one of/,
    );
  });

  test("a supplied forwarding secret is stored encrypted", () => {
    const { values, secretKeys } = resolveEnv(velocity, {
      VELOCITY_FORWARDING_SECRET: "shared-across-my-network",
    });
    expect(values.VELOCITY_FORWARDING_SECRET).toBe("shared-across-my-network");
    expect(secretKeys).toEqual(["VELOCITY_FORWARDING_SECRET"]);
  });
});

describe("plugins", () => {
  test("a static Velocity profile — nothing to switch on", () => {
    const support = resolvePluginSupport(velocity, resolveEnv(velocity, {}).values);
    expect(support).not.toBeNull();
    expect(support!.label).toBe("Plugins");
    expect(support!.directory).toBe("plugins");
    expect(support!.loaders).toEqual(["velocity"]);
    // MINECRAFT_VERSION defaults to the LATEST sentinel, which does not filter.
    expect(support!.gameVersion).toBeUndefined();
  });

  test("a concrete backend version drives compatibility filtering", () => {
    const env = resolveEnv(velocity, { MINECRAFT_VERSION: "1.21.1" }).values;
    expect(resolvePluginSupport(velocity, env)!.gameVersion).toBe("1.21.1");
  });

  test("the declaration passes the validation an import would apply", () => {
    // Modrinth's hosts are public, so the SSRF blocklist has nothing to say
    // here; what is under test is the shape (profile, facets, endpoints).
    const allowAll = () => false;
    expect(() =>
      parsePluginSupport(velocity.plugins, velocity.envSchema, allowAll),
    ).not.toThrow();
  });
});
