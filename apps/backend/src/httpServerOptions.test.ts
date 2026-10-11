import { expect, test } from "bun:test";
import { HTTP_SERVER_OPTIONS } from "./httpServerOptions";
import { uploadFile } from "./files";
import { config } from "./config";
import { connect } from "node:net";

/** Reuse a small chunk so the test never allocates the full upload. */
function bytes(total: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  let remaining = total;
  return new ReadableStream({
    pull(controller) {
      if (remaining === 0) { controller.close(); return; }
      const size = Math.min(remaining, chunk.byteLength);
      remaining -= size;
      controller.enqueue(chunk.subarray(0, size));
    },
  });
}

test.each([false, true])("agent transport accepts a streamed body over 128 MiB, content-length=%s", async (knownLength) => {
  const total = 128 * 1024 * 1024 + 1;
  const server = Bun.serve({
    ...HTTP_SERVER_OPTIONS,
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const reader = request.body!.getReader();
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
        }
      } finally { reader.releaseLock(); }
      return Response.json({ received });
    },
  });
  try {
    const response = await fetch(server.url, {
      method: "POST", body: bytes(total),
      headers: knownLength ? { "content-length": String(total) } : {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: total });
  } finally { await server.stop(true); }
});

test("the file manager still rejects an upload above its separate limit", async () => {
  await expect(uploadFile(
    "fafafafa-1111-2222-3333-444444444444", "oversized.dat",
    bytes(config.maxUploadBytes + 1), config.maxUploadBytes + 1,
  )).rejects.toMatchObject({ status: 413 });
});

test("a 16 GiB migration is accepted by transport headers without allocating its body", async () => {
  const server = Bun.serve({ ...HTTP_SERVER_OPTIONS, hostname: "127.0.0.1", port: 0, fetch: () => new Response("accepted") });
  try {
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: server.port! }, () => {
        socket.write(`POST /migration HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${16 * 1024 ** 3}\r\nConnection: close\r\n\r\n`);
      });
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("No HTTP response")); });
      socket.on("error", reject);
      socket.once("data", chunk => { socket.destroy(); resolve(chunk.toString().split("\r\n")[0]!); });
    });
    expect(status).toBe("HTTP/1.1 200 OK");
  } finally { await server.stop(true); }
});
