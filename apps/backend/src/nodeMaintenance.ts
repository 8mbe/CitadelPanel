import { closeSync, constants, fsyncSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type Docker from "dockerode";
import { stopContainer } from "./docker/container";
import { serviceUnavailable } from "./http";
import { MaintenanceState } from "./maintenanceState";

/** A durable execution latch, never tenant data or panel-owned metadata. */
export class NodeMaintenance {
  private pending: Promise<{ maintenance: boolean; stopped: number }> | null = null;

  constructor(private client: Docker, private marker: string, readonly state: MaintenanceState) {
    try {
      const fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
      closeSync(fd);
      state.enter();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  set(enabled: boolean): Promise<{ maintenance: boolean; stopped: number }> {
    // Serialize drain/activate so activation cannot open the latch mid-stop.
    const next = (this.pending ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (!enabled) {
        try { unlinkSync(this.marker); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.state.leave();
        return { maintenance: false, stopped: 0 };
      }

      this.state.enter();
      mkdirSync(dirname(this.marker), { recursive: true });
      const fd = openSync(this.marker, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, "maintenance\n");
        fsyncSync(fd);
      } finally { closeSync(fd); }
      await this.state.settleLaunches();

      const listed = await this.client.listContainers({ all: true }).catch((error: unknown) => {
        throw serviceUnavailable(`Node remains in maintenance, but Docker containers could not be listed: ${error instanceof Error ? error.message : String(error)}`);
      });
      const containers = listed.filter((container) =>
        (container.Labels?.["citadel.managed"] === "true" || container.Labels?.["citadel.tool"] === "backup") &&
        ["running", "paused", "restarting"].includes(container.State),
      );
      const failures: string[] = [];
      let nextIndex = 0;
      let stopped = 0;
      await Promise.all(Array.from({ length: Math.min(4, containers.length) }, async () => {
        while (nextIndex < containers.length) {
          const container = containers[nextIndex++]!;
          try {
            if (container.State === "paused") await this.client.getContainer(container.Id).unpause();
            await stopContainer(this.client, container.Id);
            stopped += 1;
          } catch (error) {
            failures.push(`${container.Names?.[0] ?? container.Id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }));
      if (failures.length) throw serviceUnavailable(`Node remains in maintenance, but some containers could not stop: ${failures.join("; ")}`);
      return { maintenance: true, stopped };
    });
    this.pending = next;
    void next.finally(() => { if (this.pending === next) this.pending = null; }).catch(() => undefined);
    return next;
  }
}
