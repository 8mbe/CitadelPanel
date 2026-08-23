# File editor

The in-panel code editor for server files. Clicking a file in the Files
section opens it in a full-width in-place editor (it replaces the file
listing while open) instead of a small textarea dialog.

## Flow

The editor uses the same endpoints the rest of the file manager uses —
nothing about the backend changed:

1. Browser calls `GET /api/servers/:id/files/content?path=…`
   (`readServerFile` in `apps/frontend/lib/api.ts`).
2. The panel route (`lib/server/control-plane/routes/files.ts`) checks the
   `files` subuser permission, then proxies to the node agent
   (`nodeServerApi.ts`).
3. The agent resolves the path through `paths.ts` (the containment
   boundary — `..` and symlink escapes are caught there) and returns the
   file decoded as UTF-8 text.

Saves go back through `PUT` on the same route. Writes are audited by path
only (contents can hold secrets). Size is capped agent-side by
`AGENT_MAX_FILE_BYTES` (8 MiB default) for both reads and writes; an
oversized file surfaces as the agent's 413 message in the editor's error
state.

## Why CodeMirror 6

The editor is [CodeMirror 6](https://codemirror.net/), chosen over Monaco
because it is roughly an order of magnitude lighter, needs no web workers,
and can load grammars lazily: `@codemirror/language-data` maps file
extensions to `LanguageDescription`s whose `load()` is a dynamic import, so
only the language actually being edited (YAML, JSON, shell, Lua, …) is ever
fetched.

The React wrapper is hand-rolled (`components/code-editor.tsx`, ~100
lines) instead of using a wrapper package: the view is created once and
reconfigured through `Compartment`s (language, wrap, read-only), callbacks
are read through a ref so re-renders never rebuild the editor, and the
controlled `value` only dispatches a document replace when it diverges from
the view's doc (i.e. a different file was opened — typing round-trips
through `onChange` and never moves the cursor).

## Theming

The CodeMirror theme is defined entirely with CSS variables from
`app/globals.css` (`--card`, `--border`, `--primary`, …), and syntax
colors come from dedicated `--syntax-*` tokens (defined for both light and
`.dark`). Dark mode therefore switches purely in CSS when the `.dark` class
flips — the editor is never re-themed from JS, and no color literals live
in the component (selection/match highlights are `color-mix()`s of the
`--primary` token).

## Binary files

The agent's read endpoint decodes *everything* as UTF-8 text — a 2 MiB
`.jar` comes back as mojibake, and the old textarea editor would happily
save it back as re-encoded UTF-8, corrupting it. The client is the only
layer that can prevent this, so `file-editor.tsx` runs `looksBinary()` on
the fetched text before showing the editor: any NUL byte in the first 8 KiB,
or >1% U+FFFD replacement characters, opens a non-editable state offering
Download and Back instead. It's a heuristic (a text file with one odd byte
still edits; a binary with no NULs and clean UTF-8 is indistinguishable from
text anyway), but it catches the corruption cases that matter.

## Dirty state and saving

- Dirty is `contents !== lastSavedSnapshot`; the Save button and the
  header dot reflect it.
- Ctrl/Cmd+S saves (a `Prec.highest` keymap inside the editor, so it wins
  over anything else and `preventDefault` stops the browser dialog).
- Going back with unsaved changes shows a discard confirmation; a
  `beforeunload` guard covers closing the tab. The browser's *own* back
  button is not intercepted — by the time `popstate` fires the navigation
  has already happened, and blocking it would mean re-pushing history
  entries underneath the user. Unsaved edits are lost there, the same as
  before the URL held the navigation state.
- A successful save refreshes the directory listing in the background so
  size/mtime are current when the listing comes back.
- The "New file" modal embeds the same editor component, resolving its
  language from the filename as it's typed.

## The URL is the navigation state

Browsing a tree without touching the URL breaks the browser's own back
button: a user three folders deep who presses Back leaves the Files section
entirely and loses their place. So the file manager keeps *where you are* in
the query string rather than in component state:

- `?path=<dir>` — the open directory.
- `?file=<path>` — the file open in the editor. The directory is *implied*
  by the file's parent, so there is exactly one source of truth and the two
  params can never disagree.

Every navigation (folder click, breadcrumb, opening a file, the editor's
Back button) writes one history entry, so back/forward walk the tree — and
a URL can be shared or reloaded straight into a folder or a file.

Two non-obvious pieces:

- **`window.history.pushState`, not `router.push`.** The route's server
  components don't read these params, so a `router.push` would buy an RSC
  round trip per folder click for nothing. Next.js syncs `useSearchParams`
  with the native History API, so `pushState` still re-renders (see
  `docs/performance.md` for why round trips are counted here). Because the
  component calls `useSearchParams`, the page wraps it in `<Suspense>`.
- **The editing entry is resolved from the listing, not stored.** The
  editor needs the row's mtime, so `files-manager.tsx` looks the `?file=`
  path up in the current directory listing. A deep link therefore shows the
  listing spinner until the parent directory lands, a save refreshes the
  mtime for free, and a `?file=` with no matching row (stale link, or the
  file was deleted from another tab) `replaceState`s back to the directory
  instead of opening an editor onto nothing.

Query params are user-editable, so `normalizeDir()` strips `.`/`..`/empty
segments before a path is used — the agent's `paths.ts` is still the real
containment boundary, this just keeps a mangled URL showing a listing
instead of an error banner.

## Code layout

- `components/code-editor.tsx` — CodeMirror wrapper, theme, highlight
  style, language resolution. Heavy; only ever imported lazily.
- `components/server/file-editor.tsx` — the in-place view: load/binary
  states, dirty tracking, save, status bar (cursor, size, language).
- `components/server/files-manager.tsx` — derives the open directory and
  edited file from the query string, and lazy-loads both modules with
  `next/dynamic` (`ssr: false`), so CodeMirror stays out of both the server
  and the main client bundle.
