/**
 * Better Auth config used ONLY by the `@better-auth/cli` migrator.
 *
 * Why this file exists, rather than pointing the CLI at `auth/betterAuth.ts`:
 *
 * The Better Auth CLI loads its config through `jiti`, a Node-based loader. The
 * real config imports `db/client.ts`, which does `import { SQL } from "bun"` —
 * a module that only exists inside the Bun runtime. Under jiti that resolution
 * fails with `Cannot find module 'bun'`, so the migrator can never read the real
 * config. (This also breaks the documented `bun run auth:migrate`.)
 *
 * The migrator only needs enough of the config to derive the SCHEMA: the
 * database connection and the shape of the user/session models. Runtime concerns
 * — rate limits, cookie attributes, the first-user-becomes-admin hook — do not
 * affect table structure, so they are deliberately absent here. That is what
 * lets this file depend on `pg` alone and stay loadable under plain Node.
 *
 * KEEP IN SYNC: if a field is added to `user` (or a plugin adds tables) in
 * `auth/betterAuth.ts`, mirror it here or the migration will not create it.
 */

import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { admin } from "better-auth/plugins";
import { Pool } from "pg";

import { loadRepositoryEnv } from "../config/load-repository-env";

loadRepositoryEnv();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Run `bun run cli init` first, or export it for this command.",
  );
}

export const auth = betterAuth({
  // Plain `pg` — no Bun-only imports anywhere in this module's graph.
  database: new Pool({ connectionString }),

  // Present only because the config requires it; migrations do not use it.
  secret: process.env.BETTER_AUTH_SECRET ?? "migration-only-placeholder-secret",
  baseURL: process.env.FRONTEND_URL ?? "http://localhost:3000",

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
  },

  // Mirrors auth/betterAuth.ts — this DOES affect the schema: the plugin owns
  // the `apikey` table, so the CLI migrator must see it here to create it.
  // Runtime-only concerns (enableSessionForAPIKeys, email callbacks, hooks) are
  // deliberately absent — they shape behaviour, not tables.
  plugins: [
    apiKey(),
    // Mirrors auth/betterAuth.ts: the admin plugin owns the `role` field and
    // adds `banned`/`banReason`/`banExpires` on `user` + `impersonatedBy` on
    // `session`, so the CLI migrator must see it here to create those columns.
    admin(),
  ],

  // `role` is no longer declared as an additionalField: the admin plugin owns
  // it (same schema it would have had here). No additionalFields needed.
  user: {},
});
