import type { Metadata } from "next";

export const metadata: Metadata = { title: "Node" };

export default function NodeDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
