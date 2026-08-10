import type { Metadata } from "next";

export const metadata: Metadata = { title: "Servers" };

export default function ServersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
