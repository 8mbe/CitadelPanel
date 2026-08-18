import type { Metadata } from "next";

import {
  LegalDocumentPage,
  legalMetadata,
} from "@/components/legal-document-page";

export const dynamic = "force-dynamic";

export function generateMetadata(): Promise<Metadata> {
  return legalMetadata("privacy", "Privacy Policy");
}

export default function PrivacyPage() {
  return <LegalDocumentPage document="privacy" heading="Privacy Policy" />;
}
