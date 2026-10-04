import { describe, expect, test } from "bun:test";

import { prependConsoleReady } from "./consoleStream";

describe("prependConsoleReady", () => {
  test("sends ready before forwarding the agent's bytes", async () => {
    const chunk = new TextEncoder().encode("data: hello\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const reader = prependConsoleReady(body, true).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'event: ready\ndata: {"type":"ready","tty":true}\n\n',
    );
    expect((await reader.read()).value).toBe(chunk);
    expect((await reader.read()).done).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("leaving the console cancels a locked upstream with a pending read", async () => {
    let reason: unknown;
    const body = new ReadableStream<Uint8Array>({
      cancel(value) { reason = value; },
    });
    const reader = prependConsoleReady(body, false).getReader();
    await reader.read(); // ready, followed by a pending upstream read
    await reader.cancel("left console");
    await Bun.sleep(0);
    expect(reason).toBe("left console");
    expect(body.locked).toBe(false);
    expect((await reader.read()).done).toBe(true);
  });

  test("an upstream error ends the feed and releases its reader", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const reader = prependConsoleReady(body, false).getReader();
    await reader.read();
    const pending = reader.read();
    controller.error(new Error("agent disconnected"));
    expect((await pending).done).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("an empty upstream sends ready and finishes", async () => {
    const reader = prependConsoleReady(null, false).getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(true);
  });
});
