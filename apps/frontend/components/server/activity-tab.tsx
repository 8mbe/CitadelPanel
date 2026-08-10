import { History } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * Per-server activity.
 *
 * The panel records an audit trail, but a per-server, owner-visible feed is not
 * exposed by the backend yet (the audit log is an admin-only, fleet-wide view).
 * This is an honest placeholder until that endpoint exists.
 */
export function ActivityTab() {
  return (
    <Empty className="min-h-[18rem]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <History />
        </EmptyMedia>
        <EmptyTitle>Activity coming soon</EmptyTitle>
        <EmptyDescription>
          A per-server history of actions — starts, stops, config changes,
          console commands — will appear here. Admins can see fleet-wide activity
          in the Admin → Audit log today.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
