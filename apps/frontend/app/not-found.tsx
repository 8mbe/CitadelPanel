import Link from "next/link";
import type { Metadata } from "next";
import { FileQuestion } from "lucide-react";

import { ErrorPage } from "@/components/error-page";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

/**
 * The 404 page, for both an unmatched URL and an explicit `notFound()` call.
 *
 * It sends the visitor to `/`, not to `/login`, on purpose: `/` already resolves
 * correctly for either audience. A signed-in user lands on their servers, and
 * everyone else is redirected to sign in by the panel layout. Linking straight
 * to `/login` would bounce a signed-in user through a redirect for no reason.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-4">
      <ErrorPage
        code="404"
        title="Page not found"
        description="This URL does not match anything in the panel. It may have been renamed, or the server it referred to may have been deleted."
        icon={<FileQuestion />}
        actions={
          <Button render={<Link href="/" />} nativeButton={false}>
            Go to the panel
          </Button>
        }
      />
    </div>
  );
}
