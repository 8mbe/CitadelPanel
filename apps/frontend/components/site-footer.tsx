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
 * The footer that carries the legal links.
 *
 * Published state is passed in from a server component rather than fetched here,
 * because a link that appears a beat after paint is worse than no link: the
 * footer would shift the page just as the reader arrives at it. When neither
 * document is published the footer collapses to the copyright line, and the
 * `/terms` and `/privacy` routes 404 to match.
 */
export function SiteFooter({
  legal,
  siteName,
}: {
  legal: LegalAvailability;
  siteName: string;
}) {
  return (
    <footer className="mt-auto border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground sm:flex-row md:px-6">
        <span>
          {siteName} · {new Date().getFullYear()}
        </span>
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
