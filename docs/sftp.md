# SFTP server (agent-side, per-(user,server) credentials)

The agent runs a custom SFTP server (the `ssh2` npm package, on port `8022` by
default) alongside its HTTP/WS server. Each server's owner, or a subuser with
the `files` permission, can mint an SFTP credential from the panel's **Files**
section and connect with any standard SFTP client (FileZilla, WinSCP, `sftp`,
etc.). Sessions are chrooted to that server's data directory.

## How it works (panel-callback auth)

The agent has no user model, so SFTP authentication is delegated to the panel,
the same posture as the [direct console](./direct-console.md). The difference:
the console mints a short-lived, single-use token; SFTP uses a long-lived
username/password that the panel stores hashed.

1. A user mints a credential in the panel UI (`POST /api/servers/:id/sftp/credentials`).
   The panel generates a username (`{slug(email)}-{first8(serverUUID)}`) and a
   random 24-byte password, hashes it with scrypt (the same scheme Better Auth
   uses for login passwords), and stores the row in `sftp_credentials`. The
   plaintext password is returned **once** and never retrievable.
2. The user points their SFTP client at the node's hostname, port 8022, with
   that username and password.
3. On connect, the agent calls the panel back
   (`POST /api/internal/sftp/authenticate`) with `{username, password}`. The
   panel authenticates the agent by its long-lived bearer (reverse-looked-up to
   a node), looks up the credential, verifies the password, re-checks the user
   still has `files` access to that server (a revoked subuser or handed-off
   server must not keep working), confirms the server lives on the calling
   node, and returns `{serverId, userId}`.
4. The agent chroots the SFTP session to `serverDataPath(serverId)`. Every file
   operation is resolved through `paths.ts`, the same containment boundary the
   file-manager HTTP routes use, so `..` traversal and symlink escapes are
   caught by the existing checks.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SFTP_PORT` | `8022` | TCP port for the SFTP server. `0` disables SFTP entirely. |
| `SFTP_HOST_KEY_PATH` | `<data root>/../sftp_host_key` | Path to the RSA host key (PEM). Generated on first boot if missing; persisted so the fingerprint is stable across restarts. |
| `PANEL_URL` | none | **Required** for SFTP auth. Without it, every SFTP login is rejected (the panel cannot be reached to validate the credential). Same requirement as the direct console. |

## Credential management

- **Create**: `POST /api/servers/:id/sftp/credentials`. Generates a new
  username/password. One credential per (user, server); calling this again
  rotates the password (upsert).
- **Regenerate**: `POST /api/servers/:id/sftp/credentials/regenerate`. Rotates
  the password on an existing credential. The old password stops working
  immediately.
- **List**: `GET /api/servers/:id/sftp/credentials`. Owners/admins see all
  credentials on the server; subusers see only their own. No passwords returned.
- **Delete**: `DELETE /api/servers/:id/sftp/credentials/:credentialId`. The
  revocation path. The agent's next auth callback for that username will 401.
- **Connection details**: `GET /api/servers/:id/sftp/connection`. Returns host,
  port, and username (if the caller has a credential) for an SFTP client.

## Security notes

- The SFTP host key is generated on first boot and persisted. Clients should
  verify the fingerprint on first connect (TOFU) to prevent MITM. For
  production, put the SFTP port behind a TLS-terminating proxy or restrict it
  to a private network. SFTP itself is encrypted (SSH), but the host key must
  be verified.
- Passwords are stored as scrypt `salt:hash` (Better Auth's scheme), never in
  plaintext. A lost password is regenerated, not recovered.
- Every auth attempt is audited (`server.sftp.auth`) with the userId and the
  calling node. Per-file operations are not audited (too chatty).
- A credential is bound to the node its server lives on: node Y cannot validate
  a credential minted for a server on node X.
- Revoking access (deleting the credential, removing the subuser, or revoking
  the `files` permission) takes effect on the **next SFTP connection**. An
  already-open SFTP session is not severed. The agent is stateless and holds
  no handle back to the panel. This matches the direct-console's limitation.
- Containment is enforced via `paths.ts`: `..` traversal is blocked lexically,
  and symlink escapes are caught via `realpath` on every read/list/delete. The
  data directory root itself cannot be deleted or overwritten via SFTP.
