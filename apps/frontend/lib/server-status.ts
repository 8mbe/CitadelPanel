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

/**
 * Client-side reading of the three statuses the archive owns. Mirrors
 * `serverManager.isArchiveStatus`.
 *
 * `archiving` and `restoring` are transfers in progress; `archived` is the
 * settled state where the server's files are in S3 and its node holds nothing.
 * Grouped because the shell treats them alike: there is no container to operate
 * in any of them, so every section of the page would be a row of errors.
 * See `docs/archive.md`.
 */
export function isArchiveStatus(status: ServerStatus): boolean {
  return status === "archiving" || status === "archived" || status === "restoring";
}

/** Whether a transfer to or from the archive is in flight right now. */
export function isArchiveTransfer(status: ServerStatus): boolean {
  return status === "archiving" || status === "restoring";
}
