import { expect, test } from "bun:test";
import { countTransferStream } from "./transferStream";

test("a stalled destination causes no source reads or progress", async () => {
  let produced = 0;
  let counted = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { produced++; controller.enqueue(new Uint8Array(4)); },
  }, { highWaterMark: 0 });
  const forwarded = countTransferStream(source, (bytes) => { counted += bytes; });
  await Bun.sleep(0);
  expect(produced).toBe(0);
  expect(counted).toBe(0);
  const reader = forwarded.getReader();
  expect((await reader.read()).value?.byteLength).toBe(4);
  await Bun.sleep(0);
  expect(produced).toBe(1);
  expect(counted).toBe(4);
  await reader.cancel();
  reader.releaseLock();
  expect(source.locked).toBe(false);
});

test("cancelling a rejected destination upload cancels the source", async () => {
  let reason: unknown;
  const source = new ReadableStream<Uint8Array>({ cancel(value) { reason = value; } });
  const forwarded = countTransferStream(source, () => {});
  await forwarded.cancel("destination returned 413");
  expect(reason).toBe("destination returned 413");
  expect(source.locked).toBe(false);
});

test("aborting a pending read cancels the upstream and rejects the destination read", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const signal = new AbortController();
  const forwarded = countTransferStream(source, () => {}, signal.signal);
  const reader = forwarded.getReader();
  const pending = reader.read();
  signal.abort(new Error("migration cancelled"));
  await expect(pending).rejects.toThrow("migration cancelled");
  await Bun.sleep(0);
  expect(cancelled).toBe(true);
  expect(source.locked).toBe(false);
});

test("a failed tar stream fails the transfer rather than appearing complete", async () => {
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("tar failed")); },
  }, { highWaterMark: 0 });
  const reader = countTransferStream(source, () => {}).getReader();
  await expect(reader.read()).rejects.toThrow("tar failed");
  expect(source.locked).toBe(false);
});

test("completion forwards bytes and releases the source", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
  });
  let counted = 0;
  const reader = countTransferStream(source, (bytes) => { counted += bytes; }).getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
  expect((await reader.read()).done).toBe(true);
  expect(counted).toBe(3);
  expect(source.locked).toBe(false);
});
