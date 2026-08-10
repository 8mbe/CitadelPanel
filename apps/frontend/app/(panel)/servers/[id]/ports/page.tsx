import { Network } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export const metadata = { title: "Ports" };

export default function PortsPage() {
  return (
    <Empty className="min-h-[18rem]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Network />
        </EmptyMedia>
        <EmptyTitle>Port management coming soon</EmptyTitle>
        <EmptyDescription>
          View the ports published for this server and request additional
          allocations. This section is not implemented yet.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
