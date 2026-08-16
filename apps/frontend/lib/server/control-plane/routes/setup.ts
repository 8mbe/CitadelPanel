/**
 * First-time setup routes.
 *
 * The panel ships with no credentials at all, so there has to be one narrow,
 * unauthenticated window in which the first admin account can be claimed. These
 * endpoints are that window, and the whole design is about closing it:
 *
 *   - `POST /api/setup/admin` refuses the moment any admin exists. It is not
 *     gated on the `setup.completedAt` latch alone, because that latch is
 *     writable by the same unauthenticated flow; the admin count is derived from
 *     real accounts and cannot be reset from outside.
 *   - Every later step requires a normal admin session. Creating the account
 *     signs the caller in, so the wizard continues authenticated from step 2 on.
 *
 * The remaining exposure is a race between deploying the panel and completing
 * setup: whoever reaches it first becomes admin. That is inherent to any
 * no-default-credential bootstrap, and it is why `/api/setup/status` reports
 * `needsSetup` — an operator can see at a glance that the window is still open.
 */

import { requireAdmin } from "../auth/middleware";
import { auth } from "../auth/betterAuth";
import { env } from "../config/env";
import { sql } from "../db/client";
import {
  badRequest,
  conflict,
  json,
  parseJsonBody,
  requireNumber,
  requireString,
  optionalString,
} from "../lib/http";
import { recordAuditFromRequest } from "../services/auditLog";
import { sendMail } from "../services/mail";
import {
  countAdmins,
  countUsers,
  getCaptchaSettings,
  getMailSettings,
  getPublicCaptchaSettings,
  getPublicMailSettings,
  getSetupState,
  getVerificationPolicy,
  getTimezone,
  isCaptchaProvider,
  isMailProvider,
  isSetupComplete,
  isValidTimezone,
  MAIL_PROVIDERS,
  markSetupComplete,
  setCaptchaSettings,
  setMailSettings,
  setVerificationPolicy,
  setTimezone,
  getServerLimits,
  setServerLimits,
  CAPTCHA_PROVIDERS,
} from "../services/settings";

/**
 * GET /api/setup/status — public.
 *
 * Unauthenticated on purpose: the login page and the wizard both need to know
 * whether setup is pending before anyone can possibly hold a session. It reports
 * only counts and configuration state, never account details.
 */
export async function handleSetupStatus(): Promise<Response> {
  const [admins, users, nodes, state, timezone, captcha] = await Promise.all([
    countAdmins(),
    countUsers(),
    countNodes(),
    getSetupState(),
    getTimezone(),
    getPublicCaptchaSettings(),
  ]);

  const complete =
    typeof state.completedAt === "string" && state.completedAt.length > 0 && admins > 0;

  return json({
    needsSetup: !complete,
    completedAt: state.completedAt,
    adminCount: admins,
    userCount: users,
    nodeCount: nodes,
    timezone,
    captcha,
    /**
     * The bootstrap endpoint's own gate, surfaced so the wizard can explain a
     * refusal instead of showing a bare 409. False means an admin already
     * exists and the first-admin step must be skipped.
     */
    canCreateAdmin: admins === 0,
  });
}

async function countNodes(): Promise<number> {
  const rows = (await sql`SELECT COUNT(*)::int AS count FROM nodes`) as {
    count: number;
  }[];
  return rows[0]?.count ?? 0;
}

/**
 * POST /api/setup/admin — claim the first admin account. Unauthenticated, once.
 *
 * Account creation is delegated to Better Auth rather than inserting a row: it
 * owns password hashing and session issuance, and a hand-rolled bootstrap user
 * would be the one account in the system whose credentials were handled
 * differently. The response carries Better Auth's `Set-Cookie` through, so the
 * wizard is signed in for the remaining steps.
 *
 * The role is set here explicitly instead of relying on FIRST_USER_BECOMES_ADMIN,
 * which an operator may have turned off — the account this endpoint creates is
 * an admin by definition.
 */
export async function handleSetupCreateAdmin(request: Request): Promise<Response> {
  // Re-checked inside the transaction-less path below; checked here first so the
  // common refusal does not depend on Better Auth's error shape.
  if ((await countAdmins()) > 0) {
    throw conflict(
      "An administrator account already exists. Sign in instead — first-time setup is closed.",
    );
  }

  const body = await parseJsonBody(request);
  const email = requireString(body, "email", { max: 255 });
  const name = requireString(body, "name", { max: 128 });
  const password = requireString(body, "password", { min: 12, max: 512 });

  if (!email.includes("@")) {
    throw badRequest('"email" must be a valid email address');
  }

  let created;
  try {
    created = await auth.api.signUpEmail({
      returnHeaders: true,
      body: { email, name, password },
    });
  } catch (error) {
    // Better Auth reports its own validation failures (weak password, duplicate
    // email) as APIError; surface the message rather than a generic 500.
    const message =
      error instanceof Error ? error.message : "Could not create the account";
    throw badRequest(message);
  }

  const userId = created.response.user.id;

  // Promote conditionally rather than unconditionally. Two operators racing the
  // bootstrap window could both pass the count check above; this WHERE clause
  // lets whichever transaction commits first claim admin and leaves the other
  // account a regular user, so the panel never ends up with a surprise second
  // admin from a single bootstrap race. (When FIRST_USER_BECOMES_ADMIN is on,
  // the database hook has already promoted; this update is then a no-op.)
  const promoted = (await sql`
    UPDATE "user" SET role = 'admin'
    WHERE id = ${userId}
      AND (SELECT COUNT(*) FROM "user" WHERE role = 'admin') = 0
    RETURNING role
  `) as { role: string }[];

  // Lost the race: another request claimed admin between our count check and
  // this update. The account exists as a regular user; tell the caller plainly
  // rather than returning role: "admin" it does not have.
  if (promoted.length === 0) {
    // The Better Auth first-user hook may already have promoted this exact user.
    // Distinguish that successful path from a genuine competing bootstrap call.
    const current = await sql<{ role: string }[]>`
      SELECT role FROM "user" WHERE id = ${userId}
    `;
    if (current[0]?.role !== "admin") {
      throw conflict(
        "An administrator account was just created by someone else. Your account was created as a regular user — ask that administrator for access.",
      );
    }
  }

  await recordAuditFromRequest(request, {
    userId,
    action: "setup.admin.create",
    targetType: "user",
    targetId: userId,
    metadata: { email, viaSetupWizard: true },
  });

  console.log(`[setup] first admin account created: ${email}`);

  // Forward Better Auth's session cookie so the wizard continues authenticated.
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of created.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }

  return new Response(
    JSON.stringify({
      user: { id: userId, email, name, role: "admin" },
    }),
    { status: 201, headers },
  );
}

/**
 * PATCH /api/setup/settings — timezone and captcha. Admin only.
 *
 * Shared by the wizard and the admin settings page: there is no second code path
 * that writes these, so validation cannot drift between "during setup" and
 * "after setup".
 */
export async function handleUpdateSettings(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  const body = await parseJsonBody(request);

  const changed: string[] = [];

  if (body.timezone !== undefined) {
    const timezone = requireString(body, "timezone", { max: 64 });
    if (!isValidTimezone(timezone)) {
      throw badRequest(
        `"${timezone}" is not a recognised IANA timezone (e.g. "Europe/Berlin", "UTC").`,
      );
    }
    await setTimezone(timezone, admin.id);
    changed.push("timezone");
  }

  if (body.captcha !== undefined) {
    if (
      typeof body.captcha !== "object" ||
      body.captcha === null ||
      Array.isArray(body.captcha)
    ) {
      throw badRequest('"captcha" must be an object');
    }

    const captcha = body.captcha as Record<string, unknown>;
    if (typeof captcha.enabled !== "boolean") {
      throw badRequest('"captcha.enabled" must be a boolean');
    }

    let provider = null;
    if (captcha.provider !== undefined && captcha.provider !== null) {
      if (!isCaptchaProvider(captcha.provider)) {
        throw badRequest(
          `"captcha.provider" must be one of: ${CAPTCHA_PROVIDERS.join(", ")}`,
        );
      }
      provider = captcha.provider;
    }

    const minScore =
      captcha.minScore === undefined
        ? undefined
        : requireNumber(captcha, "minScore", { min: 0, max: 1 });

    try {
      await setCaptchaSettings(
        {
          enabled: captcha.enabled,
          provider,
          siteKey: optionalString(captcha, "siteKey", { max: 512 }) ?? null,
          // Undefined keeps the stored secret; the form omits it on re-save
          // because the plaintext is never readable again.
          secretKey:
            captcha.secretKey === undefined
              ? undefined
              : (optionalString(captcha, "secretKey", { max: 512 }) ?? null),
          apiEndpoint: optionalString(captcha, "apiEndpoint", { max: 512 }) ?? null,
          minScore,
        },
        admin.id,
      );
    } catch (error) {
      // setCaptchaSettings enforces "enabled requires a complete config".
      throw badRequest(
        error instanceof Error ? error.message : "Invalid captcha configuration",
      );
    }
    changed.push("captcha");
  }

  if (body.mail !== undefined) {
    if (
      typeof body.mail !== "object" ||
      body.mail === null ||
      Array.isArray(body.mail)
    ) {
      throw badRequest('"mail" must be an object');
    }

    const mail = body.mail as Record<string, unknown>;
    if (typeof mail.enabled !== "boolean") {
      throw badRequest('"mail.enabled" must be a boolean');
    }

    let provider = null;
    if (mail.provider !== undefined && mail.provider !== null) {
      if (!isMailProvider(mail.provider)) {
        throw badRequest(
          `"mail.provider" must be one of: ${MAIL_PROVIDERS.join(", ")}`,
        );
      }
      provider = mail.provider;
    }

    const smtpSecure =
      mail.smtpSecure === undefined ? undefined : mail.smtpSecure === true;

    try {
      await setMailSettings(
        {
          enabled: mail.enabled,
          provider,
          fromName: optionalString(mail, "fromName", { max: 128 }) ?? null,
          fromEmail: optionalString(mail, "fromEmail", { max: 255 }) ?? null,
          smtpHost: optionalString(mail, "smtpHost", { max: 255 }) ?? null,
          smtpPort:
            mail.smtpPort === undefined || mail.smtpPort === null
              ? null
              : requireNumber(mail, "smtpPort", { min: 1, max: 65535 }),
          smtpUser: optionalString(mail, "smtpUser", { max: 255 }) ?? null,
          // Undefined keeps the stored secret; an empty string clears it.
          smtpPassword:
            mail.smtpPassword === undefined
              ? undefined
              : (optionalString(mail, "smtpPassword", { max: 512 }) ?? null),
          smtpSecure,
          resendApiKey:
            mail.resendApiKey === undefined
              ? undefined
              : (optionalString(mail, "resendApiKey", { max: 512 }) ?? null),
        },
        admin.id,
      );
    } catch (error) {
      // setMailSettings enforces "enabled requires a complete config".
      throw badRequest(
        error instanceof Error ? error.message : "Invalid mail configuration",
      );
    }
    changed.push("mail");
  }

  if (body.verification !== undefined) {
    if (
      typeof body.verification !== "object" ||
      body.verification === null ||
      Array.isArray(body.verification)
    ) {
      throw badRequest('"verification" must be an object');
    }
    const verification = body.verification as Record<string, unknown>;
    if (verification.requireVerifiedSignIn !== undefined) {
      if (typeof verification.requireVerifiedSignIn !== "boolean") {
        throw badRequest('"verification.requireVerifiedSignIn" must be a boolean');
      }
      await setVerificationPolicy(
        { requireVerifiedSignIn: verification.requireVerifiedSignIn },
        admin.id,
      );
      changed.push("verification");
    }
  }

  if (body.serverLimits !== undefined) {
    if (
      typeof body.serverLimits !== "object" ||
      body.serverLimits === null ||
      Array.isArray(body.serverLimits)
    ) {
      throw badRequest('"serverLimits" must be an object');
    }
    const serverLimits = body.serverLimits as Record<string, unknown>;
    const update: Partial<{ maxAdditionalPortsPerServer: number; maxDatabasesPerServer: number }> = {};
    if (serverLimits.maxAdditionalPortsPerServer !== undefined) {
      update.maxAdditionalPortsPerServer = requireNumber(
        serverLimits,
        "maxAdditionalPortsPerServer",
        { min: 0, max: 100 },
      );
    }
    if (serverLimits.maxDatabasesPerServer !== undefined) {
      update.maxDatabasesPerServer = requireNumber(
        serverLimits,
        "maxDatabasesPerServer",
        { min: 0, max: 100 },
      );
    }
    try {
      await setServerLimits(update, admin.id);
    } catch (error) {
      throw badRequest(
        error instanceof Error ? error.message : "Invalid server limits",
      );
    }
    changed.push("serverLimits");
  }

  if (changed.length === 0) {
    throw badRequest(
      "Provide at least one of: timezone, captcha, mail, verification, serverLimits",
    );
  }

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "settings.update",
    targetType: "settings",
    // Field names only — never a captcha or mail secret.
    metadata: { changed },
  });

  return json({
    timezone: await getTimezone(),
    captcha: await getAdminCaptchaView(),
    mail: await getPublicMailSettings(),
    verification: await getVerificationPolicy(),
    serverLimits: await getServerLimits(),
  });
}

/**
 * GET /api/admin/settings — current settings for the admin settings page.
 *
 * The secret key is reported as a boolean, not a value: it is stored encrypted
 * precisely so it cannot be read back, and an admin session is not a reason to
 * hand it out again.
 */
export async function handleGetSettings(request: Request): Promise<Response> {
  await requireAdmin(request);

  return json({
    timezone: await getTimezone(),
    captcha: await getAdminCaptchaView(),
    mail: await getPublicMailSettings(),
    verification: await getVerificationPolicy(),
    serverLimits: await getServerLimits(),
    setup: await getSetupState(),
  });
}

async function getAdminCaptchaView() {
  const captcha = await getCaptchaSettings();
  return {
    enabled: captcha.enabled,
    provider: captcha.provider,
    siteKey: captcha.siteKey,
    apiEndpoint: captcha.apiEndpoint,
    minScore: captcha.minScore,
    /** Whether a secret is stored, so the form can show "unchanged". */
    hasSecretKey: captcha.secretKeyEncrypted !== null,
  };
}

/**
 * POST /api/admin/settings/test-email — send a test message to a given address.
 *
 * Lets an admin confirm their SMTP/Resend config actually delivers before
 * relying on it for verification and password-reset emails. The address is
 * validated here; the send itself never throws — `sendMail` logs and swallows
 * transport errors, returning false instead, so a misconfigured server yields a
 * readable "did not send" result rather than a 500.
 */
export async function handleTestEmail(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  const body = await parseJsonBody(request);
  const to = requireString(body, "to", { max: 255 });
  if (!to.includes("@")) {
    throw badRequest('"to" must be a valid email address');
  }

  const mail = await getMailSettings();
  if (
    !mail.enabled ||
    !mail.provider ||
    !mail.fromEmail
  ) {
    throw badRequest(
      "Configure and enable a mail provider before sending a test email.",
    );
  }

  const sent = await sendMail({
    to,
    subject: "CitadelPanel test email",
    text: `This is a test email from CitadelPanel, sent by ${admin.email}. If you received it, your mail configuration is working.`,
    html: `<p>This is a test email from CitadelPanel, sent by <strong>${admin.email}</strong>.</p><p>If you received it, your mail configuration is working.</p>`,
  });

  return json({ ok: sent });
}

/**
 * POST /api/setup/complete — close the setup window. Admin only.
 *
 * Idempotent: re-running it on a completed install returns the existing
 * timestamp rather than refusing, so a double-submit from the wizard's last step
 * is not an error the operator has to interpret.
 */
export async function handleSetupComplete(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);

  if (await isSetupComplete()) {
    const state = await getSetupState();
    return json({ completedAt: state.completedAt, alreadyComplete: true });
  }

  await markSetupComplete(admin.id);
  const state = await getSetupState();

  await recordAuditFromRequest(request, {
    userId: admin.id,
    action: "setup.complete",
    targetType: "settings",
    metadata: { nodeCount: await countNodes() },
  });

  console.log("[setup] first-time setup completed");

  return json({ completedAt: state.completedAt, alreadyComplete: false });
}

/**
 * GET /api/settings/public — public.
 *
 * What an unauthenticated page legitimately needs: the captcha site key so the
 * login form can render its widget, and the timezone so timestamps read
 * consistently before sign-in.
 */
export async function handlePublicSettings(): Promise<Response> {
  return json({
    timezone: await getTimezone(),
    captcha: await getPublicCaptchaSettings(),
    // Surfaced so the file manager can pre-validate uploads client-side and
    // show the limit in the UI before a request is ever made.
    uploadMaxBytes: env.uploadMaxBytes,
  });
}
