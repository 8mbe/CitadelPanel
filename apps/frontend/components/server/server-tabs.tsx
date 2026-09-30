"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  CalendarClock,
  Database,
  FolderOpen,
  History,
  Network,
  Puzzle,
  Settings2,
  Terminal,
  UserCog,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { sectionAllowed, type ServerSectionKey } from "@/lib/permissions";
import { useServerData } from "@/components/server/server-data-context";

export const SERVER_SECTIONS = [
  { key: "console", label: "Console", icon: Terminal },
  { key: "files", label: "Files", icon: FolderOpen },
  { key: "plugins", label: "Plugins", icon: Puzzle },
  { key: "database", label: "Database", icon: Database },
  { key: "backups", label: "Backups", icon: Archive },
  { key: "schedules", label: "Schedules", icon: CalendarClock },
  { key: "ports", label: "Ports", icon: Network },
  { key: "subusers", label: "Subusers", icon: UserCog },
  { key: "settings", label: "Settings", icon: Settings2 },
  { key: "activity", label: "Activity", icon: History },
] as const satisfies readonly {
  key: ServerSectionKey;
  label: string;
  icon: LucideIcon;
}[];

export type { ServerSectionKey };

/** Which section the current server-page route belongs to. */
export function sectionFromPathname(pathname: string): ServerSectionKey {
  const segment = pathname.split("/").filter(Boolean)[2];
  const match = SERVER_SECTIONS.find((s) => s.key === segment);
  return match?.key ?? "console";
}

/**
 * The section switcher for a server page. Horizontal underline tabs that
 * scroll sideways on narrow screens; one route per section so each has its own
 * URL.
 *
 * Two things hide a section: the viewer lacking its permission (a console-only
 * subuser sees Console and Activity and nothing else), and the blueprint not
 * supporting it. Each content tab must resolve for the current configuration;
 * vanilla Java still gets Datapacks while Paper also gets Plugins. Labels and
 * tab identities come from the blueprint. The backend enforces the same rules
 * per route, so this is
 * presentation, not the security boundary.
 */
export function ServerTabs({ serverId }: { serverId: string }) {
  const pathname = usePathname();
  const active = sectionFromPathname(pathname);
  const { server } = useServerData();
  const contentTabs = server.pluginSupport?.tabs ?? [];
  const sections = SERVER_SECTIONS.flatMap((section) =>
    section.key === "plugins"
      ? contentTabs.map((tab) => ({
          key: `plugins/${tab.id}`,
          label: tab.label,
          icon: Puzzle,
          permission: "plugins" as ServerSectionKey,
          href: `/servers/${serverId}/plugins${tab.id === "plugins" ? "" : `/${tab.id}`}`,
        }))
      : [
          {
            ...section,
            permission: section.key as ServerSectionKey,
            href: `/servers/${serverId}/${section.key}`,
          },
        ],
  );
  const currentTab =
    pathname.split("/").filter(Boolean)[3] ?? contentTabs[0]?.id;

  return (
    <nav
      aria-label="Server sections"
      className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden"
    >
      {sections
        .filter((section) => sectionAllowed(section.permission, server.viewer))
        .map((section) => {
          const href = section.href;
          const isActive =
            section.permission === "plugins"
              ? active === "plugins" && section.key === `plugins/${currentTab}`
              : active === section.key;
          const label = section.label;
          return (
            <Link
              key={section.key}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <section.icon className="size-4" />
              {label}
            </Link>
          );
        })}
    </nav>
  );
}
