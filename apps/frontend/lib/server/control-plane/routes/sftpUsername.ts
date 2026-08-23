/**
 * SFTP username derivation.
 *
 * Split out from `routes/sftp.ts` so it can be unit-tested without pulling in
 * the DB client (which carries a Next.js `server-only` marker). Pure string
 * logic. No I/O, no deps.
 */

/**
 * Generate a URL-safe username from a user's email and a server id.
 *
 * Format: `{slug(email-local-part)}-{first8(serverUUID)}`. The slug keeps it
 * readable and free of characters SFTP clients dislike; the 8-char UUID prefix
 * disambiguates users with the same local-part across servers. Collisions are
 * possible but vanishingly rare, and the UNIQUE constraint on
 * `sftp_credentials.username` catches them. The mint path retries with a
 * numeric suffix if needed.
 */
export function buildSftpUsername(email: string, serverId: string): string {
  const localPart = email.split("@")[0]?.toLowerCase() ?? "user";
  const slug = localPart.replace(/[^a-z0-9]/g, "").slice(0, 24) || "user";
  const prefix = serverId.replace(/-/g, "").slice(0, 8).toLowerCase();
  return `${slug}-${prefix}`;
}
