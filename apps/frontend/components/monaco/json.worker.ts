/**
 * Monaco's JSON language worker (validation, formatting, completions), as a
 * worker entry point of this app — see the note in `editor.worker.ts` for why
 * the indirection is needed.
 *
 * JSON is the one language service the panel loads: game configs are full of
 * JSON and a trailing comma is worth flagging before the server refuses to
 * boot. Schema fetching is off by default, so this never reaches the network.
 */
import "monaco-editor/language/json/json.worker.js";
