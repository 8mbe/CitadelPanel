interface MaintenanceNode {
  isActive: boolean;
}

interface MaintenanceOperations<Node extends MaintenanceNode> {
  getNode: (nodeId: string) => Promise<Node | null>;
  setActive: (nodeId: string, active: boolean) => Promise<Node | null>;
  enter: (nodeId: string) => Promise<void>;
  leave: (nodeId: string) => Promise<void>;
}

/** Serialize panel intent and agent calls together, including background drains. */
export class NodeMaintenanceControl<Node extends MaintenanceNode> {
  private pending = new Map<string, Promise<unknown>>();

  constructor(private operations: MaintenanceOperations<Node>) {}

  setActive(
    nodeId: string,
    active: boolean,
    onUpdated: () => Promise<void>,
  ): Promise<Node | null> {
    return this.run(nodeId, async () => {
      // Activation is advertised only after the agent acknowledges it; drain
      // intent and its audit survive an unreachable agent or a failed stop.
      if (active) await this.operations.leave(nodeId);
      const node = await this.operations.setActive(nodeId, active);
      if (!node) return null;
      await onUpdated();
      if (!active) await this.operations.enter(nodeId);
      return node;
    });
  }

  enforce(nodeId: string): Promise<void> {
    return this.run(nodeId, async () => {
      // A sweep may have queued this while activation was still awaiting the
      // agent. Re-read inside the queue, after the whole activation completes.
      const node = await this.operations.getNode(nodeId);
      if (node && !node.isActive) await this.operations.enter(nodeId);
    });
  }

  private async run<T>(nodeId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(nodeId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    this.pending.set(nodeId, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(nodeId) === next) this.pending.delete(nodeId);
    }
  }
}
