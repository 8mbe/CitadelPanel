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

## Why Monaco

The editor is [Monaco](https://microsoft.github.io/monaco-editor/) — the editor
from VS Code. It replaced CodeMirror 6, which was chosen first for being an
order of magnitude lighter: correct on weight, wrong on the thing people
actually wanted. Editing `server.properties` or a plugin's YAML is the one task
in this panel that everybody already has muscle memory for, and matching VS Code
buys all of it at once — the find/replace widget and its `Ctrl+H`, folding, the
minimap, sticky scroll, bracket pair colours, multi-cursor, the right-click
menu. Reimplementing a convincing subset of that on a lighter base is more work
than the bytes are worth.

The weight is paid for where it costs least:

- Monaco is imported only through `next/dynamic` with `ssr: false`, so it is
  absent from the server bundle and from the main client bundle — it is fetched
  when a file is actually opened.
- The import is Monaco 0.56's tree-shakeable entry points
  (`monaco-editor/editor` plus the `register.all` bundles) rather than the
  everything-included default, so the LSP client and the language *services*
  stay out.
- Grammars stay lazy. Every language registers with a `loader` that
  dynamic-imports its tokenizer, so opening a YAML file fetches the YAML grammar
  and none of the other ninety.
- JSON is the only language *service* loaded, because game configs are full of
  JSON and a trailing comma is worth flagging before the server refuses to boot.
  Schema fetching is off, so it never reaches the network.

A subtlety worth knowing before touching the import lines: monaco 0.56 maps
`"./*"` to `"./esm/vs/*.js"` in its `exports`, so the specifier for
`esm/vs/editor/editor.worker.js` is `monaco-editor/editor/editor.worker.js`.
Writing the `esm/vs` prefix out resolves to `esm/vs/esm/vs/…` and fails to
build.

The React wrapper is hand-rolled (`components/code-editor.tsx`) rather than
`@monaco-editor/react`, which loads Monaco from a CDN by default — not something
a self-hosted panel should depend on, and a needless dependency for a lifecycle
this small. The editor is created once and reconfigured through `updateOptions`
and its model; callbacks are read through a ref so a parent re-render never
rebuilds it; and the controlled `value` is only pushed in when it diverges from
the editor's own text (i.e. a different file was opened — typing round-trips
through `onChange` and never moves the cursor).

Two options are deliberately not VS Code's defaults: the suggestion popup stays
closed until `Ctrl+Space` (a config file has no API to complete against, so
word-based suggestions on every keystroke are noise), and a short editor — the
box in the "New file" modal — drops the minimap and sticky scroll, which need
more height than they get there.

## Workers

Monaco runs language services off the main thread, and the worker entry points
have to be reachable from this origin. `MonacoEnvironment.getWorker` points at
two one-line modules under `components/monaco/` that each import a monaco
worker, instead of pointing straight into `node_modules`.

That indirection is the load-bearing part. A bundler pre-bundles the worker
targets it owns; hand Turbopack a worker file from a dependency and it ships it
as an opaque asset whose bare imports the browser then cannot resolve. A local
module is a target it owns, so monaco's worker graph gets bundled.

If a worker fails to load anyway, Monaco falls back to the main thread: JSON
diagnostics and word suggestions get less responsive, and the editor keeps
working.

## Theming

Every other component in the panel switches theme purely in CSS: the `.dark`
class flips the variables in `app/globals.css` and that is the end of it. Monaco
cannot work that way. `editor.defineTheme` takes literal colours, which it bakes
into a generated stylesheet and into the classes it puts on tokens, so
`var(--card)` never reaches a browser that would resolve it. The editor is
therefore the one place in the codebase that is re-themed from JS — a
`MutationObserver` on the `<html>` class (the signal the three-theme switcher
already produces, see `docs/theming.md`) rebuilds the theme and re-applies it.

What does not change is *where* the colours come from. `code-editor-theme.ts`
reads the same `--card`/`--border`/`--primary`/`--syntax-*` variables everything
else uses — including an operator's site theme, which layers its own values onto
them — so there is still one palette rather than a second one for the editor.
The colour keys it fills in are VS Code's own, which is what makes the find
widget, the suggest list, the hover and the context menu look like the panel's
other popovers instead of like a different application embedded in the page.

The conversion in between is the one trick: the tokens are `oklch()` and an
operator's overrides can be any syntax the browser accepts, so rather than
shipping an oklch→sRGB implementation, `cssColorToHex()` assigns the value to a
canvas `fillStyle` and reads it back — canvas parses the full CSS colour grammar
and always serialises to hex or `rgba()`. Alpha is composed by hand
(`#rrggbbaa`), because Monaco has no `color-mix()`.

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
- The header's path is a breadcrumb, not a label: the editor's whole
  header is a way *out* of the editor, so every ancestor directory is
  clickable and lands on that listing — the same as clicking it in the file
  manager's own breadcrumb. Every one of those exits (and the back arrow)
  goes through one `requestLeave()`, so the discard guard below cannot be
  skipped by adding another affordance later.
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

- `components/code-editor.tsx` — Monaco wrapper: worker wiring, editor
  options, language resolution. Heavy; only ever imported lazily.
- `components/code-editor-theme.ts` — the CSS-variable-to-Monaco theme, and the
  colour conversion it needs.
- `components/monaco/{editor,json}.worker.ts` — the two worker entry points.
- `components/server/file-editor.tsx` — the in-place view: load/binary
  states, dirty tracking, save, status bar (cursor, size, language).
- `components/server/files-manager.tsx` — derives the open directory and
  edited file from the query string, and lazy-loads both modules with
  `next/dynamic` (`ssr: false`), so Monaco stays out of both the server and the
  main client bundle.
