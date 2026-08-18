"use client";

import Link from "next/link";
import { AlertTriangle, RotateCw } from "lucide-react";

import { ErrorPage } from "@/components/error-page";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for the signed-in panel.
 *
 * Distinct from `app/error.tsx` only in what survives: this one sits *below* the
 * panel layout, so the header, navigation, and session stay mounted and the user
 * can move to another page instead of being dropped onto a bare full-screen
 * error. The root boundary remains the fallback for anything above this.
 */
export default function PanelError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <ErrorPage
      code="500"
      title="This page could not be loaded"
      description="The panel reached an error while rendering. Your session is still active — retry, or pick another page from the navigation above."
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
            My servers
          </Button>
        </>
      }
    />
  );
}
