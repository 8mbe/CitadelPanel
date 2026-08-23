import type { Metadata } from "next";

import { AdminBackupSettings } from "@/components/admin/backup-settings";

export const metadata: Metadata = { title: "Backups" };

/**
 * Admin backup configuration: the S3 destination, the cron schedule, and the
 * retention policy. Its own route rather than another card under Settings,
 * because these are three separate decisions, each independently saved, and
 * that page is long enough already.
 */
export default function AdminBackupsPage() {
  return <AdminBackupSettings />;
}
