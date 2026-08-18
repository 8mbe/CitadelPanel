"use client";

import "./globals.css";
import { AlertOctagon, RotateCw } from "lucide-react";

import { ErrorPage } from "@/components/error-page";
import { ThemeProvider } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";

/**
 * The last-resort error page: it replaces the root layout, so it fires only when
 * the layout itself failed — a broken font load, or a settings read that somehow
 * threw despite `lib/server/site-settings.ts` swallowing failures.
 *
 * Because it stands in for the root layout it must supply its own `<html>`,
 * `<body>`, and global stylesheet, and it cannot export `metadata` (error
 * boundaries are Client Components) — hence the React `<title>` element.
 *
 * The site name is hardcoded here rather than read from settings. Everything
 * that could resolve it is exactly what has already failed by the time this
 * renders; a second attempt would only fail again, and the point of this page is
 * to render unconditionally.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full">
        <title>Something went wrong</title>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <div className="flex min-h-dvh flex-col items-center justify-center bg-background p-4">
            <ErrorPage
              code="500"
              title="The panel failed to start this page"
              description="An error occurred outside any page, so nothing could be rendered around it. If this persists, check the panel's server logs — the reference below appears alongside the stack trace."
              icon={<AlertOctagon />}
              detail={
                error.digest ? `Error reference: ${error.digest}` : undefined
              }
              actions={
                <Button onClick={() => unstable_retry()}>
                  <RotateCw />
                  Try again
                </Button>
              }
            />
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
