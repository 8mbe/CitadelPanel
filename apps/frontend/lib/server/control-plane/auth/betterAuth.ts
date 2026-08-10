/**
 * Better Auth configuration (plan.md section 6).
 *
 * Auth is delegated to Better Auth rather than hand-rolled: session handling,
 * password hashing, and cookie security are library concerns. The only
 * panel-specific addition is the `role` field on the user model, restricted to
 * exactly two values.
 */

import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { admin } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { authPool, sql } from "../db/client";
import { env } from "../config/env";
import { CAPTCHA_HEADER, verifyCaptcha } from "../security/captcha";
import { sendMail } from "../services/mail";
import {
  getVerificationPolicy,
  isMailUsable,
  getMailSettings,
} from "../services/settings";

/** The only two global roles that exist (plan.md section 5). */
export const ROLES = ["user", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Format a millisecond duration as a compact human string (e.g. "3d 4h", "12h",
 * "45m", "< 1m"). Used only to render a ban's remaining time to the banned user.
 */
function formatDuration(ms: number): string {
  if (ms <= 0) return "less than a minute";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/**
 * Promote the very first registered account to `admin`.
 *
 * This avoids shipping a hardcoded default credential. It runs inside the
 * post-creation hook and only fires when the new user is the sole row in the
 * table, so subsequent signups are always plain users.
 */
async function promoteFirstUserToAdmin(userId: string): Promise<void> {
  if (!env.firstUserBecomesAdmin) return;

  const rows = (await sql`SELECT COUNT(*)::int AS count FROM "user"`) as {
    count: number;
  }[];

  if (rows[0]?.count === 1) {
    await sql`UPDATE "user" SET role = 'admin' WHERE id = ${userId}`;
    console.log(`[auth] first user ${userId} promoted to admin`);
  }
}

/**
 * Credential paths that require a captcha when one is configured.
 *
 * Deliberately not the whole auth surface: these are the endpoints an attacker
 * scripts (credential stuffing, mass account creation, reset-email flooding).
 * Gating session reads or sign-out would break the panel for a signed-in user
 * whose widget failed to load, for no security gain.
 */
const CAPTCHA_PROTECTED_PATHS = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/request-password-reset",
  "/forget-password",
]);

/**
 * Captcha enforcement as a before-hook rather than Better Auth's own `captcha`
 * plugin.
 *
 * The plugin takes its provider and secret at construction time from the
 * environment. Ours are chosen by the operator in the setup wizard and stored in
 * `panel_settings`, so they are not known when this module is evaluated — and a
 * change must take effect without a restart. The hook reads current settings per
 * request (cached in `services/settings`), which the plugin cannot do.
 *
 * It also lets `cap` participate, which the plugin does not support.
 */
const captchaHook = async (ctx: {
  path: string;
  headers?: Headers | null;
}): Promise<void> => {
  if (!CAPTCHA_PROTECTED_PATHS.has(ctx.path)) return;

  const headers = ctx.headers;
  const token = headers?.get(CAPTCHA_HEADER) ?? null;
  const forwarded = headers?.get("x-forwarded-for");
  const remoteIp =
    forwarded?.split(",")[0]?.trim() || headers?.get("x-real-ip") || null;

  const result = await verifyCaptcha(token, remoteIp);
  if (!result.ok) {
    // 400 rather than 403: from the client's perspective this is a malformed
    // submission it can retry with a fresh token, not an authorization failure.
    throw new APIError("BAD_REQUEST", {
      message: result.error ?? "Captcha verification failed.",
    });
  }
};

// --- Email verification gate --------------------------------------------------

/**
 * Enforce "verified email required to sign in" as a runtime knob.
 *
 * Better Auth's own `emailAndPassword.requireEmailVerification` is a static
 * config flag — set once at startup. The operator needs to toggle this from the
 * admin settings without a redeploy, so it lives in `panel_settings` and is
 * enforced here, on `/sign-in/email`, before the credential check runs.
 *
 * Only meaningful when mail is configured: there is no way to verify an address
 * you cannot send to, so requiring verification with no mail would permanently
 * lock out every account. The hook checks both conditions.
 *
 * Runs before the password is verified, so a rejected sign-in never reveals
 * whether the password was correct. The user is told to verify their email,
 * not that their credentials are wrong — which is also what Better Auth's own
 * gate does.
 */
const verificationGateHook = async (ctx: {
  path: string;
  body?: unknown;
}): Promise<void> => {
  if (ctx.path !== "/sign-in/email") return;

  const policy = await getVerificationPolicy();
  if (!policy.requireVerifiedSignIn) return;

  // No mail ⇒ no verification possible ⇒ the policy cannot apply. Degrade to
  // the no-verification mode rather than locking everyone out.
  const mail = await getMailSettings();
  if (!isMailUsable(mail)) return;

  const email = (ctx.body as { email?: unknown } | undefined)?.email;
  if (typeof email !== "string" || email.length === 0) return;

  const rows = (await sql`
    SELECT "emailVerified" FROM "user" WHERE email = ${email.toLowerCase()}
  `) as { emailVerified: boolean }[];

  const user = rows[0];
  // An unknown email is left for the sign-in handler to reject with the usual
  // "invalid email or password" — surfacing "not verified" here would leak that
  // the account exists.
  if (user && !user.emailVerified) {
    throw new APIError("FORBIDDEN", {
      message:
        "Please verify your email address before signing in. Check your inbox for a verification link, or request a new one from your account settings.",
      code: "EMAIL_NOT_VERIFIED",
    });
  }
};

/**
 * Block a banned user from signing in, surfacing the *specific* reason and
 * remaining duration.
 *
 * The admin plugin already blocks banned sessions via its `session.create.before`
 * hook, but with a generic `bannedUserMessage` (a static string that cannot carry
 * per-user detail). This hook runs earlier — on `/sign-in/email`, before the
 * password is verified — so it can read the banned user's row and throw a
 * message the login page renders verbatim. Running before credential check also
 * avoids revealing whether the password was correct (same property as the
 * verification gate). An expired ban is cleared and allowed through.
 *
 * Note on ordering: plugin `databaseHooks` run before config `databaseHooks`, so
 * a session-create hook here would lose the race to the plugin's generic throw —
 * which is why the ban check lives in this `before` hook instead.
 */
const banCheckHook = async (ctx: {
  path: string;
  body?: unknown;
}): Promise<void> => {
  if (ctx.path !== "/sign-in/email") return;

  const email = (ctx.body as { email?: unknown } | undefined)?.email;
  if (typeof email !== "string" || email.length === 0) return;

  const rows = (await sql`
    SELECT banned, "banReason", "banExpires" FROM "user"
    WHERE email = ${email.toLowerCase()}
  `) as {
    banned: boolean | null;
    banReason: string | null;
    banExpires: Date | null;
  }[];

  const user = rows[0];
  // Unknown email is left for the sign-in handler to reject normally — surfacing
  // a ban status here would leak that the account exists.
  if (!user?.banned) return;

  if (user.banExpires && user.banExpires.getTime() < Date.now()) {
    // Ban has lapsed: clear it so future requests skip this path, and allow.
    await sql`
      UPDATE "user" SET banned = FALSE, "banReason" = NULL, "banExpires" = NULL
      WHERE email = ${email.toLowerCase()}
    `;
    return;
  }

  const parts = ["Your account has been banned."];
  if (user.banReason) parts.push(`Reason: ${user.banReason}.`);
  if (user.banExpires) {
    const remainingMs = user.banExpires.getTime() - Date.now();
    parts.push(`Expires in ${formatDuration(remainingMs)}.`);
  } else {
    parts.push("This ban does not expire.");
  }
  throw new APIError("FORBIDDEN", {
    message: parts.join(" "),
    code: "BANNED_USER",
  });
};

// --- Outbound email callbacks -------------------------------------------------

/**
 * The three email flows Better Auth needs a sender for. Each reads the live
 * `mail` settings on call — these are functions, not static config, so an admin
 * switching SMTP host or turning email on takes effect immediately. When mail
 * is not configured, `sendMail` is a no-op and the panel runs without email.
 *
 * Better Auth runs these via `runInBackgroundOrAwait`, so the request is not
 * held while the mail server responds; a send failure is logged inside
 * `sendMail` and swallowed, never propagated as a 500.
 */

/** Send the "verify your email" link after sign-up or on manual request. */
async function sendVerificationEmail({
  user,
  url,
}: {
  user: { email: string; name?: string | null };
  url: string;
  token: string;
}): Promise<void> {
  await sendMail({
    to: user.email,
    subject: "Verify your email address",
    text: `Verify your email address by opening this link:\n\n${url}\n\nIf you did not create an account, you can ignore this message.`,
    html: `<p>Verify your email address by opening this link:</p><p><a href="${url}">${url}</a></p><p style="color:#666">If you did not create an account, you can ignore this message.</p>`,
  });
}

/** Send the password-reset link (forgot password flow). */
async function sendResetPassword({
  user,
  url,
}: {
  user: { email: string };
  url: string;
  token: string;
}): Promise<void> {
  await sendMail({
    to: user.email,
    subject: "Reset your password",
    text: `Reset your password by opening this link:\n\n${url}\n\nIf you did not request a password reset, you can ignore this message — your password has not been changed.`,
    html: `<p>Reset your password by opening this link:</p><p><a href="${url}">${url}</a></p><p style="color:#666">If you did not request a password reset, you can ignore this message — your password has not been changed.</p>`,
  });
}

/**
 * Send a "confirm this email change" link to the *current* address before a
 * requested change takes effect. Only invoked when mail is configured; without
 * it, `updateEmailWithoutVerification` lets the change apply immediately.
 */
async function sendChangeEmailConfirmation({
  user,
  newEmail,
  url,
}: {
  user: { email: string };
  newEmail: string;
  url: string;
  token: string;
}): Promise<void> {
  await sendMail({
    to: user.email,
    subject: "Confirm your new email address",
    text: `A request was made to change the email on your CitadelPanel account to ${newEmail}.\n\nConfirm this change by opening this link:\n\n${url}\n\nIf you did not request this change, ignore this message — your email will not be changed.`,
    html: `<p>A request was made to change the email on your CitadelPanel account to <strong>${newEmail}</strong>.</p><p>Confirm this change by opening this link:</p><p><a href="${url}">${url}</a></p><p style="color:#666">If you did not request this change, ignore this message — your email will not be changed.</p>`,
  });
}

/**
 * The single `before` hook Better Auth runs on every auth request.
 *
 * `hooks.before` accepts one middleware, so the captcha gate and the email-
 * verification gate are composed here. Each no-ops early when its path or
 * conditions do not match, so they are independent: a sign-up hits only the
 * captcha check; a sign-in hits both (captcha first, then verification).
 */
const beforeHook = createAuthMiddleware(async (ctx) => {
  await captchaHook(ctx);
  await verificationGateHook(ctx);
  await banCheckHook(ctx);
});

export const auth = betterAuth({
  database: authPool,
  secret: env.authSecret,
  baseURL: env.authBaseUrl,

  // The frontend runs on a different origin in development.
  trustedOrigins: [env.frontendUrl],

  plugins: [
    // API keys that authenticate the same /api/* surface the session cookie
    // does. With `enableSessionForAPIKeys`, the plugin's before-hook turns a
    // valid key into the owner's session on every `auth.api.*` call — which is
    // how the BFF's `requireAuth`/`requireAdmin` guards resolve sessions — so a
    // user key works against every panel route with no guard changes and can
    // never escalate to admin (the mock session carries the owner's real role,
    // re-checked by `requireAdmin`). `x-api-key` mirrors the project's own
    // header convention; `Authorization: Bearer` also works.
    apiKey({
      enableSessionForAPIKeys: true,
      apiKeyHeaders: ["x-api-key"],
    }),
    // The admin plugin owns the `role` field (replacing the manual
    // additionalField we used to declare — identical schema: string, not user-
    // settable, defaults to "user") and adds ban support: `banned`,
    // `banReason`, `banExpires` columns on `user`. `auth.api.banUser` revokes
    // every session the user holds, and the plugin's `session.create.before`
    // hook blocks a banned user from signing in (auto-clearing an expired ban).
    // We surface the *reason* and remaining duration to the banned user via our
    // own session-create hook below, since `bannedUserMessage` is a static
    // string and cannot carry per-user detail.
    admin({
      defaultBanReason: "No reason provided",
    }),
  ],

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    // `requireEmailVerification` is deliberately FALSE here: it is a static
    // flag Better Auth reads at request time from this config object, so it
    // cannot be toggled at runtime. The runtime "require verified email to
    // sign in" knob lives in `panel_settings` and is enforced by
    // `verificationGateHook` above. Keeping this false means Better Auth's own
    // gate never fires; the hook is the single source of truth.
    requireEmailVerification: false,
    // Sends the password-reset link. A no-op when mail is unconfigured.
    sendResetPassword,
  },

  // Email verification. `sendOnSignUp` sends a verify link on registration —
  // only meaningful when mail is configured (otherwise `sendMail` is a no-op
  // and the user simply stays unverified, which is fine in no-mail mode).
  // `autoSignInAfterVerification` signs the user in once they click the link.
  emailVerification: {
    sendVerificationEmail,
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
  },

  user: {
    // `role` is no longer declared here as an additionalField: the admin plugin
    // owns it (same schema — string, not user-settable, defaults to "user").
    // `promoteFirstUserToAdmin` below still promotes the first account.
    changeEmail: {
      enabled: true,
      // Adaptive: when mail is configured, `sendChangeEmailConfirmation` sends
      // a link to the current address and the change completes on click. When
      // mail is NOT configured, this flag lets the change apply immediately so
      // the user can still update their address. The trade-off in no-mail mode
      // is that an email change is session-only-authed (no re-verification);
      // acceptable for a self-hosted panel and mitigated by strict session
      // cookies.
      updateEmailWithoutVerification: true,
      sendChangeEmailConfirmation,
    },
    deleteUser: {
      enabled: true,
      // Account deletion is gated on 0 servers by the BFF route
      // (POST /api/account/delete) before this endpoint is ever reached, and
      // always supplies the password for immediate deletion. No email
      // confirmation round-trip — the password is the confirmation.
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh once per day
  },

  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "strict",
      secure: env.isProduction,
    },
  },

  // Blunt credential stuffing against the auth endpoints.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 20,
  },

  hooks: {
    // One composed before-hook runs the captcha gate then the email-verification
    // gate; each no-ops early when its path/conditions do not match.
    before: beforeHook,
  },

  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await promoteFirstUserToAdmin(user.id);
        },
      },
    },
  },
});

export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
