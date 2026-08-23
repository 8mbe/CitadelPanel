"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import {
  ChevronRight,
  Copy,
  Download,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  MoreHorizontal,
  Pencil,
  Trash2,
  ArrowRightLeft,
  Server,
  ArrowUp,
  Home,
  Upload,
  UploadCloud,
  Link2,
  KeyRound,
  RefreshCw,
  Plus,
  Loader2,
  ExternalLink,
} from "lucide-react";

import { ApiError, getPublicSettings } from "@/lib/api";
import {
  copyServerFile,
  createServerDirectory,
  deleteServerFiles,
  downloadServerFiles,
  listServerFiles,
  pullServerFileFromUrl,
  renameServerFile,
  uploadServerFile,
  writeServerFile,
} from "@/lib/api";
import {
  createSftpCredential,
  deleteSftpCredential,
  getSftpConnection,
  listSftpCredentials,
  regenerateSftpCredential,
  type SftpConnection,
  type SftpCredentialSummary,
} from "@/lib/api";
import { formatBytes, formatRelative } from "@/lib/format";
import type { FileEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

// The code editor (CodeMirror) and the in-place editor view are heavy and
// rarely the first thing a user needs, so they are split into lazy chunks.
// `ssr: false` keeps CodeMirror's DOM-dependent module out of the server bundle.
const FileEditor = nextDynamic(() => import("./file-editor"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[calc(100dvh-13rem)] min-h-[26rem] items-center justify-center rounded-xl border bg-card text-muted-foreground ring-1 ring-foreground/5">
      <Spinner className="size-5" />
    </div>
  ),
});

const CodeEditor = nextDynamic(() => import("@/components/code-editor"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Spinner className="size-5" />
    </div>
  ),
});

// ---------------------------------------------------------------------------
// Path helpers — the agent speaks POSIX paths rooted at the server data dir.
// ---------------------------------------------------------------------------

/** Join a POSIX directory path with a name segment, normalising the result. */
function posixJoin(base: string, name: string): string {
  // Strip any leading slashes on `name` so posixJoin("/config", "/foo") does
  // not produce a double slash.
  const clean = name.replace(/^\/+/, "");
  if (base === "/") return `/${clean}`;
  return `${base}/${clean}`;
}

/** The parent of a POSIX path, with "/" as the root's parent. */
function posixParent(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

/** The basename of a POSIX path. */
function posixBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Split a path into breadcrumb segments: "/a/b" -> [{name:"a", path:"/a"}, ...]. */
function pathSegments(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const segments: { name: string; path: string }[] = [];
  let current = "";
  for (const part of parts) {
    current = current === "" ? `/${part}` : `${current}/${part}`;
    segments.push({ name: part, path: current });
  }
  return segments;
}

/**
 * Normalise a directory path that came in from the URL. Query strings are
 * user-editable, so anything unusable (missing, relative, trailing slashes,
 * `..` segments) collapses to the root rather than being sent to the agent —
 * which would reject it anyway, but as an error banner instead of a listing.
 */
function normalizeDir(raw: string | null): string {
  if (!raw) return "/";
  const parts = raw.split("/").filter((part) => part !== "" && part !== "." && part !== "..");
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/**
 * Suggest a "copy of <name>" basename for the clone action.
 *
 * Returns just the new name (not a full path) so the folder-picker dialog can
 * treat it as the basename inside the chosen directory.
 */
function suggestCopyName(originalPath: string): string {
  const base = posixBasename(originalPath);
  return `${base} copy`;
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

/**
 * Server file manager.
 *
 * Browses a server's data directory through the panel's BFF (which proxies to
 * the node agent). Supports multi-select, a floating action bar for bulk
 * operations, and per-row dropdown actions: download, clone, move, rename,
 * delete. Move/clone use a folder-picker dialog that lets the user navigate
 * the tree rather than typing a path. Clicking a file opens the in-place
 * code editor (file-editor.tsx), which replaces the listing while open.
 *
 * The SFTP button shows an info dialog with connection details — there is no
 * SFTP server in the stack, so it surfaces the node's hostname and the panel's
 * file manager as the supported access method.
 */
export function FilesManager({ serverId }: { serverId: string }) {
  const searchParams = useSearchParams();

  // Where the user is lives in the URL, not in component state, so the
  // browser's own back/forward buttons walk the file tree: `?path=<dir>` is the
  // open directory and `?file=<path>` is the file open in the editor (whose
  // directory is implied by its parent, so the two never disagree). Deep links
  // and refreshes land where they should for free.
  const fileParam = normalizeDir(searchParams.get("file"));
  const filePath = fileParam === "/" ? null : fileParam;
  const path = filePath ? posixParent(filePath) : normalizeDir(searchParams.get("path"));

  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  // The active modal. Only one is open at a time; `null` means none.
  const [modal, setModal] = React.useState<
    | { type: "newFile" }
    | { type: "newFolder" }
  | { type: "rename"; entry: FileEntry }
  | { type: "move"; entries: FileEntry[] }
  | { type: "clone"; entries: FileEntry[] }
  | { type: "delete"; entries: FileEntry[] }
    | { type: "sftp" }
    | { type: "upload"; initialFiles?: File[] }
    | null
  >(null);

  // The server-side upload size cap, fetched once so the client can reject an
  // oversized file before any bytes are sent. `null` while loading; a missing
  // value (older panel) falls back to no client-side pre-check.
  const [uploadLimit, setUploadLimit] = React.useState<number | null>(null);
  React.useEffect(() => {
    getPublicSettings()
      .then((s) => setUploadLimit(s.uploadMaxBytes))
      .catch(() => {
        // Non-fatal: uploads still work, just without a client-side cap.
      });
  }, []);

  // --- Data fetching ---------------------------------------------------------

  // Which listing request is the current one. Back/forward can outrun the
  // network — hold the button and several directories are in flight at once —
  // so a response that is no longer the directory on screen is dropped instead
  // of overwriting a newer listing.
  const requestRef = React.useRef(0);

  const refresh = React.useCallback(
    async (dir: string) => {
      const token = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const listing = await listServerFiles(serverId, dir);
        if (token !== requestRef.current) return;
        setEntries(listing.entries);
      } catch (err) {
        if (token !== requestRef.current) return;
        setError(err instanceof ApiError ? err.message : "Failed to load files.");
        setEntries([]);
      } finally {
        if (token === requestRef.current) setLoading(false);
      }
    },
    [serverId],
  );

  React.useEffect(() => {
    void refresh(path);
    // Clear selection when navigating.
    setSelected(new Set());
  }, [path, refresh]);

  // --- Selection -------------------------------------------------------------

  const toggleSelect = (entryPath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(entries.filter((e) => e.type !== "other").map((e) => e.path)));
  };

  const clearSelection = () => setSelected(new Set());

  const selectedEntries = entries.filter((e) => selected.has(e.path));
  const allSelectable = entries.filter((e) => e.type !== "other");
  const allSelected =
    allSelectable.length > 0 && allSelectable.every((e) => selected.has(e.path));

  // --- Navigation -----------------------------------------------------------

  /**
   * Move to a directory or a file by rewriting the query string.
   *
   * The native History API is used rather than `router.push` on purpose: the
   * route's server components don't depend on these params, so a folder click
   * should cost one listing request, not an extra RSC round trip. Next.js syncs
   * `useSearchParams` with `pushState`/`replaceState`, so this still re-renders.
   */
  const navigate = React.useCallback(
    (next: { path: string } | { file: string }, replace = false) => {
      const params = new URLSearchParams(
        "file" in next ? { file: next.file } : { path: next.path },
      );
      // Slashes are legal unescaped in a query value, and paths are the whole
      // point of this URL — keep it readable/shareable instead of %2F soup.
      const url = `?${params.toString().replace(/%2F/g, "/")}`;
      if (replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    },
    [],
  );

  const openEntry = (entry: FileEntry) => {
    if (entry.type === "directory") {
      navigate({ path: entry.path });
    } else if (entry.type === "file") {
      navigate({ file: entry.path });
    }
  };

  // The file open in the editor is resolved from the listing rather than stored
  // separately, so its row metadata (mtime) stays truthful after a save and a
  // deep link gets the same editor as a click. Until the parent directory's
  // listing lands there is nothing to resolve, so the listing's own spinner
  // shows first.
  const editing = filePath ? entries.find((entry) => entry.path === filePath) ?? null : null;

  // A `file` param with no matching row — a stale link, or the file was deleted
  // or renamed from another tab — drops back to the directory instead of
  // sitting on an empty editor. Replace, so back still leaves the page.
  React.useEffect(() => {
    if (!filePath || loading || error) return;
    if (entries.some((entry) => entry.path === filePath)) return;
    navigate({ path: posixParent(filePath) }, true);
  }, [filePath, loading, error, entries, navigate]);

  // --- Actions ---------------------------------------------------------------

  const runWithBusy = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh(path);
      clearSelection();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Operation failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (toDelete: FileEntry[]) => {
    await runWithBusy(async () => {
      await deleteServerFiles(serverId, toDelete.map((entry) => entry.path));
    });
  };

  const handleRename = async (entry: FileEntry, newName: string) => {
    const parent = posixParent(entry.path);
    const to = posixJoin(parent, newName);
    await runWithBusy(async () => {
      await renameServerFile(serverId, entry.path, to);
    });
  };

  const handleMove = async (toMove: FileEntry[], destDir: string) => {
    await runWithBusy(async () => {
      for (const entry of toMove) {
        const to = posixJoin(destDir, posixBasename(entry.path));
        await renameServerFile(serverId, entry.path, to);
      }
    });
  };

  const handleClone = async (toClone: FileEntry[], destPath: string) => {
    await runWithBusy(async () => {
      for (const entry of toClone) {
        // For a single item the destination is the full target path. For
        // multiple items the dest is a directory, so we append each basename.
        const to =
          toClone.length === 1 ? destPath : posixJoin(destPath, posixBasename(entry.path));
        await copyServerFile(serverId, entry.path, to);
      }
    });
  };

  const handleDownload = async (toDownload: FileEntry[]) => {
    setBusy(true);
    setError(null);
    try {
      const paths = toDownload.map((e) => e.path);
      const name =
        toDownload.length === 1
          ? posixBasename(toDownload[0]!.path)
          : "download";
      const blob = await downloadServerFiles(serverId, paths, name);
      // Trigger a browser download via an ephemeral anchor.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = toDownload.length === 1 ? name : `${name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleCreateFile = async (name: string, contents: string) => {
    await runWithBusy(async () => {
      await writeServerFile(serverId, posixJoin(path, name), contents);
    });
  };

  const handleCreateFolder = async (name: string) => {
    await runWithBusy(async () => {
      await createServerDirectory(serverId, posixJoin(path, name));
    });
  };

  const handleSaveFile = async (entry: FileEntry, contents: string) => {
    setBusy(true);
    try {
      await writeServerFile(serverId, entry.path, contents);
      // Keep the listing's size/mtime fresh for when the editor closes.
      // Errors propagate to the editor view, which owns their display.
      await refresh(path);
    } finally {
      setBusy(false);
    }
  };

  // --- Upload -------------------------------------------------------------

  /**
   * Upload a batch of files into the current directory, sequencing them one at
   * a time. Each file's progress is tracked individually; the caller passes an
   * `onProgress` callback that updates the modal's file list. A failure on one
   * file does not abort the rest — partial progress is more useful than an
   * all-or-nothing batch, and the user can see exactly which files failed.
   *
   * Returns the list of files that uploaded successfully, so the caller can
   * decide whether to close the modal or leave it open for a retry.
   */
  const uploadFiles = async (
    files: File[],
    onProgress: (file: File, loaded: number, total: number) => void,
  ): Promise<{ succeeded: File[]; failed: { file: File; error: string }[] }> => {
    const succeeded: File[] = [];
    const failed: { file: File; error: string }[] = [];
    for (const file of files) {
      // Pre-validate against the server-side cap so an obviously-oversized
      // file is rejected before any bytes hit the network. The agent checks
      // again during the stream.
      if (uploadLimit !== null && file.size > uploadLimit) {
        failed.push({
          file,
          error: `File is ${formatBytes(file.size)}, which exceeds the ${formatBytes(uploadLimit)} limit.`,
        });
        continue;
      }
      try {
        await uploadServerFile(serverId, posixJoin(path, file.name), file, (loaded, total) =>
          onProgress(file, loaded, total),
        );
        succeeded.push(file);
      } catch (err) {
        failed.push({
          file,
          error: err instanceof ApiError ? err.message : "Upload failed.",
        });
      }
    }
    if (succeeded.length > 0) {
      await refresh(path);
    }
    return { succeeded, failed };
  };

  /** Pull a remote URL into the current directory. */
  const pullFromUrl = async (fileName: string, url: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await pullServerFileFromUrl(serverId, posixJoin(path, fileName), url);
      await refresh(path);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Pull failed.");
      throw err;
    } finally {
      setBusy(false);
    }
  };

  // --- Render ---------------------------------------------------------------

  // The editor replaces the listing entirely — files get the full content
  // width while being edited.
  if (editing) {
    return (
      <FileEditor
        key={editing.path}
        serverId={serverId}
        entry={editing}
        busy={busy}
        onBack={() => navigate({ path })}
        onSave={(contents) => handleSaveFile(editing, contents)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: breadcrumb + action buttons */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Breadcrumb path={path} onNavigate={(dir) => navigate({ path: dir })} />
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setModal({ type: "newFile" })}>
            <FilePlus className="size-4" />
            File
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setModal({ type: "newFolder" })}>
            <FolderPlus className="size-4" />
            Folder
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setModal({ type: "upload" })}>
            <Upload className="size-4" />
            Upload
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setModal({ type: "sftp" })}>
            <Server className="size-4" />
            SFTP
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* File list — wrapped in a drop zone so files can be dragged onto it. */}
      <DropZone
        disabled={loading}
        // When files are dropped, hand them to the upload modal as the initial
        // selection so the user sees what will be uploaded before confirming.
        onDropFiles={(files) => setModal({ type: "upload", initialFiles: files })}
      >
        <div className="overflow-hidden rounded-xl border bg-card ring-1 ring-foreground/5">
          {loading ? (
            <div className="flex h-48 items-center justify-center text-muted-foreground">
              <Spinner className="size-5" />
              <span className="ml-2 text-sm">Loading files…</span>
            </div>
          ) : entries.length === 0 ? (
            <Empty className="min-h-[12rem]">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderOpen />
                </EmptyMedia>
                <EmptyTitle>This folder is empty</EmptyTitle>
                <EmptyDescription>
                  Create a file or folder, or upload one to get started.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <FileTable
              entries={entries}
              selected={selected}
              allSelected={allSelected}
              busy={busy}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={allSelected ? clearSelection : selectAll}
              onOpen={openEntry}
              onAction={(entry, action) => {
                switch (action) {
                  case "download":
                    void handleDownload([entry]);
                    break;
                  case "clone":
                    setModal({ type: "clone", entries: [entry] });
                    break;
                  case "move":
                    setModal({ type: "move", entries: [entry] });
                    break;
                  case "rename":
                    setModal({ type: "rename", entry });
                    break;
                  case "delete":
                    setModal({ type: "delete", entries: [entry] });
                    break;
                  case "edit":
                    navigate({ file: entry.path });
                    break;
                }
              }}
            />
          )}
        </div>
      </DropZone>

      {/* Floating action bar */}
      {selectedEntries.length > 0 && (
        <FloatingActionBar
          count={selectedEntries.length}
          busy={busy}
          onClear={clearSelection}
          onDownload={() => void handleDownload(selectedEntries)}
          onClone={() => setModal({ type: "clone", entries: selectedEntries })}
          onMove={() => setModal({ type: "move", entries: selectedEntries })}
          onDelete={() => setModal({ type: "delete", entries: selectedEntries })}
        />
      )}

      {/* Modals */}
      {modal?.type === "newFile" && (
        <NewFileModal
          onClose={() => setModal(null)}
          onCreate={async (name, contents) => {
            await handleCreateFile(name, contents);
            setModal(null);
          }}
          busy={busy}
        />
      )}
      {modal?.type === "newFolder" && (
        <NewFolderModal
          onClose={() => setModal(null)}
          onCreate={async (name) => {
            await handleCreateFolder(name);
            setModal(null);
          }}
          busy={busy}
        />
      )}
      {modal?.type === "rename" && (
        <RenameModal
          entry={modal.entry}
          onClose={() => setModal(null)}
          onRename={async (name) => {
            await handleRename(modal.entry, name);
            setModal(null);
          }}
          busy={busy}
        />
      )}
      {modal?.type === "move" && (
        <FolderPickerModal
          title="Move"
          description={`Move ${modal.entries.length === 1 ? `"${posixBasename(modal.entries[0]!.path)}"` : `${modal.entries.length} items`} to a new folder.`}
          serverId={serverId}
          startPath={posixParent(modal.entries[0]!.path)}
          excludePaths={modal.entries.map((e) => e.path)}
          confirmLabel="Move here"
          onClose={() => setModal(null)}
          onConfirm={async (dest) => {
            await handleMove(modal.entries, dest);
            setModal(null);
          }}
          busy={busy}
        />
      )}
      {modal?.type === "clone" && (
        <FolderPickerModal
          title="Clone"
          description={`Copy ${modal.entries.length === 1 ? `"${posixBasename(modal.entries[0]!.path)}"` : `${modal.entries.length} items`} to a new location.`}
          serverId={serverId}
          startPath={posixParent(modal.entries[0]!.path)}
          excludePaths={modal.entries.map((e) => e.path)}
          confirmLabel="Clone here"
          allowNameEdit={modal.entries.length === 1}
          defaultName={modal.entries.length === 1 ? suggestCopyName(modal.entries[0]!.path) : undefined}
          onClose={() => setModal(null)}
          onConfirm={async (dest) => {
            await handleClone(modal.entries, dest);
            setModal(null);
          }}
          busy={busy}
        />
      )}
      {modal?.type === "delete" && (
        <DeleteModal
          entries={modal.entries}
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await handleDelete(modal.entries);
            setModal(null);
          }}
          busy={busy}
        />
      )}
      {modal?.type === "upload" && (
        <UploadModal
          uploadLimit={uploadLimit}
          initialFiles={modal.initialFiles}
          onClose={() => setModal(null)}
          onUpload={async (files, onProgress) => {
            const { failed } = await uploadFiles(files, onProgress);
            // Close only if everything succeeded; otherwise leave the modal open
            // so the user can see which files failed and retry or dismiss.
            return failed;
          }}
          onPull={async (fileName, url) => {
            await pullFromUrl(fileName, url);
          }}
          busy={busy}
        />
      )}
      {modal?.type === "sftp" && <SftpModal serverId={serverId} onClose={() => setModal(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

function Breadcrumb({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const segments = pathSegments(path);
  return (
    <nav className="flex items-center gap-1 overflow-x-auto text-sm">
      <button
        onClick={() => onNavigate("/")}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Home className="size-3.5" />
        <span className="sr-only sm:not-sr-only">Root</span>
      </button>
      {segments.map((seg) => (
        <React.Fragment key={seg.path}>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
          <button
            onClick={() => onNavigate(seg.path)}
            className="max-w-[12rem] truncate rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {seg.name}
          </button>
        </React.Fragment>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// File table
// ---------------------------------------------------------------------------

function FileTable({
  entries,
  selected,
  allSelected,
  busy,
  onToggleSelect,
  onToggleSelectAll,
  onOpen,
  onAction,
}: {
  entries: FileEntry[];
  selected: Set<string>;
  allSelected: boolean;
  busy: boolean;
  onToggleSelect: (path: string) => void;
  onToggleSelectAll: () => void;
  onOpen: (entry: FileEntry) => void;
  onAction: (entry: FileEntry, action: FileAction) => void;
}) {
  return (
    <div className="divide-y">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
        <Checkbox checked={allSelected} onCheckedChange={onToggleSelectAll} aria-label="Select all" />
        <span className="flex-1">Name</span>
        <span className="hidden w-24 text-right sm:block">Size</span>
        <span className="hidden w-28 text-right md:block">Modified</span>
        <span className="w-8" />
      </div>
      {/* Rows */}
      {entries.map((entry) => {
        const isSelected = selected.has(entry.path);
        const isDir = entry.type === "directory";
        return (
          <div
            key={entry.path}
            className={cn(
              "group flex items-center gap-2 px-3 py-2 transition-colors",
              isSelected ? "bg-accent/50" : "hover:bg-muted/40",
            )}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleSelect(entry.path)}
              aria-label={`Select ${entry.name}`}
            />
            <button
              onClick={() => onOpen(entry)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              {isDir ? (
                <Folder className="size-4 shrink-0 text-primary/70" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate text-sm">{entry.name}</span>
            </button>
            <span className="hidden w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
              {isDir ? "—" : formatBytes(entry.sizeBytes)}
            </span>
            <span className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground md:block">
              {formatRelative(entry.modifiedAt)}
            </span>
            <div className="w-8 shrink-0">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={`Actions for ${entry.name}`}
                    />
                  }
                >
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onAction(entry, "download")}>
                    <Download className="size-4" />
                    Download
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onAction(entry, "clone")}>
                    <Copy className="size-4" />
                    Clone
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onAction(entry, "move")}>
                    <ArrowRightLeft className="size-4" />
                    Move
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onAction(entry, "rename")}>
                    <Pencil className="size-4" />
                    Rename
                  </DropdownMenuItem>
                  {!isDir && (
                    <DropdownMenuItem onClick={() => onAction(entry, "edit")}>
                      <FileIcon className="size-4" />
                      Edit
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => onAction(entry, "delete")}
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type FileAction = "download" | "clone" | "move" | "rename" | "delete" | "edit";

// ---------------------------------------------------------------------------
// Floating action bar
// ---------------------------------------------------------------------------

function FloatingActionBar({
  count,
  busy,
  onClear,
  onDownload,
  onClone,
  onMove,
  onDelete,
}: {
  count: number;
  busy: boolean;
  onClear: () => void;
  onDownload: () => void;
  onClone: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-1 rounded-xl border bg-popover/80 p-1.5 shadow-lg ring-1 ring-foreground/10 backdrop-blur-xl">
        <span className="px-2 text-sm font-medium tabular-nums">
          {count} selected
        </span>
        <div className="mx-1 h-5 w-px bg-border" />
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onDownload}>
          <Download className="size-4" />
          <span className="hidden sm:inline">Download</span>
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClone}>
          <Copy className="size-4" />
          <span className="hidden sm:inline">Clone</span>
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onMove}>
          <ArrowRightLeft className="size-4" />
          <span className="hidden sm:inline">Move</span>
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onDelete}>
          <Trash2 className="size-4 text-destructive" />
          <span className="hidden sm:inline text-destructive">Delete</span>
        </Button>
        <div className="mx-1 h-5 w-px bg-border" />
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear selection">
          ×
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Folder picker — used by Move and Clone
// ---------------------------------------------------------------------------

function FolderPickerModal({
  title,
  description,
  serverId,
  startPath,
  excludePaths,
  confirmLabel,
  allowNameEdit = false,
  defaultName,
  onClose,
  onConfirm,
  busy,
}: {
  title: string;
  description: string;
  serverId: string;
  startPath: string;
  /** Paths the user cannot move/clone *into* (the items themselves, to prevent
   * moving a folder into itself). */
  excludePaths: string[];
  confirmLabel: string;
  allowNameEdit?: boolean;
  defaultName?: string;
  onClose: () => void;
  onConfirm: (destPath: string) => Promise<void>;
  busy: boolean;
}) {
  const [current, setCurrent] = React.useState(startPath);
  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [name, setName] = React.useState(defaultName ?? "");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listServerFiles(serverId, current)
      .then((listing) => {
        if (cancelled) return;
        setEntries(listing.entries.filter((e) => e.type === "directory"));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to load.");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [serverId, current]);

  // A directory is disabled if it is one of the items being moved (can't move
  // a folder into itself), or — for the single-item rename case — if it's the
  // source's own parent (no-op move).
  const isDisabled = (dir: FileEntry): boolean => {
    if (excludePaths.includes(dir.path)) return true;
    if (excludePaths.some((p) => dir.path.startsWith(p + "/"))) return true;
    return false;
  };

  const handleConfirm = async () => {
    // When name editing is allowed (single clone), `name` is the full target
    // path's basename; otherwise the dest is the current directory + the item's
    // own basename (applied by the caller).
    if (allowNameEdit && name.trim().length === 0) {
      setError("Enter a name for the clone.");
      return;
    }
    const dest = allowNameEdit ? posixJoin(current, name.trim()) : current;
    await onConfirm(dest);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Current path breadcrumb + up button */}
        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={current === "/"}
            onClick={() => setCurrent(posixParent(current))}
            aria-label="Go up"
          >
            <ArrowUp className="size-4" />
          </Button>
          <div className="flex items-center gap-1 overflow-x-auto text-sm text-muted-foreground">
            <button
              onClick={() => setCurrent("/")}
              className="flex items-center gap-1 rounded px-1 hover:text-foreground"
            >
              <Home className="size-3.5" />
            </button>
            {pathSegments(current).map((seg) => (
              <React.Fragment key={seg.path}>
                <ChevronRight className="size-3 shrink-0" />
                <button
                  onClick={() => setCurrent(seg.path)}
                  className="max-w-[10rem] truncate rounded px-1 hover:text-foreground"
                >
                  {seg.name}
                </button>
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Folder list */}
        <div className="h-56 overflow-y-auto rounded-lg border">
          {loading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Spinner className="size-4" />
              <span className="ml-2 text-sm">Loading…</span>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No subfolders here.
            </div>
          ) : (
            <div className="divide-y">
              {entries.map((dir) => {
                const disabled = isDisabled(dir);
                return (
                  <button
                    key={dir.path}
                    disabled={disabled}
                    onDoubleClick={() => !disabled && setCurrent(dir.path)}
                    onClick={() => !disabled && setCurrent(dir.path)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                      disabled
                        ? "cursor-not-allowed opacity-40"
                        : "hover:bg-muted/60",
                    )}
                  >
                    <Folder className="size-4 shrink-0 text-primary/70" />
                    <span className="truncate">{dir.name}</span>
                    <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground/50" />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Name field (single-item clone only) */}
        {allowNameEdit && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              New name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="copy name"
            />
          </div>
        )}

        {/* Selected target summary */}
        <p className="text-xs text-muted-foreground">
          Target: <span className="font-mono">{allowNameEdit ? posixJoin(current, name || "…") : current}</span>
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// New File / New Folder / Rename / Delete / Edit / SFTP modals
// ---------------------------------------------------------------------------

function NewFileModal({
  onClose,
  onCreate,
  busy,
}: {
  onClose: () => void;
  onCreate: (name: string, contents: string) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = React.useState("");
  const [contents, setContents] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (name.trim().length === 0) {
      setError("Enter a file name.");
      return;
    }
    if (name.includes("/")) {
      setError("File name must not contain a slash.");
      return;
    }
    try {
      await onCreate(name.trim(), contents);
    } catch {
      setError("Failed to create file.");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New file</DialogTitle>
          <DialogDescription>Create a text file in this folder.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="filename.txt"
            autoFocus
          />
          <div className="h-56 overflow-hidden rounded-lg border">
            <CodeEditor
              value={contents}
              filename={name.trim() || undefined}
              wrap
              onChange={setContents}
              onSave={() => void submit()}
            />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Create file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewFolderModal({
  onClose,
  onCreate,
  busy,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (name.trim().length === 0) {
      setError("Enter a folder name.");
      return;
    }
    if (name.includes("/")) {
      setError("Folder name must not contain a slash.");
      return;
    }
    try {
      await onCreate(name.trim());
    } catch {
      setError("Failed to create folder.");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>Create a folder in this directory.</DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="folder name"
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Create folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameModal({
  entry,
  onClose,
  onRename,
  busy,
}: {
  entry: FileEntry;
  onClose: () => void;
  onRename: (newName: string) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = React.useState(posixBasename(entry.path));
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (name.trim().length === 0) {
      setError("Enter a name.");
      return;
    }
    if (name.includes("/")) {
      setError("Name must not contain a slash.");
      return;
    }
    try {
      await onRename(name.trim());
    } catch {
      setError("Failed to rename. A name collision may exist.");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription>
            Rename {entry.type === "directory" ? "folder" : "file"} "{posixBasename(entry.path)}".
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteModal({
  entries,
  onClose,
  onConfirm,
  busy,
}: {
  entries: FileEntry[];
  onClose: () => void;
  onConfirm: () => Promise<void>;
  busy: boolean;
}) {
  const multiple = entries.length > 1;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {multiple ? `${entries.length} items` : "item"}</DialogTitle>
          <DialogDescription>
            {multiple
              ? "This will permanently delete the selected files and folders."
              : `This will permanently delete "${posixBasename(entries[0]!.path)}".`}
            {entries.some((e) => e.type === "directory") && " Folders are deleted recursively."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SftpModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [connection, setConnection] = React.useState<SftpConnection | null>(null);
  const [credentials, setCredentials] = React.useState<SftpCredentialSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // The plaintext password from the most recent create/regenerate, shown in a
  // nested one-shot dialog until the user dismisses it.
  const [revealed, setRevealed] = React.useState<{
    password: string;
    username: string;
    isNew: boolean;
  } | null>(null);
  const [pending, setPending] = React.useState<"create" | "regenerate" | null>(null);

  // Delete confirmation state.
  const [deleteTarget, setDeleteTarget] = React.useState<SftpCredentialSummary | null>(null);
  const [deletePending, setDeletePending] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [conn, creds] = await Promise.all([
        getSftpConnection(serverId),
        listSftpCredentials(serverId),
      ]);
      setConnection(conn);
      setCredentials(creds);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not load SFTP details.",
      );
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    setPending("create");
    setError(null);
    try {
      const cred = await createSftpCredential(serverId);
      setRevealed({ password: cred.password, username: cred.username, isNew: true });
      void refresh();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not create SFTP credential.",
      );
    } finally {
      setPending(null);
    }
  }

  async function handleRegenerate() {
    setPending("regenerate");
    setError(null);
    try {
      const cred = await regenerateSftpCredential(serverId);
      setRevealed({ password: cred.password, username: cred.username, isNew: false });
      void refresh();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not regenerate SFTP password.",
      );
    } finally {
      setPending(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeletePending(true);
    setError(null);
    try {
      await deleteSftpCredential(serverId, deleteTarget.id);
      setDeleteTarget(null);
      void refresh();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not delete SFTP credential.",
      );
    } finally {
      setDeletePending(false);
    }
  }

  const hasOwn = connection?.hasCredential ?? false;
  // An sftp:// URL that opens in the OS's default SFTP client (FileZilla, etc.).
  // We omit the password from the URL for security — the user pastes it in the
  // client. Including it would leave the password in browser history / logs.
  const sftpUrl = connection?.username
    ? `sftp://${connection.username}@${connection.hostname}:${connection.port}`
    : null;

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Server className="size-4" />
              SFTP access
            </DialogTitle>
            <DialogDescription>
              Connect to this server&apos;s files over SFTP with any standard
              client. Sessions are chrooted to the server&apos;s data directory.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}

              {/* Connection details */}
              {connection && (
                <div className="grid gap-2 rounded-lg border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Host</span>
                    <CopyableCode value={connection.hostname} />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Port</span>
                    <CopyableCode value={String(connection.port)} />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Username</span>
                    <CopyableCode
                      value={connection.username ?? "— (no credential yet)"}
                    />
                  </div>
                  {sftpUrl && (
                    <div className="flex items-center justify-between gap-2 border-t pt-2">
                      <span className="text-muted-foreground">Open in app</span>
                      <div className="flex items-center gap-1">
                        <code className="truncate font-mono text-xs text-muted-foreground">
                          {sftpUrl}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          render={<a href={sftpUrl} />}
                          nativeButton={false}
                          aria-label="Open in SFTP client"
                          title="Open in your default SFTP application"
                        >
                          <ExternalLink className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-wrap gap-2">
                {!hasOwn ? (
                  <Button onClick={handleCreate} disabled={pending !== null} size="sm">
                    {pending === "create" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    Create credential
                  </Button>
                ) : (
                  <Button
                    onClick={handleRegenerate}
                    disabled={pending !== null}
                    variant="outline"
                    size="sm"
                  >
                    {pending === "regenerate" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    Regenerate password
                  </Button>
                )}
              </div>

              {/* Credential list */}
              {credentials.length > 0 && (
                <div className="flex flex-col gap-1">
                  <div className="text-sm font-medium">
                    Credentials {credentials.length > 1 && `(${credentials.length})`}
                  </div>
                  <ul className="flex flex-col divide-y rounded-lg border">
                    {credentials.map((cred) => (
                      <li
                        key={cred.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <code className="truncate font-mono text-xs">
                            {cred.username}
                          </code>
                          <span className="text-xs text-muted-foreground">
                            {cred.userEmail} · updated {formatRelative(cred.updatedAt)}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(cred)}
                          aria-label={`Delete credential ${cred.username}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                The password is shown only once when created or regenerated, and
                cannot be retrieved. Use port <code className="font-mono">8022</code>{" "}
                (or the node&apos;s configured SFTP port).
              </p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password reveal (nested) */}
      <Dialog
        open={revealed !== null}
        onOpenChange={(open) => {
          if (!open) setRevealed(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4" />
              {revealed?.isNew
                ? "SFTP credential created"
                : "Password regenerated"}
            </DialogTitle>
            <DialogDescription>
              Copy the password now — it is shown only this once and cannot be
              retrieved later.{" "}
              {revealed?.isNew
                ? ""
                : "The old password is no longer valid."}
            </DialogDescription>
          </DialogHeader>
          {revealed && (
            <div className="flex flex-col gap-3 py-2">
              <div className="grid gap-1">
                <label className="text-xs text-muted-foreground">Username</label>
                <CopyableCode value={revealed.username} input />
              </div>
              <div className="grid gap-1">
                <label className="text-xs text-muted-foreground">Password</label>
                <CopyableCode value={revealed.password} input mono />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation (nested) */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete SFTP credential?</DialogTitle>
            <DialogDescription>
              The credential{" "}
              <code className="font-mono">{deleteTarget?.username}</code> will
              stop working immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={deletePending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deletePending}
            >
              {deletePending && <Loader2 className="size-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A small copy-to-clipboard code chip, or an input variant for longer values. */
function CopyableCode({
  value,
  input,
  mono,
}: {
  value: string;
  input?: boolean;
  mono?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context).
    }
  }

  if (input) {
    return (
      <div className="flex w-full max-w-[16rem] gap-1">
        <Input
          value={value}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          className={mono ? "font-mono text-xs" : "text-xs"}
        />
        <Button variant="outline" size="icon" onClick={copy} aria-label="Copy">
          {copied ? (
            <span className="text-xs text-green-600">✓</span>
          ) : (
            <Copy className="size-3.5" />
          )}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <code className={`font-mono text-xs ${mono ? "" : ""}`}>{value}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={copy}
        aria-label="Copy"
        className="size-6"
      >
        {copied ? (
          <span className="text-xs text-green-600">✓</span>
        ) : (
          <Copy className="size-3" />
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drop zone — wraps the file list so files can be dragged onto it to upload
// ---------------------------------------------------------------------------

/**
 * A drag-and-drop target that wraps the file list.
 *
 * Only reacts to files dragged from the host (a `detail` of 0 means "not a
 * file drop", e.g. an element being dragged within the page). When files land,
 * `onDropFiles` fires with the `FileList`; the parent decides what to do with
 * them (here: open the upload modal pre-populated).
 *
 * `disabled` skips the handlers entirely so a still-loading list doesn't
 * intercept drags meant for something else.
 */
function DropZone({
  disabled,
  onDropFiles,
  children,
}: {
  disabled?: boolean;
  onDropFiles: (files: File[]) => void;
  children: React.ReactNode;
}) {
  const [dragging, setDragging] = React.useState(false);
  // A counter rather than a boolean-on-enter: dragenter fires for every child
  // element, so a naive toggle would flip false when the cursor moves from the
  // border onto a row inside. The counter stays >0 for the whole gesture.
  const dragCounter = React.useRef(0);

  // If the drop happens outside this component (e.g. the user drops on the
  // window chrome and releases), the counter can be left stale. Reset on a
  // window-level drop/dragend to recover.
  React.useEffect(() => {
    if (disabled) return;
    const reset = () => {
      dragCounter.current = 0;
      setDragging(false);
    };
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, [disabled]);

  if (disabled) return <>{children}</>;

  return (
    <div
      onDragEnter={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          dragCounter.current += 1;
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          dragCounter.current -= 1;
          if (dragCounter.current <= 0) {
            dragCounter.current = 0;
            setDragging(false);
          }
        }
      }}
      onDragOver={(e) => {
        // preventDefault is required for the drop event to fire.
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          dragCounter.current = 0;
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length > 0) onDropFiles(files);
        }
      }}
      className="relative"
    >
      {children}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-primary">
            <UploadCloud className="size-8" />
            <span className="text-sm font-medium">Drop files to upload</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload modal — file picker / drag-drop + pull from URL
// ---------------------------------------------------------------------------

/**
 * Upload state for a single file in the queue.
 *
 * `done` and `error` are terminal; `progress`/`total` are live during upload.
 */
interface UploadItem {
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  loaded: number;
  total: number;
  error?: string;
}

/**
 * Upload modal with two tabs: upload files (picker or drag-drop) and pull from
 * URL (the panel fetches server-side). Shows per-file progress for uploads and
 * pre-validates each file against the server-side size cap before sending.
 *
 * The modal stays open after an upload batch finishes so the user can see the
 * results; a Close button dismisses it. Files that failed can be retried by
 * starting another upload (they remain in the file input).
 */
function UploadModal({
  uploadLimit,
  initialFiles,
  onClose,
  onUpload,
  onPull,
  busy,
}: {
  uploadLimit: number | null;
  initialFiles?: File[];
  onClose: () => void;
  /**
   * Upload a batch of files. Reports per-file progress via `onProgress`. Returns
   * the list of files that failed (so the modal can mark them and stay open).
   */
  onUpload: (
    files: File[],
    onProgress: (file: File, loaded: number, total: number) => void,
  ) => Promise<{ file: File; error: string }[]>;
  onPull: (fileName: string, url: string) => Promise<void>;
  busy: boolean;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Seed from drag-dropped files that opened the modal. Lazy initial state
  // (rather than a seeding effect) because `initialFiles` is fixed at mount —
  // the modal is remounted each time it opens.
  const [items, setItems] = React.useState<UploadItem[]>(() =>
    initialFiles && initialFiles.length > 0
      ? initialFiles.map((file) => ({ file, status: "pending", loaded: 0, total: file.size }))
      : [],
  );
  const [tab, setTab] = React.useState<"file" | "url">("file");

  // Pull-from-URL fields.
  const [url, setUrl] = React.useState("");
  const [urlName, setUrlName] = React.useState("");
  const [pullError, setPullError] = React.useState<string | null>(null);

  const addFiles = (files: FileList | File[]) => {
    const next = Array.from(files).map((file) => ({
      file,
      status: "pending" as const,
      loaded: 0,
      total: file.size,
    }));
    setItems((prev) => [...prev, ...next]);
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const pendingItems = items.filter((i) => i.status === "pending" || i.status === "error");

  const startUpload = async () => {
    const toUpload = items
      .filter((i) => i.status === "pending" || i.status === "error")
      .map((i) => i.file);

    if (toUpload.length === 0) return;

    // Mark them as uploading.
    setItems((prev) =>
      prev.map((i) =>
        i.status === "pending" || i.status === "error"
          ? { ...i, status: "uploading", loaded: 0, error: undefined }
          : i,
      ),
    );

    const failed = await onUpload(toUpload, (file, loaded, total) => {
      setItems((prev) =>
        prev.map((i) => (i.file === file ? { ...i, loaded, total } : i)),
      );
    });

    // Mark results: failed files keep their error; everything else is done.
    const failedFiles = new Map(failed.map((f) => [f.file, f.error]));
    setItems((prev) =>
      prev.map((i) => {
        if (i.status !== "uploading") return i;
        const err = failedFiles.get(i.file);
        return err
          ? { ...i, status: "error", error: err }
          : { ...i, status: "done", loaded: i.total };
      }),
    );
  };

  const submitPull = async () => {
    setPullError(null);
    if (url.trim().length === 0) {
      setPullError("Enter a URL.");
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setPullError("Enter a valid URL.");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setPullError("Only http(s) URLs are supported.");
      return;
    }
    const name = urlName.trim() || parsed.pathname.split("/").filter(Boolean).pop() || "download";
    try {
      await onPull(name, url.trim());
      onClose();
    } catch (err) {
      setPullError(err instanceof ApiError ? err.message : "Pull failed.");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="size-4" />
            Upload
          </DialogTitle>
          <DialogDescription>
            {uploadLimit !== null
              ? `Upload files or pull from a URL into this folder. Max ${formatBytes(uploadLimit)} per file.`
              : "Upload files or pull from a URL into this folder."}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "file" | "url")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="file">
              <Upload className="size-4" />
              Files
            </TabsTrigger>
            <TabsTrigger value="url">
              <Link2 className="size-4" />
              From URL
            </TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="mt-3">
            {/* Drop target inside the modal — drag files here to add them. */}
            <div
              onDragEnter={(e) => e.preventDefault()}
              onDragOver={(e) => {
                if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
              }}
              onDrop={(e) => {
                if (e.dataTransfer?.types?.includes("Files")) {
                  e.preventDefault();
                  addFiles(e.dataTransfer.files);
                }
              }}
              onClick={() => fileInputRef.current?.click()}
              className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border p-6 text-center transition-colors hover:border-primary/50 hover:bg-muted/40"
            >
              <UploadCloud className="size-6 text-muted-foreground" />
              <div className="text-sm">
                <span className="font-medium text-foreground">Click to choose</span>
                <span className="text-muted-foreground"> or drag files here</span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  // Reset so the same file can be re-selected later.
                  e.target.value = "";
                }}
              />
            </div>

            {/* File queue */}
            {items.length > 0 && (
              <div className="mt-3 max-h-56 space-y-1.5 overflow-y-auto">
                {items.map((item, index) => (
                  <UploadQueueRow
                    key={`${item.file.name}-${index}`}
                    item={item}
                    uploadLimit={uploadLimit}
                    onRemove={() => removeItem(index)}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="url" className="mt-3">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">URL</label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/world.zip"
                  autoFocus
                  spellCheck={false}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Save as <span className="text-muted-foreground/70">(optional)</span>
                </label>
                <Input
                  value={urlName}
                  onChange={(e) => setUrlName(e.target.value)}
                  placeholder="world.zip"
                  spellCheck={false}
                />
              </div>
              {pullError && <p className="text-sm text-destructive">{pullError}</p>}
              <p className="text-xs text-muted-foreground">
                The panel fetches the URL server-side, so large downloads don&apos;t
                go through your browser.
              </p>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {tab === "file" ? (
            <Button
              type="button"
              onClick={startUpload}
              disabled={busy || pendingItems.length === 0}
            >
              {busy && <Spinner className="size-4" />}
              Upload {pendingItems.length > 0 ? `${pendingItems.length} file${pendingItems.length === 1 ? "" : "s"}` : ""}
            </Button>
          ) : (
            <Button type="button" onClick={submitPull} disabled={busy}>
              {busy && <Spinner className="size-4" />}
              Pull
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One row in the upload queue: name, size, progress bar, status. */
function UploadQueueRow({
  item,
  uploadLimit,
  onRemove,
}: {
  item: UploadItem;
  uploadLimit: number | null;
  onRemove: () => void;
}) {
  const pct = item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : 0;
  const overLimit = uploadLimit !== null && item.file.size > uploadLimit;

  return (
    <div className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-sm">
      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate">{item.file.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatBytes(item.file.size)}
          </span>
        </div>
        {/* Progress / status line */}
        {item.status === "uploading" && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
        {item.status === "done" && (
          <p className="mt-0.5 text-xs text-emerald-600 dark:text-emerald-500">Uploaded</p>
        )}
        {item.status === "error" && (
          <p className="mt-0.5 truncate text-xs text-destructive">{item.error}</p>
        )}
        {item.status === "pending" && overLimit && (
          <p className="mt-0.5 text-xs text-destructive">
            Exceeds the {formatBytes(uploadLimit!)} limit
          </p>
        )}
      </div>
      {/* Remove button (disabled while uploading) */}
      <button
        onClick={onRemove}
        disabled={item.status === "uploading"}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        aria-label={`Remove ${item.file.name}`}
      >
        ×
      </button>
    </div>
  );
}
