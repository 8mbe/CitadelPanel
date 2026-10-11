import { describe, expect, test } from "bun:test";
import { NodeMaintenanceControl } from "./nodeMaintenanceControl";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function fixture() {
  const nodes = new Map<string, { isActive: boolean }>([
    ["node", { isActive: false }], ["other", { isActive: false }],
  ]);
  const agent = new Map([["node", true], ["other", true]]);
  const events: string[] = [];
  const operations = {
    getNode: async (id: string) => nodes.get(id) ?? null,
    setActive: async (id: string, active: boolean) => {
      events.push(`intent:${id}:${active}`);
      if (!nodes.has(id)) return null;
      const node = { isActive: active };
      nodes.set(id, node);
      return node;
    },
    enter: async (id: string) => { events.push(`drain:${id}`); agent.set(id, true); },
    leave: async (id: string) => { events.push(`activate:${id}`); agent.set(id, false); },
  };
  const control = new NodeMaintenanceControl(operations);
  const audit = async () => { events.push("audit"); };
  return { nodes, agent, events, operations, control, audit };
}

describe("panel node maintenance coordination", () => {
  test("a sweep queued between agent activation and the intent write cannot re-drain it", async () => {
    const f = fixture();
    const cleared = gate();
    const store = gate();
    const setActive = f.operations.setActive;
    f.operations.setActive = async (id, active) => {
      cleared.release();
      await store.promise;
      return setActive(id, active);
    };

    const activation = f.control.setActive("node", true, f.audit);
    await cleared.promise;
    expect(f.agent.get("node")).toBe(false);
    expect(f.nodes.get("node")!.isActive).toBe(false);
    const enforcement = f.control.enforce("node");
    store.release();
    await Promise.all([activation, enforcement]);

    expect(f.nodes.get("node")!.isActive).toBe(true);
    expect(f.agent.get("node")).toBe(false);
    expect(f.events).toEqual(["activate:node", "intent:node:true", "audit"]);
  });

  test("activation waits for a running drain, then reopens the node", async () => {
    const f = fixture();
    const started = gate();
    const stop = gate();
    const enter = f.operations.enter;
    f.operations.enter = async (id) => {
      started.release();
      await stop.promise;
      await enter(id);
    };
    const drain = f.control.enforce("node");
    await started.promise;
    const activation = f.control.setActive("node", true, f.audit);
    await Promise.resolve();
    expect(f.agent.get("node")).toBe(true);
    stop.release();
    await Promise.all([drain, activation]);
    expect(f.agent.get("node")).toBe(false);
    expect(f.events).toEqual(["drain:node", "activate:node", "intent:node:true", "audit"]);
  });

  test("failed activation never advertises an active node and later activation can recover", async () => {
    const f = fixture();
    const leave = f.operations.leave;
    f.operations.leave = async () => { throw new Error("agent unavailable"); };
    await expect(f.control.setActive("node", true, f.audit)).rejects.toThrow("agent unavailable");
    expect(f.nodes.get("node")!.isActive).toBe(false);
    expect(f.events).toEqual([]);
    f.operations.leave = leave;
    await f.control.setActive("node", true, f.audit);
    expect(f.nodes.get("node")!.isActive).toBe(true);
  });

  test("failed draining preserves intent and audit, and does not block queued activation", async () => {
    const f = fixture();
    f.nodes.set("node", { isActive: true });
    f.operations.enter = async () => { throw new Error("stop failed"); };
    const drain = f.control.setActive("node", false, f.audit);
    const rejected = expect(drain).rejects.toThrow("stop failed");
    const activation = f.control.setActive("node", true, f.audit);
    await rejected;
    await activation;
    expect(f.events).toEqual(["intent:node:false", "audit", "activate:node", "intent:node:true", "audit"]);
    expect(f.nodes.get("node")!.isActive).toBe(true);
  });

  test("a busy node does not delay activation of another node", async () => {
    const f = fixture();
    const started = gate();
    const stop = gate();
    f.operations.enter = async () => { started.release(); await stop.promise; };
    const drain = f.control.enforce("node");
    await started.promise;
    try {
      await f.control.setActive("other", true, f.audit);
      expect(f.agent.get("other")).toBe(false);
      expect(f.nodes.get("other")!.isActive).toBe(true);
    } finally {
      stop.release();
      await drain;
    }
  });

  test("enforcement ignores active and deleted nodes", async () => {
    const f = fixture();
    f.nodes.set("node", { isActive: true });
    await f.control.enforce("node");
    await f.control.enforce("deleted");
    expect(f.events).toEqual([]);
  });
});
