import { Database } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export const metadata = { title: "Database" };

export default function DatabasePage() {
  return (
    <Empty className="min-h-[18rem]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Database />
        </EmptyMedia>
        <EmptyTitle>Databases coming soon</EmptyTitle>
        <EmptyDescription>
          Provision a database for plugins and mods that need one, with
          credentials managed by the panel. This section is not implemented
          yet.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
