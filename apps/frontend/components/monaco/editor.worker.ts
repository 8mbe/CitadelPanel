/**
 * Monaco's core web worker (the editor worker service: diffs, links,
 * word-based suggestions), re-exported as a worker entry point of *this* app.
 *
 * The indirection is what makes the worker build. A bundler only pre-bundles
 * `new Worker(new URL(…))` targets it owns; point one at a file inside
 * `node_modules` and Turbopack treats it as an opaque asset, shipping a module
 * whose bare imports the browser cannot resolve. A one-line local module is a
 * target the bundler owns, so monaco's worker graph gets bundled properly.
 */
import "monaco-editor/editor/editor.worker.js";
