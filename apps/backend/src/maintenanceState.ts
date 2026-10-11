import { serviceUnavailable } from "./http";
import { AsyncLocalStorage } from "node:async_hooks";

/** Shared by HTTP, SFTP, and every container launch, without importing Docker. */
export class MaintenanceState {
  enabled = false;
  private generation = 0;
  private starts = new Set<Promise<void>>();
  private listeners = new Set<() => void>();
  private workGeneration = new AsyncLocalStorage<number>();
  private cancellation = new AbortController();

  get signal(): AbortSignal { return this.cancellation.signal; }

  enter(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.generation += 1;
    this.cancellation.abort();
    for (const close of this.listeners) {
      try { close(); } catch (error) { console.error("[agent] failed to close a maintenance session:", error); }
    }
  }

  leave(): void {
    if (this.enabled) this.cancellation = new AbortController();
    this.enabled = false;
  }

  assertAvailable(): void {
    const acceptedGeneration = this.workGeneration.getStore();
    if (this.enabled || (acceptedGeneration !== undefined && acceptedGeneration !== this.generation)) {
      throw serviceUnavailable("Node work was blocked or interrupted by maintenance. Activate it before doing work.");
    }
  }

  runWork<T>(work: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    return this.workGeneration.run(this.generation, work);
  }

  onDrain(close: () => void): () => void {
    this.listeners.add(close);
    return () => { this.listeners.delete(close); };
  }

  /** Catch a launch already accepted by Docker when the drain latch closed. */
  async launch(start: () => Promise<unknown>, stop: () => Promise<unknown>): Promise<void> {
    this.assertAvailable();
    const generation = this.generation;
    const running = (async () => {
      await start();
      if (this.enabled || generation !== this.generation) {
        await stop();
        throw serviceUnavailable("Container launch was interrupted by node maintenance.");
      }
    })();
    this.starts.add(running);
    try {
      await running;
    } finally {
      this.starts.delete(running);
    }
  }

  async settleLaunches(): Promise<void> {
    await Promise.allSettled([...this.starts]);
    // The container sweep retries any stop that failed here. Launch callers
    // still receive their own error rather than turning drain into a start.
  }
}

export const maintenanceState = new MaintenanceState();
