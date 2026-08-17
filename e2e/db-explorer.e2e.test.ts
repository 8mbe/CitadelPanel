/**
 * E2E tests for the database explorer surface
 * (see routes/dbExplorer.ts + docs/database-explorer.md).
 *
 * Every route — reads included — requires the `database` permission, matching
 * the rest of the databases resource. The handlers stay thin: parse,
 * authorize, delegate to `services/dbExplorer.ts`, which composes the SQL
 * (never the browser) and audits every mutation.
 *
 * The suite exercises the auth gate (404 for the user key — info-leak
 * prevention), the UUID-param gate (400 for non-UUID serverId/databaseId),
 * and the body-validation gate (400 for missing/malformed fields). Happy-
 * path reads are not exercised: they need a real provisioned database with
 * the DBMS running, which the dev panel's seeded server may not have. The
 * gate tests are sufficient because the SQL builders are covered by unit
 * tests and the panel is a thin proxy here.
 *
 * Table and column names arrive as path/body values and are vetted inside
 * the SQL builders before interpolation — a hostile name yields a 400, not
 * a statement. Mutations are refused on suspended servers (409).
 */

import { describe, expect, test } from "bun:test";

import { api, config, e2e, expectStatus, loadFixtures, UNKNOWN_UUID } from "./_helpers";

// Path prefix shared by every explorer route.
const prefix = (serverId: string, dbId: string) =>
  `/api/servers/${serverId}/databases/${dbId}/explorer`;

describe("GET /api/servers/:id/databases/:dbId/explorer/tables (table list)", () => {
  e2e("with a non-UUID serverId is 400", async () => {
    const res = await api(`${prefix("not-a-uuid", UNKNOWN_UUID)}/tables`, { key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with a non-UUID databaseId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, "not-a-uuid")}/tables`, { key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables`, { key: config.userKey });
    expect(res.status).toBe(404);
  });

  e2e("without a credential is 401", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables`);
    expect(res.status).toBe(401);
  });
});

describe("POST .../explorer/tables (create a table)", () => {
  e2e("with a non-UUID databaseId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, "not-a-uuid")}/tables`, {
      method: "POST",
      key: config.adminKey,
      body: { table: "t", columns: [{ name: "id", type: "int" }] },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing table is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables`, {
      method: "POST",
      key: config.adminKey,
      body: { columns: [{ name: "id", type: "int" }] },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing columns is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables`, {
      method: "POST",
      key: config.adminKey,
      body: { table: "t" },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + an empty columns array is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables`, {
      method: "POST",
      key: config.adminKey,
      body: { table: "t", columns: [] },
    });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables`, {
      method: "POST",
      key: config.userKey,
      body: { table: "t", columns: [{ name: "id", type: "int" }] },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET .../explorer/tables/:table/schema (columns + primary key)", () => {
  e2e("with a non-UUID serverId is 400", async () => {
    const res = await api(`${prefix("not-a-uuid", UNKNOWN_UUID)}/tables/foo/schema`, { key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/schema`, { key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("GET .../explorer/tables/:table/rows (one page of rows)", () => {
  e2e("with a non-UUID databaseId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, "not-a-uuid")}/tables/foo/rows`, { key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/rows`, { key: config.userKey });
    expect(res.status).toBe(404);
  });

  e2e("with a user key + a non-numeric limit is still gated by auth (404)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/rows?limit=abc`, { key: config.userKey });
    expect(res.status).toBe(404);
  });
});

describe("POST .../explorer/tables/:table/rows (insert a row)", () => {
  e2e("with an admin key + missing values is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/rows`, {
      method: "POST",
      key: config.adminKey,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/rows`, {
      method: "POST",
      key: config.userKey,
      body: { values: { id: "1" } },
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH .../explorer/tables/:table/rows (update a row by primary key)", () => {
  e2e("with an admin key + missing pk is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/rows`, {
      method: "PATCH",
      key: config.adminKey,
      body: { values: { id: "1" } },
    });
    expect(res.status).toBe(400);
  });

  e2e("with an admin key + missing values is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/rows`, {
      method: "PATCH",
      key: config.adminKey,
      body: { pk: { id: "1" } },
    });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/rows`, {
      method: "PATCH",
      key: config.userKey,
      body: { pk: { id: "1" }, values: { id: "2" } },
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE .../explorer/tables/:table/rows (delete a row by primary key)", () => {
  e2e("with an admin key + missing pk is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/rows`, {
      method: "DELETE",
      key: config.adminKey,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/rows`, {
      method: "DELETE",
      key: config.userKey,
      body: { pk: { id: "1" } },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST .../explorer/tables/:table/columns (add a column)", () => {
  e2e("with an admin key + missing column spec is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/columns`, {
      method: "POST",
      key: config.adminKey,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/columns`, {
      method: "POST",
      key: config.userKey,
      body: { column: { name: "x", type: "int" } },
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH .../explorer/tables/:table/columns/:column (edit a column)", () => {
  e2e("with an admin key + missing column spec is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/columns/bar`, {
      method: "PATCH",
      key: config.adminKey,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/columns/bar`, {
      method: "PATCH",
      key: config.userKey,
      body: { column: { name: "x", type: "int" } },
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE .../explorer/tables/:table/columns/:column (drop a column)", () => {
  e2e("with a non-UUID serverId is 400", async () => {
    const res = await api(`${prefix("not-a-uuid", UNKNOWN_UUID)}/tables/foo/columns/bar`, {
      method: "DELETE",
      key: config.adminKey,
    });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo/columns/bar`, {
      method: "DELETE",
      key: config.userKey,
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE .../explorer/tables/:table (drop a table, destructive)", () => {
  e2e("with a non-UUID serverId is 400", async () => {
    const res = await api(`${prefix("not-a-uuid", UNKNOWN_UUID)}/tables/foo`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with a non-UUID databaseId is 400", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, "not-a-uuid")}/tables/foo`, { method: "DELETE", key: config.adminKey });
    expect(res.status).toBe(400);
  });

  e2e("with a user key is 404 (no access)", async () => {
    const { serverId } = await loadFixtures();
    const res = await api(`${prefix(serverId, UNKNOWN_UUID)}/tables/foo`, { method: "DELETE", key: config.userKey });
    expect(res.status).toBe(404);
  });
});
