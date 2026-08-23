/**
 * Tests for the error-shape contract the panel and the browser read.
 *
 * The message is for a human; `code` is what callers branch on. The panel
 * rebuilds a container it is told is missing, and the console says a rebuild is
 * coming rather than echoing Docker. Both break silently if the tag stops
 * riding along with the response, which is what these assertions pin down.
 */

import { describe, expect, test } from "bun:test";

import { HttpError, badRequest, notFound, toErrorResponse } from "./http";

describe("toErrorResponse", () => {
  test("carries an error's code alongside its message", async () => {
    const response = toErrorResponse(
      notFound("No container exists on this node for server abc.", "no_container"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "No container exists on this node for server abc.",
      code: "no_container",
    });
  });

  test("omits the code key entirely when the error has none", async () => {
    const response = toErrorResponse(badRequest("serverId must be a UUID."));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "serverId must be a UUID." });
  });

  test("does not leak a non-HttpError's message", async () => {
    const response = toErrorResponse(new Error("connect ECONNREFUSED /var/run/docker.sock"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal agent error" });
  });

  test("an untagged 404 stays untagged", async () => {
    const response = toErrorResponse(new HttpError(404, "Not found"));

    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
