import type { Metadata } from "next";

export const metadata: Metadata = { title: "Blueprints" };

export default function BlueprintsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
