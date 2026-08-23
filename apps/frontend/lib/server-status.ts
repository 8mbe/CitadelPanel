import type { ServerStatus } from "./types";

/**
 * Client-side reading of the two statuses that mean "the panel is still
 * building this server". It mirrors `serverManager.isProvisioning`.
 *
 * `creating` is the row and its ports; `installing` is the blueprint's install
 * script and the container build after it. The distinction matters to the
 * provisioning code and to nobody else: from the UI's side both mean there is no
 * container yet, so there is nothing to start, attach to, or configure. Treating
 * them as one phase is what lets a single gate cover the whole build.
 */
export function isProvisioning(status: ServerStatus): boolean {
  return status === "creating" || status === "installing";
}
