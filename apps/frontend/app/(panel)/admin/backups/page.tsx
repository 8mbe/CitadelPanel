import type { Metadata } from "next";

import { AdminBackupSettings } from "@/components/admin/backup-settings";

export const metadata: Metadata = { title: "Backups" };

/**
 * Admin backup configuration: the S3 destination, the cron schedule, and the
 * retention policy. Its own route rather than another card under Settings — three
 * separate decisions, each independently saved, and that page is long enough.
 */
export default function AdminBackupsPage() {
  return <AdminBackupSettings />;
}
