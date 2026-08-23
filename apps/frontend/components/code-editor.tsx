"use client";

import * as React from "react";
import * as monaco from "monaco-editor/editor";
// Editor features (find/replace, folding, bracket matching, sticky scroll, the
// context menu, …) and the Monarch grammars. Both `register.all` entry points
// are lazy where it counts: every grammar is registered with a `loader` that
// dynamic-imports the tokenizer, so opening a YAML file fetches YAML and
// nothing else. JSON is the one language service worth its worker here — game
// configs are full of JSON and a trailing comma is worth flagging.
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/register.all";
import "monaco-editor/languages/features/json/register";

import { cn } from "@/lib/utils";

import { THEME_NAME, buildTheme, observeTheme } from "@/components/code-editor-theme";

// ---------------------------------------------------------------------------
// Workers
//
// Monaco runs its language services off the main thread. The bundler has to be
// told where those entry points are; `new URL(..., import.meta.url)` is the
// form both webpack and Turbopack understand as a worker reference, so the
// workers are served from this origin — never a CDN, which a self-hosted panel
// may not be able to reach anyway.
//
// Both URLs point at one-line modules under `components/monaco/` rather than
// straight into `monaco-editor`: a bundler only bundles worker targets it owns,
// and Turbopack ships a dependency's worker file as an opaque asset whose bare
// imports then fail in the browser. See `components/monaco/editor.worker.ts`.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

if (typeof window !== "undefined" && !window.MonacoEnvironment) {
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === "json") {
        return new Worker(new URL("./monaco/json.worker.ts", import.meta.url), {
          type: "module",
        });
      }
      return new Worker(new URL("./monaco/editor.worker.ts", import.meta.url), {
        type: "module",
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Language resolution
// ---------------------------------------------------------------------------

const PLAIN = { id: "plaintext", label: "Plain text" } as const;

/**
 * Extensions Monaco does not claim but a game server's directory is full of.
 * Everything else is resolved from Monaco's own registry below, so this list
 * stays short on purpose — it is for gaps, not for re-declaring what Monaco
 * already knows.
 */
const EXTENSION_OVERRIDES: Record<string, string> = {
  ".toml": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".env": "ini",
  ".jsonc": "json",
  ".json5": "json",
  ".mcmeta": "json",
  ".log": "plaintext",
  ".txt": "plaintext",
};

/** Resolve a file name to a Monaco language id and its display name. */
function resolveLanguage(filename?: string): { id: string; label: string } {
  if (!filename) return PLAIN;
  const name = filename.toLowerCase();

  const languages = monaco.languages.getLanguages();
  const label = (id: string) => {
    const found = languages.find((lang) => lang.id === id);
    return { id, label: found?.aliases?.[0] ?? id };
  };

  for (const [extension, id] of Object.entries(EXTENSION_OVERRIDES)) {
    if (name.endsWith(extension)) return label(id);
  }

  // An exact file name wins over an extension: `Dockerfile` and `.gitconfig`
  // have no extension to match on.
  for (const lang of languages) {
    if (lang.filenames?.some((candidate) => candidate.toLowerCase() === name)) {
      return { id: lang.id, label: lang.aliases?.[0] ?? lang.id };
    }
  }

  // Longest extension wins, so `.d.ts` beats `.ts`.
  let best: { id: string; label: string; length: number } | null = null;
  for (const lang of languages) {
    for (const extension of lang.extensions ?? []) {
      const lower = extension.toLowerCase();
      if (!name.endsWith(lower)) continue;
      if (best && best.length >= lower.length) continue;
      best = { id: lang.id, label: lang.aliases?.[0] ?? lang.id, length: lower.length };
    }
  }
  return best ? { id: best.id, label: best.label } : PLAIN;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CodeEditorProps {
  /** Document text. External changes replace the whole doc (cursor resets). */
  value: string;
  /** File name used to pick the syntax language. Omit for plain text. */
  filename?: string;
  /** Enable soft wrapping of long lines. */
  wrap?: boolean;
  /** Make the document non-editable. */
  readOnly?: boolean;
  /** Called on every document change with the full text. */
  onChange?: (value: string) => void;
  /** Called with the primary cursor position (1-based line/column). */
  onCursor?: (line: number, column: number) => void;
  /** Called with the resolved language's display name (e.g. "YAML"). */
  onLanguageInfo?: (name: string) => void;
  /** Called when the user presses Ctrl/Cmd+S. */
  onSave?: () => void;
  className?: string;
}

/**
 * Monaco (the editor from VS Code) wrapped for React.
 *
 * Hand-rolled rather than pulled from a wrapper package for two reasons: the
 * popular wrapper fetches Monaco from a CDN by default, which a self-hosted
 * panel has no business depending on, and the lifecycle here is small — the
 * editor is created once, then reconfigured through `updateOptions` and its
 * model. Callbacks are read through a ref so a parent re-render never rebuilds
 * the editor.
 *
 * This module is heavy — import it lazily (next/dynamic, `ssr: false`); Monaco
 * touches `document` at import time.
 */
function CodeEditor({
  value,
  filename,
  wrap = false,
  readOnly = false,
  onChange,
  onCursor,
  onLanguageInfo,
  onSave,
  className,
}: CodeEditorProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // The doc the editor was created with, so the mount effect can read the
  // initial value without listing it as a dependency.
  const initialValueRef = React.useRef(value);

  // Latest callbacks without recreating the editor on identity changes.
  // Assigned in an effect (not during render) so the React compiler-era ref
  // rules are satisfied; editor events only fire after effects run.
  const callbacksRef = React.useRef({ onChange, onCursor, onSave, onLanguageInfo });
  React.useEffect(() => {
    callbacksRef.current = { onChange, onCursor, onSave, onLanguageInfo };
  });

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Monaco needs literal colors, so the theme is rebuilt from the CSS
    // variables now and again whenever the panel's theme class changes.
    const applyTheme = () => {
      monaco.editor.defineTheme(THEME_NAME, buildTheme());
      monaco.editor.setTheme(THEME_NAME);
    };
    applyTheme();
    const stopObservingTheme = observeTheme(applyTheme);

    // A short editor (the "New file" modal's box) has no room for the chrome a
    // full-height one wants; measured once at create time because the places
    // that embed this component have fixed heights.
    const compact = host.clientHeight > 0 && host.clientHeight < 320;

    const editor = monaco.editor.create(host, {
      value: initialValueRef.current,
      language: PLAIN.id,
      theme: THEME_NAME,
      automaticLayout: true,
      // The panel's mono font, resolved by the browser: Monaco applies
      // `fontFamily` as CSS and measures characters from the DOM, so the
      // variable works here and the editor never hardcodes a font.
      fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: !compact, renderCharacters: false, maxColumn: 80 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      renderLineHighlight: "all",
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: "active" },
      stickyScroll: { enabled: !compact, maxLineCount: 3 },
      lineNumbersMinChars: compact ? 3 : 4,
      padding: { top: 10, bottom: 10 },
      tabSize: 2,
      insertSpaces: true,
      detectIndentation: true,
      trimAutoWhitespace: false,
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false,
      },
      overviewRulerBorder: false,
      // The editor sits inside a rounded, clipped container; without this the
      // find widget and the context menu would be cut off by it.
      fixedOverflowWidgets: true,
      // Config files are not code with an API to complete against, so the
      // suggestion popup stays off until it is asked for (Ctrl+Space).
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      // Config values are often deliberately odd characters; don't nag.
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      wordWrap: wrap ? "on" : "off",
      readOnly,
      domReadOnly: readOnly,
    });
    editorRef.current = editor;

    // Ctrl/Cmd+S saves. Monaco's keybinding service consumes the event, so the
    // browser's own save dialog never opens.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      callbacksRef.current.onSave?.();
    });

    const subscriptions = [
      editor.onDidChangeModelContent(() => {
        callbacksRef.current.onChange?.(editor.getValue());
      }),
      editor.onDidChangeCursorPosition((event) => {
        callbacksRef.current.onCursor?.(event.position.lineNumber, event.position.column);
      }),
    ];

    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      stopObservingTheme();
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // Created once: `wrap`/`readOnly` are the initial values and are kept in
    // sync by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Language follows the file name.
  React.useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const language = resolveLanguage(filename);
    monaco.editor.setModelLanguage(model, language.id);
    callbacksRef.current.onLanguageInfo?.(language.label);
  }, [filename]);

  // Controlled value. Only a genuinely different document is pushed in —
  // typing round-trips through `onChange`, and replacing the text on every
  // keystroke would reset the cursor and the undo stack.
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (value !== editor.getValue()) editor.setValue(value);
  }, [value]);

  React.useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wrap ? "on" : "off" });
  }, [wrap]);

  React.useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, domReadOnly: readOnly });
  }, [readOnly]);

  return (
    <div
      ref={hostRef}
      data-slot="code-editor"
      className={cn("h-full w-full overflow-hidden text-sm", className)}
    />
  );
}

export default CodeEditor;
