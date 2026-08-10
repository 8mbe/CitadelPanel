import "server-only";

import { Pool } from "pg";
import postgres from "postgres";

import { env } from "../config/env";

type DatabaseGlobals = typeof globalThis & {
  __citadelSql?: ReturnType<typeof postgres>;
  __citadelAuthPool?: Pool;
};

const globals = globalThis as DatabaseGlobals;

export const sql =
  globals.__citadelSql ??
  postgres(env.databaseUrl, {
    max: 10,
    transform: { undefined: null },
  });

export const authPool =
  globals.__citadelAuthPool ??
  new Pool({ connectionString: env.databaseUrl, max: 10 });

if (process.env.NODE_ENV !== "production") {
  globals.__citadelSql = sql;
  globals.__citadelAuthPool = authPool;
}

export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch (error) {
    console.error("[db] connection check failed:", error);
    return false;
  }
}
