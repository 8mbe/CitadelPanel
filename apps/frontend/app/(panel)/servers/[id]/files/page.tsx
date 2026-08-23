"use client";

import { Suspense } from "react";

import { FilesManager } from "@/components/server/files-manager";
import { useServerData } from "@/components/server/server-data-context";

/**
 * The files section: a file manager for the server's data directory. Supports
 * browsing, multi-select, download, clone, move, rename, delete, inline
 * text-file editing, and SFTP access (via the toolbar button → modal). Data
 * comes from the shared server context the layout provides; only the server id
 * is needed to address the file endpoints.
 *
 * The manager reads the open directory/file out of the query string (so browser
 * back/forward navigate the tree), which means it must sit under a Suspense
 * boundary: `useSearchParams` in a prerendered tree needs one.
 */
export default function FilesPage() {
  const { server } = useServerData();

  return (
    <Suspense fallback={null}>
      <FilesManager serverId={server.id} />
    </Suspense>
  );
}
