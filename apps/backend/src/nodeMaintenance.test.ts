import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Docker from "dockerode";
import { NodeMaintenance } from "./nodeMaintenance";
import { MaintenanceState } from "./maintenanceState";
import { allowedDuringNodeMaintenance } from "../../../shared/nodeMaintenance";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "citadel-maintenance-"));
  roots.push(root);
  const marker = join(root, "maintenance");
  const containers = [
    { Id: "game", State: "running", Labels: { "citadel.managed": "true" } },
    { Id: "install", State: "running", Labels: { "citadel.managed": "true" } },
    { Id: "db", State: "running", Labels: { "citadel.managed": "true", "citadel.role": "node-db" } },
    { Id: "restic", State: "running", Labels: { "citadel.tool": "backup" } },
    { Id: "paused", State: "paused", Labels: { "citadel.managed": "true" } },
    { Id: "stopped", State: "exited", Labels: { "citadel.managed": "true" } },
    { Id: "other", State: "running", Labels: {} },
  ];
  const events: string[] = [];
  const failures = new Set<string>();
  const client = {
    listContainers: async () => containers,
    getContainer: (id: string) => ({
      unpause: async () => { events.push(`unpause:${id}`); },
      stop: async ({ t }: { t: number }) => {
        expect(t).toBe(30);
        events.push(`stop:${id}`);
        if (failures.has(id)) throw new Error("Docker stop failed");
        containers.find((container) => container.Id === id)!.State = "exited";
      },
    }),
  } as unknown as Docker;
  const state = new MaintenanceState();
  return { marker, client, state, events, failures, control: new NodeMaintenance(client, marker, state) };
}

describe("node maintenance", () => {
  test("gracefully stops game, install, database, and backup containers, leaving unrelated workloads alone", async () => {
    const f = fixture();
    let closed = 0;
    f.state.onDrain(() => { closed += 1; });
    expect(await f.control.set(true)).toEqual({ maintenance: true, stopped: 5 });
    expect(f.state.enabled).toBe(true);
    expect(existsSync(f.marker)).toBe(true);
    expect(closed).toBe(1);
    expect(f.events.sort()).toEqual(["stop:db", "stop:game", "stop:install", "stop:paused", "stop:restic", "unpause:paused"]);
    expect(await f.control.set(true)).toEqual({ maintenance: true, stopped: 0 });
    expect(closed).toBe(1);
  });

  test("a failed stop does not abandon the others or reopen the node, and retry finishes the drain", async () => {
    const f = fixture();
    f.failures.add("game");
    await expect(f.control.set(true)).rejects.toThrow("some containers could not stop");
    expect(f.state.enabled).toBe(true);
    expect(existsSync(f.marker)).toBe(true);
    expect(f.events).toContain("stop:restic");
    f.failures.clear();
    expect((await f.control.set(true)).stopped).toBe(1);
  });

  test("an unreachable Docker daemon still leaves durable maintenance intent", async () => {
    const f = fixture();
    f.client.listContainers = async () => { throw new Error("daemon unavailable"); };
    await expect(f.control.set(true)).rejects.toThrow("daemon unavailable");
    expect(f.state.enabled).toBe(true);
    expect(new NodeMaintenance(f.client, f.marker, new MaintenanceState()).state.enabled).toBe(true);
  });

  test("a remembered drain blocks work at startup; activation removes it without starting anything", async () => {
    const f = fixture();
    writeFileSync(f.marker, "maintenance\n");
    const state = new MaintenanceState();
    const control = new NodeMaintenance(f.client, f.marker, state);
    expect(() => state.assertAvailable()).toThrow("maintenance");
    expect(await control.set(false)).toEqual({ maintenance: false, stopped: 0 });
    expect(existsSync(f.marker)).toBe(false);
    state.assertAvailable();
    expect(f.events).toEqual([]);
  });

  test("drain waits for a Docker launch already in flight and stops the raced container", async () => {
    const f = fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const launch = f.state.launch(() => waiting, async () => { f.events.push("stop:raced"); });
    // Attach the rejection handler before drain interrupts the start.
    const rejected = launch.catch((error: Error) => error);
    const drain = f.control.set(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.state.enabled).toBe(true);
    expect(f.events).toEqual([]);
    release();
    expect(await rejected).toBeInstanceOf(Error);
    expect((await rejected as Error).message).toContain("interrupted");
    await drain;
    expect(f.events).toContain("stop:raced");
  });

  test("activation waits for a queued drain to complete", async () => {
    const f = fixture();
    const drain = f.control.set(true);
    const activate = f.control.set(false);
    await drain;
    await activate;
    expect(f.state.enabled).toBe(false);
    expect(existsSync(f.marker)).toBe(false);
  });

  test("a cold image pull cannot resume old work after drain and activation", async () => {
    const state = new MaintenanceState();
    let release!: () => void;
    const pull = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const work = state.runWork(async () => {
      await pull;
      await state.launch(async () => { started = true; }, async () => {});
    });
    const rejected = work.catch((error: Error) => error);
    const originalSignal = state.signal;
    state.enter();
    state.leave();
    expect(originalSignal.aborted).toBe(true);
    expect(state.signal.aborted).toBe(false);
    release();
    expect((await rejected as Error).message).toContain("maintenance");
    expect(started).toBe(false);
    await state.runWork(async () => { state.assertAvailable(); });
  });
});

describe("maintenance access", () => {
  test("keeps recovery and status reads available while refusing work including read-triggered tools", () => {
    for (const [path, method] of [
      ["/v1/health", "GET"], ["/v1/states", "POST"], ["/v1/maintenance", "POST"],
      ["/v1/servers/example/stop", "POST"], ["/v1/servers/example/kill", "POST"],
      ["/v1/backups/jobs/example?afterSeq=4", "GET"], ["/v1/servers/example/install/logs", "GET"],
    ]) expect(allowedDuringNodeMaintenance(path!, method!)).toBe(true);
    for (const [path, method] of [
      ["/v1/servers/example/start", "POST"], ["/v1/servers/example/restart", "POST"],
      ["/v1/servers/example/container", "POST"], ["/v1/servers/example/install", "POST"],
      ["/v1/servers/example/command", "POST"], ["/v1/servers/example/files", "GET"],
      ["/v1/servers/example/transfer/export", "GET"], ["/v1/database/start", "POST"],
      ["/v1/backups/servers/example", "POST"], ["/v1/backups/snapshots", "POST"],
      ["/v1/sessions/token/console", "GET"], ["/v1/stats", "POST"],
    ]) expect(allowedDuringNodeMaintenance(path!, method!)).toBe(false);
  });
});
