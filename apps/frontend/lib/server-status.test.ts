/**
 * Unit tests for the provisioning-status predicate.
 *
 * The predicate decides whether the server shell locks the owner out, so the
 * interesting assertion is the negative one: every status that is *not* part of
 * building a server must stay accessible. A new status added to `ServerStatus`
 * without a decision here would otherwise inherit whichever answer the
 * expression happens to give it.
 */

import { test, expect } from "bun:test";
import { isProvisioning } from "./server-status";
import type { ServerStatus } from "./types";

const PROVISIONING: ServerStatus[] = ["creating", "installing"];
const OPERABLE: ServerStatus[] = [
  "stopped",
  "starting",
  "running",
  "stopping",
  "suspended",
  "error",
  "deleting",
];

test("the two build statuses are provisioning", () => {
  for (const status of PROVISIONING) {
    expect(isProvisioning(status)).toBe(true);
  }
});

test("every other status is not", () => {
  for (const status of OPERABLE) {
    expect(isProvisioning(status)).toBe(false);
  }
});

test("a failed provision is not provisioning, it needs an admin, not a wait", () => {
  // The distinction the shell depends on: `error` leaves the owner with a
  // reachable (if broken) server rather than an installing screen forever.
  expect(isProvisioning("error")).toBe(false);
});
