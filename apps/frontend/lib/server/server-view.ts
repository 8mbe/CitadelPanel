import "server-only";

import { headers } from "next/headers";

import { toServerView } from "@/lib/api";
import { getAuthenticatedUser } from "@/lib/server/control-plane/auth/middleware";
import {
  accessAllows,
  resolveServerAccess,
} from "@/lib/server/control-plane/auth/rbac";
import { getServerReconciled } from "@/lib/server/control-plane/services/serverManager";
import type { ServerView } from "@/lib/types";

/**
 * Resolve the server detail view for the signed-in viewer, server-side.
 *
 * This is what the server page's layout calls instead of the browser calling
 * `GET /api/servers/:id`. Authorization is the same as that endpoint's.
 * `console` is the baseline "can look at this server" grant, and no access at
 * all returns null, so a missing server and an inaccessible one are
 * indistinguishable. The difference is that this runs during rendering, so
 * every section of the page can start fetching its own data immediately
 * instead of waiting for the shell's round trip first.
 *
 * The access check and the read start together (performance.md Rule 2). The
 * check still gates what is surfaced, and nothing is returned to a viewer
 * without access, the same compensation the polled stats endpoint already
 * relies on.
 */
export async function resolveServerView(
  serverId: string,
): Promise<ServerView | null> {
  const requestHeaders = await headers();
  const request = new Request("http://next.internal/", {
    headers: requestHeaders,
  });
  const user = await getAuthenticatedUser(request).catch(() => null);
  if (!user) return null;

  const accessPromise = resolveServerAccess(user, serverId);
  const summaryPromise = getServerReconciled(serverId).catch(() => null);

  const access = await accessPromise;
  if (!access || !accessAllows(access, "console")) return null;

  const summary = await summaryPromise;
  if (!summary) return null;

  // The API's JSON response carries ISO date strings; the in-process summary
  // carries Date objects. Convert here so the same display mapper applies.
  return {
    ...toServerView({
      ...summary,
      createdAt: summary.createdAt.toISOString(),
      suspendedAt: summary.suspendedAt?.toISOString() ?? null,
    }),
    viewer: { kind: access.kind, permissions: access.permissions },
  };
}
