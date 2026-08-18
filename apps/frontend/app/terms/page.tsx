import type { Metadata } from "next";

import {
  LegalDocumentPage,
  legalMetadata,
} from "@/components/legal-document-page";

export const dynamic = "force-dynamic";

export function generateMetadata(): Promise<Metadata> {
  return legalMetadata("terms", "Terms of Service");
}

export default function TermsPage() {
  return <LegalDocumentPage document="terms" heading="Terms of Service" />;
}
