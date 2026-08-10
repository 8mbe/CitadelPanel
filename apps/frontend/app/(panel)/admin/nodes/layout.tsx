import type { Metadata } from "next";

export const metadata: Metadata = { title: "Nodes" };

export default function NodesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
