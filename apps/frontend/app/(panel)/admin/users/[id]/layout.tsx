import type { Metadata } from "next";

export const metadata: Metadata = { title: "User" };

export default function UserDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
