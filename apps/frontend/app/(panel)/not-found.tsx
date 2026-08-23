import Link from "next/link";
import type { Metadata } from "next";
import { SearchX } from "lucide-react";

import { ErrorPage } from "@/components/error-page";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Not found" };

/**
 * The in-panel 404, rendered when a panel route calls `notFound()`. It covers a
 * server id that does not exist, or one the caller may not see.
 *
 * It renders inside the panel shell, so the navigation stays available. The
 * wording avoids confirming whether the resource exists: for a server the caller
 * has no access to, "not found" and "not yours" must be indistinguishable, or the
 * 404 becomes an existence oracle.
 */
export default function PanelNotFound() {
  return (
    <ErrorPage
      code="404"
      title="Not found"
      description="This page does not exist, or your account does not have access to it."
      icon={<SearchX />}
      actions={
        <Button render={<Link href="/" />} nativeButton={false}>
          My servers
        </Button>
      }
    />
  );
}
