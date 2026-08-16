/**
 * Outbound SFTP authentication callback to the panel.
 *
 * The SFTP server (see `sftp.ts`) authenticates clients by username/password,
 * but the agent has no user model — the panel owns all three (users, the
 * `sftp_credentials` table, and the audit log). So when an SFTP client connects,
 * the agent calls back here so the panel can:
 *
 *   1. authenticate the agent itself by its long-lived bearer
 *      (`findNodeByAgentToken`),
 *   2. look up the `sftp_credentials` row by username and verify the password,
 *   3. confirm the user still has `files` access to that server,
 *   4. return the `{serverId, userId}` the SFTP session is then chrooted to.
 *
 * This mirrors the direct-console callback pattern (`consoleAudit.ts`): the agent
 * stays stateless, the panel is the source of truth, and `PANEL_URL` is required.
 * Unlike the console flow there is no short-lived token — SFTP connections are
 * long-lived, so the credential is validated fresh on every connection.
 */

import { config } from "./config";

export interface SftpAuthResult {
  serverId: string;
  userId: string;
}

/** A non-2xx response or network failure from the panel. */
class PanelRejectedError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "PanelRejectedError";
    this.status = status;
  }
}

/**
 * The panel base URL, read lazily at call time.
 *
 * Same rationale as `consoleAudit.ts`: the callback URL is an operational detail
 * an operator may re-point without restarting the agent, and reading it lazily
 * keeps tests decoupled from module-load order.
 */
function panelUrl(): string {
  return process.env.PANEL_URL ?? config.panelUrl;
}

/** Build the authenticated JSON POST to a panel SFTP endpoint. */
function panelPost(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  return fetch(`${panelUrl()}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Validate an SFTP username/password with the panel.
 *
 * Called (and awaited) at SSH authentication time. Throws on any non-2xx or
 * network failure — the caller rejects the SSH auth, closing the connection.
 * A 401 from the panel (bad password, unknown user, no access) is the expected
 * rejection path and is thrown as a `PanelRejectedError` with that status.
 */
export async function validateSftpCredentials(
  username: string,
  password: string,
): Promise<SftpAuthResult> {
  let response: Response;
  try {
    response = await panelPost(
      "/api/internal/sftp/authenticate",
      { username, password },
      5_000,
    );
  } catch (error) {
    throw new PanelRejectedError(
      `panel sftp auth callback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new PanelRejectedError(
      `panel rejected sftp credentials (status ${response.status})`,
      response.status,
    );
  }

  const parsed = (await response.json()) as { serverId?: unknown; userId?: unknown };
  if (typeof parsed.serverId !== "string" || typeof parsed.userId !== "string") {
    throw new PanelRejectedError("panel sftp auth response was malformed");
  }
  return { serverId: parsed.serverId, userId: parsed.userId };
}
