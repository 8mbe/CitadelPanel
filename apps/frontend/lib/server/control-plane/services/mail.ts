/**
 * Outbound email (plan.md: email verification + password reset).
 *
 * A thin transport over the operator-chosen provider (SMTP via nodemailer, or
 * Resend over HTTPS), driven by the `mail` row in `panel_settings`. The config
 * is read on every send — Better Auth's email callbacks are functions, not
 * static options, so an admin changing SMTP settings in the UI takes effect
 * immediately without a restart.
 *
 * Failure handling is deliberately silent: `sendMail` logs and swallows every
 * error. Better Auth runs these callbacks via `runInBackgroundOrAwait`, so a
 * thrown error would surface as a 500 on a sign-up or sign-in — turning a
 * transient SMTP outage into a total auth outage. A dropped verification email
 * is recoverable (the user can request another); a blocked sign-in is not.
 */

import "server-only";

import {
  getMailSettings,
  getResendApiKey,
  getSmtpPassword,
  isMailUsable,
} from "./settings";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body; providers fall back to `text` when omitted. */
  html?: string;
}

/** True when mail is configured and usable (a provider with credentials). */
export async function isMailConfigured(): Promise<boolean> {
  return isMailUsable(await getMailSettings());
}

/**
 * Send an email via the configured provider. Returns true on success, false on
 * any failure (including "no mail configured" — treated as a no-op, not an
 * error, so callers in no-mail mode keep working).
 */
export async function sendMail(mail: OutgoingMail): Promise<boolean> {
  const settings = await getMailSettings();
  if (!isMailUsable(settings)) {
    // Not configured: the panel is running without email. This is a normal
    // state, not a fault — verification/reset are simply unavailable.
    return false;
  }

  const from = formatFrom(settings.fromName, settings.fromEmail!);

  try {
    if (settings.provider === "smtp") {
      await sendViaSmtp(settings, from, mail);
    } else if (settings.provider === "resend") {
      await sendViaResend(from, mail);
    } else {
      return false;
    }
    return true;
  } catch (error) {
    // Swallowed on purpose — see the module comment. The operator sees the
    // log; the user never sees a broken auth flow because of it.
    console.error(
      `[mail] failed to send "${mail.subject}" to ${mail.to}:`,
      error,
    );
    return false;
  }
}

/** Build a RFC 5322 From header: `"Name" <addr>` or bare `addr`. */
function formatFrom(name: string | null, email: string): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} <${email}>` : email;
}

async function sendViaSmtp(
  settings: Awaited<ReturnType<typeof getMailSettings>>,
  from: string,
  mail: OutgoingMail,
): Promise<void> {
  // Imported lazily so the nodemailer dependency is never loaded when the panel
  // runs without SMTP configured, and so client bundles (which never reach
  // this server-only module) cannot pull it in.
  const nodemailer = await import("nodemailer");

  const password = await getSmtpPassword();
  const transport = nodemailer.createTransport({
    host: settings.smtpHost!,
    port: settings.smtpPort ?? 587,
    secure: settings.smtpSecure,
    auth: settings.smtpUser
      ? { user: settings.smtpUser, pass: password ?? "" }
      : undefined,
  });

  await transport.sendMail({
    from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}

async function sendViaResend(from: string, mail: OutgoingMail): Promise<void> {
  const apiKey = await getResendApiKey();
  if (!apiKey) return;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Resend API rejected the email (${response.status}): ${detail}`,
    );
  }
}
