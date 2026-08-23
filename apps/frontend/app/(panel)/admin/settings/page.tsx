import { AdminGeneralSettings } from "@/components/admin/general-settings";

/**
 * Admin general settings: timezone, captcha, outbound email (SMTP/Resend), and
 * the email-verification policy. All runtime-configurable. No redeploy needed.
 */
export default function AdminSettingsPage() {
  return <AdminGeneralSettings />;
}
