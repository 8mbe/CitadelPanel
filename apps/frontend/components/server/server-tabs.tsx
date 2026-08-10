"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Database,
  FolderOpen,
  History,
  Network,
  Settings2,
  Terminal,
  UserCog,
  Users2,
} from "lucide-react";

import { cn } from "@/lib/utils";

export const SERVER_SECTIONS = [
  { key: "console", label: "Console", icon: Terminal },
  { key: "players", label: "Players", icon: Users2 },
  { key: "files", label: "Files", icon: FolderOpen },
  { key: "database", label: "Database", icon: Database },
  { key: "ports", label: "Ports", icon: Network },
  { key: "subusers", label: "Subusers", icon: UserCog },
  { key: "settings", label: "Settings", icon: Settings2 },
  { key: "activity", label: "Activity", icon: History },
] as const;

export type ServerSectionKey = (typeof SERVER_SECTIONS)[number]["key"];

/** Which section the current server-page route belongs to. */
export function sectionFromPathname(pathname: string): ServerSectionKey {
  const segment = pathname.split("/").filter(Boolean)[2];
  const match = SERVER_SECTIONS.find((s) => s.key === segment);
  return match?.key ?? "console";
}

/**
 * The section switcher for a server page. Horizontal underline tabs that
 * scroll sideways on narrow screens; one route per section so each has its
 * own URL.
 */
export function ServerTabs({ serverId }: { serverId: string }) {
  const pathname = usePathname();
  const active = sectionFromPathname(pathname);

  return (
    <nav
      aria-label="Server sections"
      className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden"
    >
      {SERVER_SECTIONS.map((section) => {
        const href = `/servers/${serverId}/${section.key}`;
        const isActive = active === section.key;
        return (
          <Link
            key={section.key}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <section.icon className="size-4" />
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
