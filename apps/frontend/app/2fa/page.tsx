import { redirect } from "next/navigation";

import TwoFactorVerifyForm from "./verify-form";

export const dynamic = "force-dynamic";

/**
 * The second-factor verification page, reached after a successful credential
 * check on an account with 2FA enabled.
 *
 * Unlike the login page, this page does NOT verify a session: at this point the
 * user has entered correct credentials but Better Auth has NOT issued a session
 * cookie — instead it set a short-lived 2FA cookie that authorises only the
 * verification endpoints. Checking `getAuthenticatedUser` here would always
 * fail, so we simply render the form and let it complete the flow.
 */
export default async function TwoFactorPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const next = safeNext((await searchParams).next);
  return <TwoFactorVerifyForm next={next} />;
}

/**
 * Reduce a `?next=` value to a safe same-origin path, or undefined.
 *
 * Mirrors the login page's `safeNext`: anything that could leave this origin —
 * absolute URLs, protocol-relative `//host`, backslash variants — is dropped so
 * the parameter cannot be used as an open redirect after verification.
 */
function safeNext(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.startsWith("/")) return undefined;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return undefined;
  if (raw === "/login" || raw.startsWith("/login?")) return undefined;
  if (raw === "/2fa" || raw.startsWith("/2fa?")) return undefined;
  return raw;
}
