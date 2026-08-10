import { FolderOpen } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export const metadata = { title: "Files" };

export default function FilesPage() {
  return (
    <Empty className="min-h-[18rem]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderOpen />
        </EmptyMedia>
        <EmptyTitle>File manager coming soon</EmptyTitle>
        <EmptyDescription>
          Browse, edit and upload your server&apos;s files directly from the
          panel. This section is not implemented yet.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
