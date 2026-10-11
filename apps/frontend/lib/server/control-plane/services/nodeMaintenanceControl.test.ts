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
    isMaintained: async (id: string) => agent.get(id) === true,
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
    const enforcement = f.control.reconcile("node");
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
    const drain = f.control.reconcile("node");
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
    const drain = f.control.reconcile("node");
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

  test("reconciliation leaves healthy active and deleted nodes alone", async () => {
    const f = fixture();
    f.nodes.set("node", { isActive: true });
    f.agent.set("node", false);
    expect(await f.control.reconcile("node")).toBe(false);
    expect(await f.control.reconcile("deleted")).toBe(false);
    expect(f.events).toEqual([]);
  });

  test("an already-active node with persistent agent maintenance is recovered", async () => {
    const f = fixture();
    f.nodes.set("node", { isActive: true });
    expect(await f.control.reconcile("node")).toBe(true);
    expect(f.agent.get("node")).toBe(false);
    expect(f.nodes.get("node")!.isActive).toBe(true);
    // Repeated sweeps do not send redundant activation calls or rewrite intent.
    expect(await f.control.reconcile("node")).toBe(false);
    expect(f.events).toEqual(["activate:node"]);
  });

  test("an inactive node is drained without probing or reopening it", async () => {
    const f = fixture();
    f.agent.set("node", false);
    f.operations.isMaintained = async () => { throw new Error("must not probe"); };
    expect(await f.control.reconcile("node")).toBe(false);
    expect(f.agent.get("node")).toBe(true);
    expect(f.events).toEqual(["drain:node"]);
  });

  test("failed health probes do not activate a node, and the next sweep can recover", async () => {
    const f = fixture();
    f.nodes.set("node", { isActive: true });
    const probe = f.operations.isMaintained;
    f.operations.isMaintained = async () => { throw new Error("health unreachable"); };
    await expect(f.control.reconcile("node")).rejects.toThrow("health unreachable");
    expect(f.agent.get("node")).toBe(true);
    expect(f.events).toEqual([]);
    f.operations.isMaintained = probe;
    expect(await f.control.reconcile("node")).toBe(true);
  });

  test("a drain queued during automatic recovery keeps the node drained", async () => {
    const f = fixture();
    f.nodes.set("node", { isActive: true });
    const probing = gate();
    const answer = gate();
    f.operations.isMaintained = async () => {
      probing.release();
      await answer.promise;
      return true;
    };
    const recovery = f.control.reconcile("node");
    await probing.promise;
    const drain = f.control.setActive("node", false, f.audit);
    answer.release();
    await Promise.all([recovery, drain]);
    expect(f.nodes.get("node")!.isActive).toBe(false);
    expect(f.agent.get("node")).toBe(true);
    expect(f.events).toEqual(["activate:node", "intent:node:false", "audit", "drain:node"]);
  });
});
