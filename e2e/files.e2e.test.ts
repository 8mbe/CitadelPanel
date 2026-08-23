/**
 * E2E tests for the server file-manager routes (see routes/files.ts).
 *
 * All of these require the `files` permission, the same grant the file
 * manager UI uses. The panel is a thin proxy onto the node agent here: it
 * authorizes, audits, and forwards; the containment boundary (path
 * traversal, symlink escape, size caps) lives agent-side in
 * `apps/backend/src/paths.ts`.
 *
 * The admin owns the seeded server, so the admin key reaches every happy-path
 * read on it (the agent on :8081 is reachable, so list/read actually return
 * data). The user key has no relationship to that server, so the auth
 * middleware returns 404 (info-leak prevention). Write routes (write/delete/
 * rename/copy/upload/pull) are gated + validated but not exercised against
 * real files. They would mutate the seeded server's data directory.
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus, loadFixtures } from "./_helpers";

describe("GET /api/servers/:id/files (list a directory)", () => {
  e2e("with an admin key returns the directory listing from the agent", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files?path=/`, { key: config.adminKey });
    expectStatus(res, 200);
    // The agent returns its own listing shape. The panel forwards it verbatim.
    expect(res.body).toBeDefined();
  });

  e2e("without a path parameter defaults to '/'", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files`, { key: config.adminKey });
    expectStatus(res, 200);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files?path=/`, { key: config.userKey });
    expect(res.status).toBe(404);
  });

  e2e("without a credential is 401", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files?path=/`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/servers/:id/files/content (read a file)", () => {
  e2e("without a path query is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/content`, { key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/content?path=/server.properties`, { key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/servers/:id/files/content (write a file)", () => {
  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/content`, {
      method: "PUT",
      key: config.userKey,
      body: { path: "/e2e.txt", contents: "x" },
    });
    expect(res.status).toBe(404);
  });

  e2e("with an admin key + missing path is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/content`, {
      method: "PUT",
      key: config.adminKey,
      body: { contents: "x" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing contents is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/content`, {
      method: "PUT",
      key: config.adminKey,
      body: { path: "/e2e.txt" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + non-string path is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/content`, {
      method: "PUT",
      key: config.adminKey,
      body: { path: 123, contents: "x" },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/servers/:id/files/delete", () => {
  e2e("with an admin key + missing paths is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/delete`, { method: "POST", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + empty paths array is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/delete`, {
      method: "POST",
      key: config.adminKey,
      body: { paths: [] },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + non-string entry in paths is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/delete`, {
      method: "POST",
      key: config.adminKey,
      body: { paths: ["/ok", 123] },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/servers/:id/files/directory", () => {
  e2e("with an admin key + missing path is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/directory`, { method: "POST", key: config.adminKey, body: {} });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/servers/:id/files/rename", () => {
  e2e("with an admin key + missing 'from' is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/rename`, { method: "POST", key: config.adminKey, body: { to: "/x" } });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing 'to' is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/rename`, { method: "POST", key: config.adminKey, body: { from: "/x" } });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/servers/:id/files/copy", () => {
  e2e("with an admin key + missing 'from' is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/copy`, { method: "POST", key: config.adminKey, body: { to: "/x" } });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing 'to' is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/copy`, { method: "POST", key: config.adminKey, body: { from: "/x" } });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/servers/:id/files/download", () => {
  e2e("with no path/paths is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/download`, { key: config.adminKey });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/servers/:id/files/upload", () => {
  e2e("with no path query is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/upload`, { method: "POST", key: config.adminKey, body: "x" });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/upload?path=/e2e.txt`, {
      method: "POST",
      key: config.userKey,
      body: "x",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/servers/:id/files/pull (fetch a URL into the data dir)", () => {
  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/pull`, {
      method: "POST",
      key: config.userKey,
      body: { path: "/e2e.txt", url: "https://example.com" },
    });
    expect(res.status).toBe(404);
  });

  e2e("with an admin key + missing path is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/pull`, {
      method: "POST",
      key: config.adminKey,
      body: { url: "https://example.com" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing url is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/pull`, {
      method: "POST",
      key: config.adminKey,
      body: { path: "/e2e.txt" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a non-URL string is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/pull`, {
      method: "POST",
      key: config.adminKey,
      body: { path: "/e2e.txt", url: "not a url" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + a non-http(s) URL is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`/api/servers/${serverId}/files/pull`, {
      method: "POST",
      key: config.adminKey,
      body: { path: "/e2e.txt", url: "ftp://example.com" },
    });
    expect(res.status).toBe(400);
  });
});
