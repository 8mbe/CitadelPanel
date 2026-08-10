/**
 * Tests for the live-console streaming primitives.
 *
 * `demuxDockerLogStream` and the SSE helpers are pure transforms over buffers
 * and streams, so they can be exercised without a Docker daemon. This is where
 * the framing correctness lives — a bug here would either splice garbage into
 * the console or drop output silently.
 */

import { describe, expect, test } from "bun:test";

import { demuxDockerLogStream } from "./docker/container";
import { sseFromEvents, sseWrap } from "./http";

/**
 * Build one Docker multiplexed log frame: [stream(1), 0,0,0, size(4 BE)] + payload.
 *
 * Stream id 1 = stdout, 2 = stderr; both are forwarded by the demuxer.
 */
function frame(stream: number, payload: string): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, Buffer.from(payload)]);
}

/**
 * Read every chunk a ReadableStream emits into an array of strings.
 *
 * The console feed is ultimately text, so decoding here keeps the assertions
 * readable.
 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const out: string[] = [];
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(decoder.decode(value, { stream: true }));
  }
  return out;
}

/** A minimal Node-style readable that emits chunks then ends, for the demuxer. */
class FakeDockerStream {
  private listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners[event] ?? []) fn(...args);
  }

  on(event: string, fn: (...args: unknown[]) => void): this {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }

  off(event: string, fn: (...args: unknown[]) => void): this {
    this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== fn);
    return this;
  }
}

/**
 * The demuxer only uses the EventEmitter subset (`on`/`off`/`emit`), but its
 * parameter is typed as `NodeJS.ReadableStream`. Cast through `unknown` so the
 * fake satisfies the type without implementing the full readable interface.
 */
const asDockerStream = (src: FakeDockerStream): NodeJS.ReadableStream =>
  src as unknown as NodeJS.ReadableStream;

describe("demuxDockerLogStream", () => {
  test("demuxes a single complete frame", async () => {
    const src = new FakeDockerStream();
    const out = drain(demuxDockerLogStream(asDockerStream(src)));
    src.emit("data", frame(1, "hello\n"));
    src.emit("end");
    expect(await out).toEqual(["hello\n"]);
  });

  test("forwards both stdout and stderr payloads", async () => {
    const src = new FakeDockerStream();
    const out = drain(demuxDockerLogStream(asDockerStream(src)));
    src.emit("data", Buffer.concat([frame(1, "out\n"), frame(2, "err\n")]));
    src.emit("end");
    expect(await out).toEqual(["out\n", "err\n"]);
  });

  test("demuxes multiple frames in one chunk", async () => {
    const src = new FakeDockerStream();
    const out = drain(demuxDockerLogStream(asDockerStream(src)));
    src.emit("data", Buffer.concat([frame(1, "a\n"), frame(2, "b\n"), frame(1, "c\n")]));
    src.emit("end");
    expect(await out).toEqual(["a\n", "b\n", "c\n"]);
  });

  test("buffers a frame whose header is split across chunks", async () => {
    const src = new FakeDockerStream();
    const out = drain(demuxDockerLogStream(asDockerStream(src)));
    const whole = frame(1, "hello\n");
    src.emit("data", whole.subarray(0, 5)); // partial header only
    src.emit("data", whole.subarray(5)); // rest of header + payload
    src.emit("end");
    expect(await out).toEqual(["hello\n"]);
  });

  test("buffers a frame whose payload is split across chunks", async () => {
    const src = new FakeDockerStream();
    const out = drain(demuxDockerLogStream(asDockerStream(src)));
    const whole = frame(1, "hello\n");
    src.emit("data", whole.subarray(0, 9)); // full header + "hel"
    src.emit("data", whole.subarray(9)); // "lo\n"
    src.emit("end");
    expect(await out).toEqual(["hello\n"]);
  });

  test("holds a partial frame across an intervening complete frame", async () => {
    const src = new FakeDockerStream();
    const out = drain(demuxDockerLogStream(asDockerStream(src)));
    const first = frame(1, "x\n");
    const second = frame(2, "yy\n");
    src.emit("data", Buffer.concat([first, second.subarray(0, 5)])); // first whole, second partial
    src.emit("data", second.subarray(5)); // rest of second
    src.emit("end");
    expect(await out).toEqual(["x\n", "yy\n"]);
  });

  test("emits no output for an empty stream", async () => {
    const src = new FakeDockerStream();
    const out = drain(demuxDockerLogStream(asDockerStream(src)));
    src.emit("end");
    expect(await out).toEqual([]);
  });
});

describe("sseWrap", () => {
  test("wraps a complete line as one data event", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello\n"));
        c.close();
      },
    });
    expect(await drain(sseWrap(body))).toEqual(["data: hello\n\n"]);
  });

  test("splits a multi-line payload into one SSE event per line", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("a\nb\nc\n"));
        c.close();
      },
    });
    // All three lines arrived in one upstream chunk, so they enqueue as one
    // chunk containing three SSE events — valid: the blank line delimits each.
    expect(await drain(sseWrap(body))).toEqual([
      "data: a\n\ndata: b\n\ndata: c\n\n",
    ]);
  });

  test("holds a trailing partial line until the next chunk completes it", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hel"));
        c.enqueue(new TextEncoder().encode("lo\n"));
        c.close();
      },
    });
    expect(await drain(sseWrap(body))).toEqual(["data: hello\n\n"]);
  });

  test("flushes a final partial line with no trailing newline", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("incomplete"));
        c.close();
      },
    });
    expect(await drain(sseWrap(body))).toEqual(["data: incomplete\n\n"]);
  });
});

describe("sseFromEvents", () => {
  test("encodes a typed event as an event stream chunk", async () => {
    const out = await drain(sseFromEvents([{ type: "console", message: "nope" }]));
    expect(out).toEqual(['event: console\ndata: {"type":"console","message":"nope"}\n\n']);
  });

  test("emits multiple events in order, then ends", async () => {
    const out = await drain(
      sseFromEvents([
        { type: "console", message: "gone" },
      ]),
    );
    expect(out).toEqual([
      'event: console\ndata: {"type":"console","message":"gone"}\n\n',
    ]);
  });
});
