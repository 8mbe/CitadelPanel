import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testRoot } from "../test-setup";
import { uploadFile } from "./files";
import { maintenanceState } from "./maintenanceState";

afterEach(() => maintenanceState.leave());

test("draining cancels a stalled upload and preserves the original file", async () => {
  const serverId = "66666666-1111-2222-3333-444444444444";
  const directory = join(testRoot, serverId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "world.dat"), "original world");
  let reading!: () => void;
  const readStarted = new Promise<void>((resolve) => { reading = resolve; });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { reading(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const outcome = uploadFile(serverId, "world.dat", body, null).catch((error: Error) => error);
  await readStarted;
  maintenanceState.enter();
  expect(await outcome).toBeInstanceOf(Error);
  expect(cancelled).toBe(true);
  expect(await readFile(join(directory, "world.dat"), "utf8")).toBe("original world");
  expect(await readdir(directory)).toEqual(["world.dat"]);
});
