import Link from "next/link";

/**
 * Which operator-authored legal documents exist. Both default to false, so a
 * panel whose admin has written neither renders no legal links at all rather
 * than links to empty pages.
 */
export interface LegalAvailability {
  terms: boolean;
  privacy: boolean;
}

/**
 * The footer that carries the build revision and legal links.
 *
 * Published state is passed in from a server component rather than fetched here,
 * because a link that appears a beat after paint is worse than no link: the
 * footer would shift the page just as the reader arrives at it. When neither
 * document is published the footer shows only the site and build, and the
 * `/terms` and `/privacy` routes 404 to match.
 */
export function SiteFooter({
  legal,
  siteName,
}: {
  legal: LegalAvailability;
  siteName: string;
}) {
  const buildCommit = process.env.NEXT_PUBLIC_BUILD_COMMIT ?? "unknown";

  return (
    <footer data-slot="site-footer" className="mt-auto border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground sm:flex-row md:px-6">
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <span>
            {siteName} · {new Date().getFullYear()}
          </span>
          <span title={`Build commit: ${buildCommit}`}>
            · Build <span className="font-mono">{buildCommit.slice(0, 7)}</span>
          </span>
        </div>
        {(legal.terms || legal.privacy) && (
          <nav aria-label="Legal" className="flex items-center gap-4">
            {legal.terms && (
              <Link href="/terms" className="hover:text-foreground">
                Terms of Service
              </Link>
            )}
            {legal.privacy && (
              <Link href="/privacy" className="hover:text-foreground">
                Privacy Policy
              </Link>
            )}
          </nav>
        )}
      </div>
    </footer>
  );
}
