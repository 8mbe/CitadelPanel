# Database explorer

An in-panel browser/editor for a server's provisioned database: list tables,
page through rows, and create/edit/delete tables, columns and rows, all
without the owner leaving the panel or knowing a SQL client.

It builds on the per-server database feature (see the Databases tab): each
server can provision databases on its node's shared MariaDB, each with a
scoped user that has `GRANT ALL` on exactly that one database. The explorer
is the read/write UI for what lives *inside* those databases. Where that
MariaDB comes from, and how it is started and stopped, is
`docs/node-database.md`.

## Flow

```
browser ──> panel routes (routes/dbExplorer.ts, `database` permission)
                │  structured op: "create table", "update row", …
                ▼
          services/dbExplorer.ts loads the server_databases row,
          decrypts the scoped user's password, composes SQL
                │  SQL composed ONLY from services/dbExplorerSql.ts
                ▼
          agent POST /v1/servers/:id/database/query docker-execs the
          mariadb client as the scoped user, DB preselected, --xml output
                │  parsed DbQueryResult[] (columns + string|null rows)
                ▼
          back to the browser as JSON
```

The browser never sends SQL. Every operation arrives as structured JSON (a
table name, column specs, a pk→value map) and the **panel** compiles it to
statements. The agent is a dumb executor for this traffic. It validates the
credential shape and the SQL size, runs it, and returns parsed results.

## Security model

Three layers, each sufficient on its own; together they make "a bug in the
explorer" mean "wrong data in one database" rather than anything wider:

1. **Composed SQL only** (`services/dbExplorerSql.ts`, pure and unit-tested).
   Identifiers must match a backtick-safe shape (`[A-Za-z_][A-Za-z0-9_$]{0,63}`)
   before interpolation. Anything else is a 400. Data values are encoded as
   `CAST(x'…' AS CHAR)` hex literals, which contain no characters MySQL
   parses, so quoting/sql_mode cannot be subverted. Column types come from a
   fixed allowlist; the UI's dropdown mirrors it, the server enforces it. The
   one place a quoted literal is unavoidable (DDL `DEFAULT`/`COMMENT`)
   doubles `'` and `\`.
2. **Scoped-user execution.** Explorer SQL runs as the per-database user
   (`u_<serverId><suffix>`), never the node's DB admin. That user's grants
   cover exactly one database, so MariaDB itself contains the blast radius.
   `information_schema` filters via `DATABASE()` naturally scope to it because
   the agent preselects the DB on the `mariadb` command line.
3. **Ownership + permission checks** (`routes/dbExplorer.ts`). Every route,
   reads included, requires the `database` subuser permission, and the
   `server_databases` row is loaded by `(id, server_id)`, so one server's
   owner cannot reach another server's database by guessing ids. Mutations are
   refused on suspended servers, matching provisioning.

Every mutation writes an audit row (`server.database.explorer.*`): who, which
database, which table/columns, and the primary-key snapshot for row edits.
That snapshot holds column *names* and key values, never full row data.

## Why `--xml` and not batch mode

The agent's `mariadb … --xml` output is parsed by a regex extractor
(`parseMysqlXmlOutput` in `apps/backend/src/docker/database.ts`). The default
`--batch` mode escapes tabs/newlines but renders SQL `NULL` and the literal
string `"NULL"` identically, so a row edit keyed on a mis-read value would
target the wrong row. The XML format carries `xsi:nil="true"` for real NULLs
and entity-escapes values, removing both ambiguities. Values stay strings
end-to-end so BIGINT ids never round-trip through JavaScript numbers.

## UI structure

- `components/server/database-tab.tsx`: the Databases tab; each database row
  gets an **Explore** button that swaps the tab into the explorer.
- `components/server/db-explorer/db-explorer.tsx`: the shell, with a table
  sidebar (name, ≈ row estimate, size), table picker, and create-table dialog
  trigger.
- `components/server/db-explorer/explorer-table.tsx`: the selected table's
  **Data** view (paginated rows ordered by primary key, row insert/edit/delete)
  and **Structure** view (column list, add/edit/drop column, drop table).
- `components/server/db-explorer/explorer-dialogs.tsx`: the dialogs and the
  shared form vocabulary (type dropdown = the server's allowlist).

Notable UI decisions:

- **Row identity is the primary key.** Tables without a PK can be browsed but
  their rows can't be edited or deleted. There is no stable row identity to
  key an `UPDATE … LIMIT 1` on, and pretending otherwise would corrupt data.
  The data view says so instead of offering broken buttons.
- **Edits submit only changed fields.** A row edit sends just the fields whose
  value or null-ness changed, so values that don't round-trip as text (binary
  blobs, say) are never clobbered by a round-trip.
- **NULL is explicit.** Every row-dialog field pairs its input with a NULL
  checkbox, because empty string and NULL are different values and both are
  common in game-server schemas.
- **Column edits restate the whole definition** (`ALTER TABLE … CHANGE
  COLUMN`), prefilled from the schema. An underfilled edit would silently
  drop type/nullability/default. Types the dropdown can't represent (enum,
  set) disable editing rather than rewrite the column.
- **CREATE TABLE defaults to InnoDB + utf8mb4**, matching what game servers
  create themselves, so explorer-created tables behave like the game's own.
