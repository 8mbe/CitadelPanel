"use client";

import * as React from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";

import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Theme
//
// Every color is a CSS variable from app/globals.css, so light/dark switching
// happens in CSS (the `.dark` class flips the vars) and the editor never needs
// to be re-themed from JS. Selections and match highlights mix the primary
// token with transparency instead of introducing new color literals.
// ---------------------------------------------------------------------------

const editorTheme = EditorView.theme({
  "&": {
    color: "var(--card-foreground)",
    backgroundColor: "var(--card)",
    height: "100%",
    fontSize: "0.8125rem",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-geist-mono)",
    lineHeight: "1.6",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2px solid var(--foreground)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--muted) 65%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in oklch, var(--primary) 18%, transparent)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklch, var(--primary) 25%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklch, var(--primary) 40%, transparent)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--primary) 20%, transparent)",
    outline: "1px solid color-mix(in oklch, var(--primary) 45%, transparent)",
  },
  ".cm-nonmatchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--destructive) 20%, transparent)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    border: "none",
    color: "var(--muted-foreground)",
  },
  ".cm-panels": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    borderTop: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
  },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-textfield": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "calc(var(--radius) * 0.6)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "calc(var(--radius) * 0.8)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
});

const editorHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--syntax-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syntax-string)" },
  { tag: [t.number, t.integer, t.float, t.bool, t.atom, t.self], color: "var(--syntax-constant)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syntax-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syntax-type)" },
  { tag: t.tagName, color: "var(--syntax-tag)" },
  { tag: [t.attributeName, t.attributeValue], color: "var(--syntax-attribute)" },
  { tag: [t.link, t.url], color: "var(--syntax-string)", textDecoration: "underline" },
  { tag: t.heading, color: "var(--syntax-keyword)", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.invalid, color: "var(--destructive)" },
]);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CodeEditorProps {
  /** Document text. External changes replace the whole doc (cursor resets). */
  value: string;
  /**
   * File name used to pick the syntax language (extension match against
   * @codemirror/language-data). Omit for plain text.
   */
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
 * Thin React wrapper around CodeMirror 6.
 *
 * Intentionally hand-rolled instead of a wrapper package: the view is created
 * once and reconfigured through compartments (language, wrap, read-only), and
 * callbacks are read through a ref so re-renders never rebuild the editor.
 * This module is heavy — import it lazily (next/dynamic, ssr: false).
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
  const viewRef = React.useRef<EditorView | null>(null);
  // The doc the view was created with, so the mount effect can read the
  // initial value without listing it as a dependency.
  const initialValueRef = React.useRef(value);

  // Latest callbacks without reconfiguring the view on identity changes.
  // Assigned in an effect (not during render) so the React compiler-era
  // ref rules are satisfied; editor events only fire after effects run.
  const callbacksRef = React.useRef({ onChange, onCursor, onSave, onLanguageInfo });
  React.useEffect(() => {
    callbacksRef.current = { onChange, onCursor, onSave, onLanguageInfo };
  });

  const compartments = React.useMemo(
    () => ({
      language: new Compartment(),
      wrap: new Compartment(),
      readOnly: new Compartment(),
    }),
    [],
  );

  React.useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          basicSetup,
          editorTheme,
          syntaxHighlighting(editorHighlightStyle),
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  callbacksRef.current.onSave?.();
                  return true;
                },
              },
            ]),
          ),
          EditorView.updateListener.of((update) => {
            const { onChange: change, onCursor: cursor } = callbacksRef.current;
            if (update.docChanged) change?.(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              cursor?.(line.number, head - line.from + 1);
            }
          }),
          compartments.language.of([]),
          compartments.wrap.of([]),
          compartments.readOnly.of([]),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [compartments]);

  // Replace the document when the controlled value diverges (i.e. a new file
  // was opened). Keystrokes round-trip through onChange and match, so typing
  // never dispatches a replace and never moves the cursor.
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: EditorSelection.cursor(0),
      });
    }
  }, [value]);

  React.useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap, compartments]);

  React.useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.readOnly.reconfigure(
        readOnly
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [],
      ),
    });
  }, [readOnly, compartments]);

  // Resolve the language for `filename` and swap it into its compartment.
  // language-data lazy-loads each grammar, so only the used language is fetched.
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || !filename) return;
    const description = LanguageDescription.matchFilename(languages, filename);
    callbacksRef.current.onLanguageInfo?.(description?.name ?? "Plain text");
    if (!description) {
      view.dispatch({ effects: compartments.language.reconfigure([]) });
      return;
    }
    let cancelled = false;
    void description
      .load()
      .then((support) => {
        if (cancelled || viewRef.current !== view) return;
        view.dispatch({ effects: compartments.language.reconfigure(support) });
      })
      .catch(() => {
        // Unknown/failed grammar: fall back to plain text rather than breaking.
        if (!cancelled && viewRef.current === view) {
          view.dispatch({ effects: compartments.language.reconfigure([]) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filename, compartments]);

  return (
    <div
      ref={hostRef}
      data-slot="code-editor"
      className={cn("h-full overflow-hidden", className)}
    />
  );
}

export default CodeEditor;
