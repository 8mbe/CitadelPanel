import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";

import { Markdown } from "@/components/markdown";
import { SiteFooter } from "@/components/site-footer";
import { Button } from "@/components/ui/button";
import {
  getLegalDocument,
  type LegalDocumentKey,
} from "@/lib/server/control-plane/services/settings";
import { getLegalAvailability, getSiteSettings } from "@/lib/server/site-settings";

/**
 * The public rendering of an operator-authored legal document.
 *
 * Unauthenticated: a privacy policy the reader has to sign in to read is not a
 * privacy policy. An unpublished (empty) document `notFound()`s rather than
 * rendering an empty page, which is also how a policy is withdrawn — clearing
 * the editor removes both the page and the footer link.
 *
 * The Markdown is rendered to React nodes by `components/markdown.tsx`, never
 * to an HTML string; see the note there on why that matters for a page served to
 * anonymous visitors.
 */
export async function LegalDocumentPage({
  document,
  heading,
}: {
  document: LegalDocumentKey;
  heading: string;
}) {
  const [doc, { branding }, legal] = await Promise.all([
    getLegalDocument(document),
    getSiteSettings(),
    getLegalAvailability(),
  ]);

  if (!doc.content) notFound();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-2 px-4 md:px-6">
          <Button
            variant="ghost"
            size="sm"
            render={<Link href="/" />}
            nativeButton={false}
          >
            <ArrowLeft data-icon="inline-start" />
            <span className="truncate">{branding.siteName}</span>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 md:px-6">
        {/* The document's own `# Heading` usually names it, so this is a
            screen-reader-only fallback for a document that does not. */}
        <h1 className="sr-only">{heading}</h1>
        <Markdown content={doc.content} />
        {doc.updatedAt && (
          <p className="mt-10 border-t pt-4 text-xs text-muted-foreground">
            Last updated{" "}
            {new Date(doc.updatedAt).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        )}
      </main>

      <SiteFooter legal={legal} siteName={branding.siteName} />
    </div>
  );
}

/**
 * Title-only metadata for a legal route. The root layout's template appends the
 * site name, and its `robots` directive already reflects the indexing toggle, so
 * neither needs restating here.
 */
export async function legalMetadata(
  document: LegalDocumentKey,
  heading: string,
): Promise<Metadata> {
  const doc = await getLegalDocument(document).catch(() => null);
  // An unpublished document renders a 404; Next.js marks those `noindex`
  // automatically, so there is nothing extra to do for the empty case.
  return { title: heading, ...(doc?.content ? {} : { robots: { index: false } }) };
}
