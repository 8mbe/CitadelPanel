"use client";

import Link from "next/link";
import { AlertTriangle, RotateCw } from "lucide-react";

import { ErrorPage } from "@/components/error-page";
import { Button } from "@/components/ui/button";

/**
 * The root error boundary, the panel's "500" page.
 *
 * Catches anything thrown while rendering a route below the root layout, so the
 * theme, fonts, and branding context are all still in place; only the page
 * content is replaced.
 *
 * `unstable_retry()` rather than `reset()`: the common cause here is a failed
 * data read (the database or a node briefly unreachable), and retry re-fetches
 * before re-rendering, where `reset` would re-render the same stale failure. See
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`.
 *
 * `error.message` is not rendered. In production Next.js replaces a server
 * error's message with a generic one to avoid leaking internals, so printing it
 * would show the user nothing useful; `error.digest` is the value that actually
 * correlates with the operator's server logs, and that is what is shown.
 */
export default function RootError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-4">
      <ErrorPage
        code="500"
        title="Something went wrong"
        description="The panel could not render this page. This is usually a temporary failure reaching the database or a node, so trying again often works."
        icon={<AlertTriangle />}
        detail={error.digest ? `Error reference: ${error.digest}` : undefined}
        actions={
          <>
            <Button onClick={() => unstable_retry()}>
              <RotateCw />
              Try again
            </Button>
            <Button
              variant="outline"
              render={<Link href="/" />}
              nativeButton={false}
            >
              Go to the panel
            </Button>
          </>
        }
      />
    </div>
  );
}
