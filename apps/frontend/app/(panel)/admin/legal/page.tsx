import type { Metadata } from "next";

import { AdminLegalEditor } from "@/components/admin/legal-editor";

export const metadata: Metadata = { title: "Legal documents" };

/**
 * Admin legal documents: the terms of service and privacy policy an operator
 * writes for their own install, published at `/terms` and `/privacy`.
 *
 * Its own page rather than a card in general settings. See the note in
 * `components/admin/legal-editor.tsx`.
 */
export default function AdminLegalPage() {
  return <AdminLegalEditor />;
}
