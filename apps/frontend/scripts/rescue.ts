/**
 * Rescue CLI — out-of-band recovery when the panel's own auth surface is locked.
 *
 * Two operations, both runnable without the web server or a signed-in session:
 *
 *   reset-password    Set a user's password directly in the credential account
 *                     Better Auth owns, and revoke every session they hold. Use
 *                     this when an admin is locked out and the forgot-password
 *                     flow is unreachable (no mail configured) or compromised.
 *
 *   disable-captcha   Flip the captcha setting off while keeping its provider
 *                     keys, so a misconfigured widget can no longer lock every
 *                     sign-in attempt out of the panel.
 *
 * Why this is a standalone script rather than a route: the whole point is to
 * work when the normal request path does not. It talks to Postgres directly and
 * hashes with the *same* `better-auth/crypto` hashPassword the credential
 * provider uses, so a password set here verifies normally at sign-in.
 *
 * It deliberately does NOT import the `server-only`-guarded modules
 * (`config/env`, `db/client`, `services/settings`): `server-only` is a Next.js
 * build shim that plain Bun cannot resolve, so — like `scripts/migrate.ts` — it
 * loads the repository `.env` itself and opens its own single-connection client.
 *
 * Usage:
 *   bun run scripts/rescue.ts reset-password --email admin@example.com
 *   bun run scripts/rescue.ts reset-password --user-id <id> [--password <pw>]
 *   bun run scripts/rescue.ts disable-captcha
 *   bun run scripts/rescue.ts --help
 */

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import postgres from "postgres";

import { loadRepositoryEnv } from "../lib/server/control-plane/config/load-repository-env";
// `better-auth/crypto` exports the same hashPassword the credential provider
// uses (scrypt under Node/Bun). Importing it directly avoids the `server-only`
// guard on the auth config module — and it has no dependency on a running
// Better Auth instance, which a server-only endpoint would.
import { hashPassword } from "better-auth/crypto";

loadRepositoryEnv();

// --- CLI surface --------------------------------------------------------------

interface ParsedArgs {
  command: string | null;
  email: string | null;
  userId: string | null;
  password: string | null;
  yes: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: null,
    email: null,
    userId: null,
    password: null,
    yes: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--yes":
      case "-y":
        parsed.yes = true;
        break;
      case "--email":
        parsed.email = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--user-id":
        parsed.userId = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--password":
        parsed.password = argv[index + 1] ?? null;
        index += 1;
        break;
      default:
        if (!arg.startsWith("--") && parsed.command === null) {
          parsed.command = arg;
        }
        break;
    }
  }

  return parsed;
}

const HELP = `CitadelPanel rescue CLI

Usage (run from the repository root):
  bun run rescue <command> [options]

  Or directly from apps/frontend:
  bun run scripts/rescue.ts <command> [options]

Commands:
  reset-password    Reset a user's password and revoke their sessions.
  disable-captcha   Turn captcha off (keeps provider keys for re-enabling).

Options:
  --email <email>      User to reset (reset-password). Email is matched
                       case-insensitively, exactly as Better Auth stores it.
  --user-id <id>       Alternative to --email: resolve the user by id.
  --password <pw>      New password (reset-password). If omitted, a strong one
                       is generated and printed once. Minimum 12 characters.
  --yes, -y            Skip the interactive confirmation prompt.
  --help, -h           Show this help.

Examples (from the repository root):
  bun run rescue reset-password --email admin@example.com
  bun run rescue disable-captcha --yes
`;

// Matches the auth config in lib/server/control-plane/auth/betterAuth.ts: a
// shorter password would be rejected at sign-in by Better Auth's own length
// check, so enforce the same floor here to avoid silently setting an unusable
// credential.
const MIN_PASSWORD_LENGTH = 12;

function generatePassword(): string {
  // 18 bytes → ~24 base64url chars: well above the minimum, typeable, no
  // ambiguous punctuation. Printed once so the operator can log in and then
  // change it from the account settings page.
  return randomBytes(18).toString("base64url");
}

async function confirm(prompt: string, nonInteractive: boolean): Promise<boolean> {
  if (nonInteractive) return true;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${prompt} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// --- reset-password -----------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
}

async function resolveUser(
  sql: postgres.Sql,
  email: string | null,
  userId: string | null,
): Promise<UserRow> {
  if (!email && !userId) {
    throw new Error("Specify a user with --email <email> or --user-id <id>.");
  }

  let rows: UserRow[];
  if (email) {
    // Better Auth lowercases emails on insert; match the same way so a typed
    // mixed-case lookup still hits.
    rows = (await sql`
      SELECT id, email, name, role FROM "user" WHERE email = ${email.toLowerCase()}
    `) as UserRow[];
  } else {
    rows = (await sql`
      SELECT id, email, name, role FROM "user" WHERE id = ${userId}
    `) as UserRow[];
  }

  const user = rows[0];
  if (!user) {
    const identifier = email ? `email ${email}` : `id ${userId}`;
    throw new Error(`No user found with ${identifier}.`);
  }
  return user;
}

async function resetPassword(
  sql: postgres.Sql,
  args: ParsedArgs,
): Promise<void> {
  const user = await resolveUser(sql, args.email, args.userId);

  const password =
    args.password && args.password.length > 0 ? args.password : generatePassword();

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters (the panel's sign-in floor).`,
    );
  }

  console.log(
    `\n[rescue] target user: ${user.email}${user.name ? ` (${user.name})` : ""}` +
      (user.role ? ` [${user.role}]` : "") +
      `\n[rescue] this will set a new password and revoke ALL of their sessions.`,
  );

  if (!(await confirm("Proceed?", args.yes))) {
    console.log("[rescue] aborted.");
    return;
  }

  // Find the credential account Better Auth created at sign-up. An OAuth-only
  // user has none, and this tool will not fabricate one — adding a password to
  // an account that never had one is a different operation than "reset", and
  // doing it by raw INSERT risks missing a required field the adapter would
  // populate. Surface it instead.
  const accountRows = (await sql`
    SELECT id FROM account
    WHERE "userId" = ${user.id} AND "providerId" = 'credential'
  `) as { id: string }[];

  if (accountRows.length === 0) {
    throw new Error(
      `${user.email} has no credential (email/password) account. ` +
        "They likely signed in via OAuth, so there is no password to reset.",
    );
  }

  const hash = await hashPassword(password);

  // Update every credential account for the user (there should be exactly one,
  // but updating all matching rows is the safe choice if a duplicate exists).
  await sql`
    UPDATE account
    SET password = ${hash}, "updatedAt" = now()
    WHERE "userId" = ${user.id} AND "providerId" = 'credential'
  `;

  // Revoke sessions so the old password's sessions cannot outlive the reset —
  // the same effect Better Auth's own reset-password endpoint has. A stale
  // session would otherwise let a compromised credential keep working.
  await sql`
    DELETE FROM session WHERE "userId" = ${user.id}
  `;

  console.log(`\n[rescue] password reset for ${user.email}.`);
  console.log(`[rescue] revoked sessions for ${user.id}.`);
  if (!args.password) {
    console.log(
      `\n[rescue] generated password (shown once):\n\n    ${password}\n\n` +
        "Log in with it, then change it from Account settings.",
    );
  } else {
    console.log("[rescue] using the password you supplied.");
  }
}

// --- disable-captcha ----------------------------------------------------------

interface CaptchaSettings {
  enabled: boolean;
  provider: string | null;
  siteKey: string | null;
  secretKeyEncrypted: string | null;
  apiEndpoint: string | null;
  minScore: number;
}

const DEFAULT_CAPTCHA: CaptchaSettings = {
  enabled: false,
  provider: null,
  siteKey: null,
  secretKeyEncrypted: null,
  apiEndpoint: null,
  minScore: 0.5,
};

async function disableCaptcha(sql: postgres.Sql, args: ParsedArgs): Promise<void> {
  // Read the current row so the provider/site key/secret survive the disable —
  // this mirrors setCaptchaSettings({ enabled: false }) in services/settings,
  // which deliberately keeps stored keys so re-enabling is a toggle, not a
  // re-entry. The captcha migration seeds this row, but a read-merge-write
  // also covers a panel where it was never seeded.
  const rows = (await sql`
    SELECT value FROM panel_settings WHERE key = 'captcha'
  `) as { value: unknown }[];

  const current: CaptchaSettings = {
    ...DEFAULT_CAPTCHA,
    ...((rows[0]?.value as Partial<CaptchaSettings> | undefined) ?? {}),
    enabled: false,
  };

  console.log(
    `\n[rescue] current captcha: enabled=${
      rows[0] ? String((rows[0].value as { enabled?: boolean }).enabled ?? false) : "(unset)"
    }` +
      (current.provider ? ` provider=${current.provider}` : "") +
      `\n[rescue] this will set enabled=false and keep the stored provider keys.`,
  );

  if (!(await confirm("Proceed?", args.yes))) {
    console.log("[rescue] aborted.");
    return;
  }

  await sql`
    INSERT INTO panel_settings (key, value, updated_by, updated_at)
    VALUES ('captcha', ${sql.json(current as never)}, NULL, now())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
  `;

  console.log(
    "[rescue] captcha disabled. Sign-in/sign-up will no longer require a token.",
  );
  if (current.provider) {
    console.log(
      `[rescue] ${current.provider} keys retained — re-enable from Admin settings or this script's inverse.`,
    );
  }
}

// --- entrypoint ---------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.command === null) {
    console.log(HELP);
    return;
  }

  const KNOWN_COMMANDS = new Set(["reset-password", "disable-captcha"]);
  if (!KNOWN_COMMANDS.has(args.command)) {
    console.error(`Unknown command: ${args.command}\n`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Run `bun run setup` or export it before running this script.",
    );
  }

  // A single connection is all a one-shot CLI needs; max:1 avoids leaving an
  // idle pool behind. onnotice silences Postgres notices (e.g. the CREATE TABLE
  // IF NOT EXISTS noise from other scripts) — there are none here, but it keeps
  // the output clean if the UPSERT emits one.
  const sql = postgres(databaseUrl, {
    max: 1,
    onnotice: () => undefined,
  });

  try {
    switch (args.command) {
      case "reset-password":
        await resetPassword(sql, args);
        break;
      case "disable-captcha":
        await disableCaptcha(sql, args);
        break;
      default:
        // Unreachable: unknown commands are rejected above before connecting.
        console.error(`Unknown command: ${args.command}`);
        process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

await main();
