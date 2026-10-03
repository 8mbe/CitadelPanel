"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
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
import { Button } from "@/components/ui/button";
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
 * The section switcher for a server page. Horizontal underline tabs, one route
 * per section so each has its own URL. When they don't fit they scroll
 * sideways inside {@link TabStrip}.
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
    <TabStrip label="Server sections" activeKey={pathname}>
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
    </TabStrip>
  );
}

/** Space the edge fades cover, so a tab scrolled "into view" isn't under one. */
const EDGE_FADE_PX = 48;

/**
 * A horizontally scrolling row of tabs. The scrollbar is hidden, so the
 * overflow needs another way in for a mouse: a vertical wheel over the strip
 * scrolls it sideways (until an end, then the page scrolls as usual), and a
 * chevron over a faded edge appears whenever there is more in that direction.
 * The active tab is scrolled into view whenever `activeKey` changes, so a deep
 * link to the last section doesn't land with its tab hidden.
 */
function TabStrip({
  label,
  activeKey,
  children,
}: {
  label: string;
  activeKey: string;
  children: React.ReactNode;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [canScroll, setCanScroll] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const left = nav.scrollLeft > 1;
    const right = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1;
    setCanScroll((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(nav);
    const mutation = new MutationObserver(measure);
    mutation.observe(nav, { childList: true, subtree: true });

    // React's onWheel is passive, so preventDefault only works from a native
    // listener.
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const max = nav.scrollWidth - nav.clientWidth;
      const atEnd =
        event.deltaY < 0 ? nav.scrollLeft <= 0 : nav.scrollLeft >= max - 1;
      if (max <= 0 || atEnd) return;
      event.preventDefault();
      nav.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : 1);
    };
    nav.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      resize.disconnect();
      mutation.disconnect();
      nav.removeEventListener("wheel", onWheel);
    };
  }, [measure]);

  useEffect(() => {
    const nav = navRef.current;
    const tab = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !tab) return;
    const navBox = nav.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    if (tabBox.left < navBox.left + EDGE_FADE_PX) {
      nav.scrollBy({ left: tabBox.left - navBox.left - EDGE_FADE_PX });
    } else if (tabBox.right > navBox.right - EDGE_FADE_PX) {
      nav.scrollBy({ left: tabBox.right - navBox.right + EDGE_FADE_PX });
    }
  }, [activeKey]);

  const page = (direction: -1 | 1) => {
    const nav = navRef.current;
    if (!nav) return;
    nav.scrollBy({
      left: direction * nav.clientWidth * 0.6,
      behavior: "smooth",
    });
  };

  return (
    <div data-slot="tab-strip" className="relative -mx-4 md:mx-0">
      <nav
        ref={navRef}
        aria-label={label}
        onScroll={measure}
        className="flex gap-1 overflow-x-auto border-b px-4 [scrollbar-width:none] md:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </nav>
      {canScroll.left && (
        <div className="pointer-events-none absolute top-0 bottom-px left-0 flex items-center bg-linear-to-r from-background from-50% to-transparent pr-6">
          <Button
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            aria-label="Scroll sections left"
            className="pointer-events-auto"
            onClick={() => page(-1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
        </div>
      )}
      {canScroll.right && (
        <div className="pointer-events-none absolute top-0 right-0 bottom-px flex items-center bg-linear-to-l from-background from-50% to-transparent pl-6">
          <Button
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            aria-label="Scroll sections right"
            className="pointer-events-auto"
            onClick={() => page(1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
