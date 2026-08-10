import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle, EmptyMedia } from "@/components/ui/empty";
import { Server } from "lucide-react";

export default function ServerNotFound() {
  return (
    <div className="flex flex-1 items-center justify-center py-20">
      <Empty className="max-w-sm">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Server />
          </EmptyMedia>
          <EmptyTitle>Server not found</EmptyTitle>
          <EmptyDescription>
            The server you&apos;re looking for doesn&apos;t exist or was deleted.
          </EmptyDescription>
        </EmptyHeader>
        <Button render={<Link href="/" />} nativeButton={false}>
          Back to dashboard
        </Button>
      </Empty>
    </div>
  );
}
