import { SettingsForm } from "@/components/settings/settings-form";

export const metadata = { title: "Settings" };

/**
 * Account settings: change username, email, and password; manage API keys;
 * delete the account. Each section is its own form so a change to one never
 * implies a change to another.
 */
export default function SettingsPage() {
  return <SettingsForm />;
}
