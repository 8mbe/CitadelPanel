/**
 * Client-side mapping of server-page sections to the permission that gates
 * them. This mirrors the backend's per-route checks (`routes/servers.ts`,
 * `routes/files.ts`, `routes/subusers.ts`) — it decides what the UI *shows*;
 * the API remains the enforcement point, so a stale or missing `viewer` can
 * never grant anything the backend would not allow.
 */

import type { ServerPermission, ServerViewerAccess } from "@/lib/types";

/** The sections of a server page, one route each. */
export const SERVER_SECTION_KEYS = [
  "console",
  "files",
  "plugins",
  "database",
  "ports",
  "subusers",
  "settings",
  "activity",
] as const;

export type ServerSectionKey = (typeof SERVER_SECTION_KEYS)[number];

/**
 * What a section requires:
 *   - `null`    — any access to the server (the `console` grant is the
 *                 baseline "can look at this server" permission)
 *   - `"owner"` — owner or admin only, never delegable to a subuser
 *   - a flag    — that subuser permission (owners/admins hold it implicitly)
 *
 * `ports` rides on `settings` because the backend gates the whole ports
 * endpoint (view and edit alike) on `settings`. `plugins` rides on `files`
 * because installing or removing a plugin is a filesystem write.
 */
export const SECTION_PERMISSIONS = {
  console: null,
  files: "files",
  plugins: "files",
  database: "database",
  ports: "settings",
  subusers: "owner",
  settings: "settings",
  activity: null,
} as const satisfies Record<ServerSectionKey, ServerPermission | "owner" | null>;

/**
 * Whether the viewer holds a specific permission. Owners and admins hold
 * everything implicitly; a subuser holds only the flags explicitly granted.
 * An undefined viewer means no access information came with the record —
 * treated as allowed so the UI fails open and the API's 403 is the limit.
 */
export function viewerAllows(
  viewer: ServerViewerAccess | undefined,
  permission: ServerPermission,
): boolean {
  if (!viewer) return true;
  if (viewer.kind === "owner" || viewer.kind === "admin") return true;
  return viewer.permissions[permission] === true;
}

/**
 * Whether the viewer is the owner or an admin — the gate on the actions that are
 * never delegable to a subuser, however many flags they hold: deleting a server,
 * reinstalling it, and managing who else may reach it. Fails open on an
 * undefined viewer, like {@link viewerAllows}.
 */
export function viewerIsOwner(viewer: ServerViewerAccess | undefined): boolean {
  if (!viewer) return true;
  return viewer.kind === "owner" || viewer.kind === "admin";
}

/**
 * Whether the viewer may open a server-page section. Like
 * {@link viewerAllows}, an undefined viewer means no access information came
 * with the record: the UI fails open and the API's 403 is the limit. When the
 * viewer *is* known, owner-only sections require the owner or admin kind.
 */
export function sectionAllowed(
  section: ServerSectionKey,
  viewer: ServerViewerAccess | undefined,
): boolean {
  if (!viewer) return true;
  const required = SECTION_PERMISSIONS[section];
  if (required === null) return true;
  if (required === "owner") return viewerIsOwner(viewer);
  return viewerAllows(viewer, required);
}
