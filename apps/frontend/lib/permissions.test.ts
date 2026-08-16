/**
 * Unit tests for the client-side section permission map.
 *
 * The map mirrors the backend's per-route checks; these tests pin the
 * behaviour the UI relies on: a console-only subuser sees just the console
 * baseline sections, and owners/admins see everything.
 */

import { test, expect } from "bun:test";
import {
  SERVER_SECTION_KEYS,
  SECTION_PERMISSIONS,
  sectionAllowed,
  viewerAllows,
} from "./permissions";
import type { ServerViewerAccess } from "./types";

const owner: ServerViewerAccess = { kind: "owner", permissions: {} };
const admin: ServerViewerAccess = { kind: "admin", permissions: {} };
const consoleOnly: ServerViewerAccess = {
  kind: "subuser",
  permissions: { console: true },
};
const fullSubuser: ServerViewerAccess = {
  kind: "subuser",
  permissions: {
    console: true,
    files: true,
    start_stop: true,
    settings: true,
    database: true,
  },
};

test("every section key has an entry in the permission map", () => {
  expect(Object.keys(SECTION_PERMISSIONS).sort()).toEqual(
    [...SERVER_SECTION_KEYS].sort(),
  );
});

test("a console-only subuser can open only console and activity", () => {
  const allowed = SERVER_SECTION_KEYS.filter((key) =>
    sectionAllowed(key, consoleOnly),
  );
  expect(allowed).toEqual(["console", "activity"]);
});

test("a subuser with every grant opens every section except subusers", () => {
  const allowed = SERVER_SECTION_KEYS.filter((key) =>
    sectionAllowed(key, fullSubuser),
  );
  expect(allowed).toEqual([
    "console",
    "files",
    "plugins",
    "database",
    "ports",
    "settings",
    "activity",
  ]);
});

test("plugins ride the files grant — installing a plugin is a file write", () => {
  expect(sectionAllowed("plugins", consoleOnly)).toBe(false);
  expect(
    sectionAllowed("plugins", {
      kind: "subuser",
      permissions: { console: true, files: true },
    }),
  ).toBe(true);
  expect(sectionAllowed("plugins", owner)).toBe(true);
});

test("managing subusers is never delegable", () => {
  expect(sectionAllowed("subusers", fullSubuser)).toBe(false);
  expect(sectionAllowed("subusers", owner)).toBe(true);
  expect(sectionAllowed("subusers", admin)).toBe(true);
});

test("owners and admins hold every permission implicitly", () => {
  expect(viewerAllows(owner, "database")).toBe(true);
  expect(viewerAllows(admin, "settings")).toBe(true);
  expect(sectionAllowed("settings", owner)).toBe(true);
  expect(sectionAllowed("ports", admin)).toBe(true);
});

test("a subuser needs the exact flag, explicitly true", () => {
  expect(viewerAllows(consoleOnly, "console")).toBe(true);
  expect(viewerAllows(consoleOnly, "files")).toBe(false);
  expect(
    viewerAllows(
      { kind: "subuser", permissions: { files: false } },
      "files",
    ),
  ).toBe(false);
});

test("a missing viewer fails open — the API's 403 remains the limit", () => {
  expect(sectionAllowed("files", undefined)).toBe(true);
  expect(sectionAllowed("subusers", undefined)).toBe(true);
});
