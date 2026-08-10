/**
 * Container attach over a raw Docker socket connection.
 *
 * Why this is hand-rolled instead of using `dockerode`'s `attach({hijack:true})`:
 * hijack relies on Node's `http` upgrade mechanics, which Bun does not
 * implement — the call simply never resolves. Every other dockerode operation
 * works fine, so this is the one place that needs to speak the wire protocol
 * directly.
 *
 * The protocol itself is small: POST the attach endpoint with an Upgrade
 * header, Docker replies `101 UPGRADED`, and from then on the socket carries
 * multiplexed container output in one direction and raw stdin in the other.
 */

import { connect, type Socket } from "bun";
import { config } from "../config";

/** Callbacks for an attached container stream. */
export interface AttachHandlers {
  /** Payload bytes, with Docker's stream framing already removed. */
  onData: (chunk: Buffer) => void;
  onClose: () => void;
  onError: (error: Error) => void;
}

/**
 * A live attachment. `write` sends to the container's stdin; `close` releases
 * the socket, which Docker otherwise holds open server-side.
 *
 * `ready` resolves once Docker has acknowledged the attach upgrade (`101
 * UPGRADED`). Stdin written before that point is dropped or mangled — the first
 * byte of a command sent during the handshake is routinely lost — so callers
 * MUST `await attachment.ready` before writing.
 */
export interface Attachment {
  /** Resolves when the attach upgrade is acknowledged and stdin is writable. */
  ready: Promise<void>;
  write: (data: string) => void;
  close: () => void;
}

/**
 * Per-connection framing state.
 *
 * Docker's multiplexed stream is [stream(1), 0,0,0, size(4 BE)] + payload, and
 * frames are NOT aligned to TCP reads — a header can be split across two
 * packets and one read can hold several frames. So bytes are buffered and
 * consumed only when a whole frame is present.
 */
interface StreamState {
  /** True until the `101 UPGRADED` response headers have been consumed. */
  handshakeDone: boolean;
  buffer: Buffer;
}

/** Strip HTTP response headers, returning the body bytes that followed them. */
function consumeHandshake(state: StreamState): boolean {
  const separator = state.buffer.indexOf("\r\n\r\n");
  if (separator === -1) return false;

  const headers = state.buffer.subarray(0, separator).toString("utf8");
  state.buffer = state.buffer.subarray(separator + 4);

  if (!headers.includes("101")) {
    throw new Error(`Docker refused the attach upgrade: ${headers.split("\r\n")[0]}`);
  }

  state.handshakeDone = true;
  return true;
}

/**
 * Pull every complete frame out of the buffer.
 *
 * Both stdout (stream 1) and stderr (stream 2) are forwarded: a game server
 * logs errors to stderr and a console that hid them would be actively
 * misleading.
 */
function drainFrames(state: StreamState, onData: (chunk: Buffer) => void): void {
  while (state.buffer.length >= 8) {
    const size = state.buffer.readUInt32BE(4);
    if (state.buffer.length < 8 + size) return; // frame still incomplete

    onData(state.buffer.subarray(8, 8 + size));
    state.buffer = state.buffer.subarray(8 + size);
  }
}

/**
 * Attach to a container's stdin/stdout/stderr.
 *
 * The container must have been created with `OpenStdin` (see `hardening.ts`),
 * otherwise there is no stdin to write to and the console is read-only.
 */
export async function attachToContainer(
  containerId: string,
  handlers: AttachHandlers,
): Promise<Attachment> {
  const state: StreamState = { handshakeDone: false, buffer: Buffer.alloc(0) };

  // Resolved the moment Docker acknowledges the upgrade. Stdin written before
  // this is lost (the first byte of a command sent mid-handshake vanishes), so
  // this is what lets `write` be safe to call.
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let socket: Socket<undefined>;
  try {
    socket = await connect({
      unix: config.dockerSocket,
      socket: {
        data(_socket, chunk) {
          state.buffer = Buffer.concat([state.buffer, Buffer.from(chunk)]);

          try {
            if (!state.handshakeDone && !consumeHandshake(state)) return;
            resolveReady();
            drainFrames(state, handlers.onData);
          } catch (error) {
            const wrapped =
              error instanceof Error ? error : new Error(String(error));
            rejectReady(wrapped);
            handlers.onError(wrapped);
          }
        },
        close: () => {
          // If the socket closes before the handshake completed, the attach
          // never became usable — reject so a waiting writer doesn't hang.
          if (!state.handshakeDone) {
            rejectReady(new Error("attach socket closed before upgrade"));
          }
          handlers.onClose();
        },
        error: (_socket, error) => {
          if (!state.handshakeDone) rejectReady(error);
          handlers.onError(error);
        },
      },
    });
  } catch (error) {
    throw new Error(
      `Could not open the Docker socket at ${config.dockerSocket}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const path =
    `/containers/${containerId}/attach` + "?stream=1&stdout=1&stderr=1&stdin=1";

  socket.write(
    `POST ${path} HTTP/1.1\r\n` +
      "Host: localhost\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: tcp\r\n" +
      "Content-Length: 0\r\n\r\n",
  );

  return {
    ready,
    write: (data: string) => {
      socket.write(data);
    },
    close: () => {
      socket.end();
    },
  };
}
