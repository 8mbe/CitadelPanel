"use client";

import * as React from "react";
import { ArrowLeft, Download, FileWarning, Save, WrapText } from "lucide-react";

import { ApiError, downloadServerFiles, readServerFile } from "@/lib/api";
import { formatBytes, formatRelative } from "@/lib/format";
import type { FileEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

import CodeEditor from "@/components/code-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";

// Local copies of the POSIX path helpers in files-manager.tsx. Importing them
// from there would create a module cycle (files-manager lazy-loads this file).
function posixParent(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function posixBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Heuristic "is this actually text" check, run on what the server decoded as
 * UTF-8. The agent's read endpoint decodes everything as text (a small .jar
 * comes back as mojibake), so the client is the only place that can keep a
 * binary file from being silently re-encoded (and corrupted) on save: any NUL
 * byte or a noticeable share of U+FFFD replacement characters means binary.
 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8192);
  if (sample.includes("\u0000")) return true;
  let replacements = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0xfffd) replacements++;
  }
  return sample.length > 0 && replacements / sample.length > 0.01;
}

const isApple =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/**
 * Full-width in-place file editor (replaces the file list while open).
 *
 * Editing goes through the same panel endpoints the old textarea dialog used;
 * the upgrades are CodeMirror (syntax highlighting, search, …), dirty tracking
 * with Ctrl/Cmd+S and a discard guard, and a binary-file check so non-text
 * files can't be lossily rewritten as UTF-8.
 *
 * This module is lazy-loaded by files-manager.tsx; it statically imports the
 * (heavy) CodeEditor so CodeMirror stays out of the main bundle.
 */
export default function FileEditor({
  serverId,
  entry,
  busy,
  onBack,
  onSave,
}: {
  serverId: string;
  entry: FileEntry;
  busy: boolean;
  onBack: () => void;
  onSave: (contents: string) => Promise<void>;
}) {
  const [status, setStatus] = React.useState<"loading" | "ready" | "binary" | "error">(
    "loading",
  );
  const [error, setError] = React.useState<string | null>(null);
  const [contents, setContents] = React.useState("");
  const [savedContents, setSavedContents] = React.useState("");
  const [languageName, setLanguageName] = React.useState("Plain text");
  const [wrap, setWrap] = React.useState(false);
  const [cursor, setCursor] = React.useState({ line: 1, column: 1 });
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);

  const basename = posixBasename(entry.path);
  const parent = posixParent(entry.path);
  const dirty = status === "ready" && contents !== savedContents;

  // The parent renders this component with key={entry.path}, so each file
  // gets a fresh instance — no state reset is needed when the path changes,
  // which keeps this effect free of synchronous setState calls.
  React.useEffect(() => {
    let cancelled = false;
    readServerFile(serverId, entry.path)
      .then((text) => {
        if (cancelled) return;
        if (looksBinary(text)) {
          setStatus("binary");
          return;
        }
        setContents(text);
        setSavedContents(text);
        setStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to read file.");
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, entry.path]);

  // Warn before the tab is closed with unsaved changes. In-app navigation back
  // to the list goes through the discard confirmation instead.
  React.useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const save = React.useCallback(async () => {
    if (!dirty || busy) return;
    setError(null);
    try {
      await onSave(contents);
      setSavedContents(contents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save file.");
    }
  }, [dirty, busy, contents, onSave]);

  const requestBack = () => (dirty ? setConfirmDiscard(true) : onBack());

  const download = async () => {
    try {
      const blob = await downloadServerFiles(serverId, [entry.path], basename);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = basename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Non-critical affordance on the binary state; ignore failures.
    }
  };

  const sizeBytes = React.useMemo(() => new Blob([contents]).size, [contents]);

  return (
    <div className="flex h-[calc(100dvh-13rem)] min-h-[26rem] flex-col overflow-hidden rounded-xl border bg-card ring-1 ring-foreground/5">
      {/* Header: back, path + dirty dot, wrap toggle, save */}
      <div className="flex items-center gap-2 border-b px-2 py-2 sm:px-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={requestBack}
          disabled={busy}
          aria-label="Back to files"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1 truncate text-sm">
          <span className="text-muted-foreground">
            {parent === "/" ? "/" : `${parent}/`}
          </span>
          <span className="font-medium">{basename}</span>
          {dirty && (
            <span
              className="ml-2 inline-block size-1.5 translate-y-px rounded-full bg-primary"
              title="Unsaved changes"
            />
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setWrap((w) => !w)}
          aria-pressed={wrap}
          aria-label="Toggle word wrap"
          className={cn(wrap && "bg-muted text-foreground")}
        >
          <WrapText className="size-4" />
        </Button>
        <Button type="button" size="sm" onClick={() => void save()} disabled={!dirty || busy}>
          {busy ? <Spinner className="size-4" /> : <Save className="size-4" />}
          Save
        </Button>
      </div>

      {/* Body */}
      {status === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Spinner className="size-5" />
          <span className="ml-2 text-sm">Loading…</span>
        </div>
      ) : status === "binary" ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileWarning />
            </EmptyMedia>
            <EmptyTitle>This file cannot be edited in the browser</EmptyTitle>
            <EmptyDescription>
              {basename} does not look like text — saving it here would
              corrupt it. Download it to edit locally, or use SFTP.
            </EmptyDescription>
          </EmptyHeader>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void download()}>
              <Download className="size-4" />
              Download
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onBack}>
              Back to files
            </Button>
          </div>
        </Empty>
      ) : status === "error" ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileWarning />
            </EmptyMedia>
            <EmptyTitle>Could not read this file</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
          <Button type="button" variant="outline" size="sm" onClick={onBack}>
            Back to files
          </Button>
        </Empty>
      ) : (
        <div className="min-h-0 flex-1">
          <CodeEditor
            value={contents}
            filename={basename}
            wrap={wrap}
            onChange={setContents}
            onCursor={(line, column) => setCursor({ line, column })}
            onLanguageInfo={setLanguageName}
            onSave={() => void save()}
          />
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center gap-4 border-t px-3 py-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums">
          Ln {cursor.line}, Col {cursor.column}
        </span>
        <span className="tabular-nums">{formatBytes(sizeBytes)}</span>
        <span>{languageName}</span>
        {contents.length > 1_000_000 && (
          <span className="text-foreground">Large file — editing may be slow</span>
        )}
        <span className="ml-auto hidden sm:inline">
          {dirty ? (
            <span className="text-primary">Unsaved changes</span>
          ) : (
            <span>
              {isApple ? "⌘S" : "Ctrl+S"} to save · modified{" "}
              {formatRelative(entry.modifiedAt)}
            </span>
          )}
        </span>
      </div>

      {/* Discard guard — closing with unsaved changes must never lose work. */}
      <Dialog open={confirmDiscard} onOpenChange={(open) => !open && setConfirmDiscard(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              {basename} has unsaved changes. They will be lost if you go back.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmDiscard(false);
                onBack();
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
