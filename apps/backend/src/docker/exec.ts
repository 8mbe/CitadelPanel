/**
 * Run a command inside a container and capture its stdout/stderr/exit code.
 *
 * Why this is hand-rolled instead of dockerode's `container.exec().start()`:
 * `exec.start({ hijack: true })` relies on Node's `http` upgrade mechanics,
 * which Bun does not implement — the call throws
 * `(HTTP code 101) unexpected - <first bytes of output>` instead of returning
 * a stream. This is the same limitation documented in `docker/attach.ts`. The
 * exec *create* and *inspect* calls are plain JSON over HTTP, so those stay on
 * dockerode; only the hijacked *start* needs to speak the wire protocol
 * directly.
 *
 * The protocol: POST `/exec/{id}/start` over a raw unix socket, Docker replies
 * with an HTTP status line + headers (`101 UPGRADED` when upgrade headers are
 * sent, `200 OK` otherwise) and then hijacks the connection to carry its
 * 8-byte-framed multiplexed stream
 * (`[stream(1), 0,0,0, size(4 BE)] + payload`; stream 1 = stdout, 2 = stderr)
 * until the exec exits and the socket closes. The exit code is read from a
 * separate `/exec/{id}/json` inspect afterwards.
 */

import { connect, type Socket } from "bun";
import type Docker from "dockerode";

export interface ExecOptions {
  /** Command vector, e.g. ["mariadb-admin", "ping", "-h", "127.0.0.1"]. */
  cmd: string[];
  /** Extra environment variables, e.g. ["MYSQL_PWD=secret"]. */
  env?: string[];
  /** Run as this user (name or uid:gid). */
  user?: string;
  /** Working directory inside the container. */
  workingDir?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Create, start, and inspect an exec, returning captured stdout/stderr and the
 * exit code.
 *
 * `docker` is used only for the create + inspect JSON calls (both work under
 * Bun); `socketPath` is the daemon's unix socket for the hijacked start.
 */
export async function execInContainer(
  docker: Docker,
  socketPath: string,
  containerId: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: options.cmd,
    Env: options.env,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    ...(options.user ? { User: options.user } : {}),
    ...(options.workingDir ? { WorkingDir: options.workingDir } : {}),
  });
  const execId = exec.id;

  const { stdout, stderr } = await startExecRaw(socketPath, execId);

  // Exit code comes from a separate JSON inspect — the hijacked stream itself
  // does not carry it. Works under Bun (plain HTTP GET).
  const inspect = await exec.inspect();
  return { stdout, stderr, exitCode: inspect.ExitCode ?? -1 };
}

/**
 * Start an exec over a raw socket and drain its multiplexed output.
 *
 * Mirrors the handshake + frame demux in `docker/attach.ts`, but buffers stdout
 * and stderr separately (exec output is request/response-shaped, so we collect
 * it rather than streaming it).
 */
async function startExecRaw(
  socketPath: string,
  execId: string,
): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let buffer = Buffer.alloc(0);
  let handshakeDone = false;

  let resolveDone!: (out: { stdout: string; stderr: string }) => void;
  let rejectErr!: (error: Error) => void;
  const done = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    resolveDone = resolve;
    rejectErr = reject;
  });

  let socket: Socket<undefined>;
  try {
    socket = await connect({
      unix: socketPath,
      socket: {
        data(_socket, chunk) {
          buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

          try {
            if (!handshakeDone) {
              const sep = buffer.indexOf("\r\n\r\n");
              if (sep === -1) return;
              const head = buffer.subarray(0, sep).toString("utf8");
              buffer = buffer.subarray(sep + 4);

              // Docker hijacks the connection for exec start: it replies
              // 101 UPGRADED (when upgrade headers are sent) or 200 OK, then
              // streams 8-byte-framed stdout/stderr until the exec exits.
              const statusLine = head.split("\r\n")[0] ?? "";
              if (!/101|200 OK/.test(statusLine)) {
                throw new Error(`Docker refused the exec start: ${statusLine}`);
              }
              handshakeDone = true;
            }

            // Peel every complete frame off the front of the buffer. A frame is
            // [streamId(1), 0,0,0, size(4 BE)] + `size` payload bytes, and a
            // single read can hold several frames or only part of one.
            while (buffer.length >= 8) {
              const streamId = buffer[0];
              const size = buffer.readUInt32BE(4);
              if (buffer.length < 8 + size) return; // payload still arriving

              const payload = buffer.subarray(8, 8 + size);
              if (streamId === 2) stderrChunks.push(Buffer.from(payload));
              else stdoutChunks.push(Buffer.from(payload));
              buffer = buffer.subarray(8 + size);
            }
          } catch (error) {
            rejectErr(error instanceof Error ? error : new Error(String(error)));
          }
        },
        close() {
          resolveDone({
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
          });
        },
        error(_socket, error) {
          rejectErr(error);
        },
      },
    });
  } catch (error) {
    throw new Error(
      `Could not open the Docker socket at ${socketPath}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const body = JSON.stringify({ Detach: false, Tty: false });
  socket.write(
    `POST /exec/${execId}/start HTTP/1.1\r\n` +
      "Host: localhost\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: tcp\r\n\r\n" +
      body,
  );

  return done;
}
