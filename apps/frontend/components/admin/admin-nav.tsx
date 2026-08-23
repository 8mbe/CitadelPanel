"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  Blocks,
  ClipboardList,
  KeyRound,
  Scale,
  Server,
  Settings,
  ShieldAlert,
  Users,
  HardDrive,
} from "lucide-react";

import { useSession } from "@/components/session-provider";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const ADMIN_SECTIONS = [
  { href: "/admin/servers", label: "Servers", icon: Server },
  { href: "/admin/nodes", label: "Nodes", icon: HardDrive },
  { href: "/admin/blueprints", label: "Blueprints", icon: Blocks },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/api-keys", label: "API keys", icon: KeyRound },
  { href: "/admin/backups", label: "Backups", icon: Archive },
  { href: "/admin/security", label: "Security", icon: ShieldAlert },
  { href: "/admin/audit", label: "Audit log", icon: ClipboardList },
  { href: "/admin/legal", label: "Legal", icon: Scale },
  { href: "/admin/settings", label: "Settings", icon: Settings },
] as const;

/**
 * Sub-navigation for the admin area. Rendered by the panel shell only when the
 * caller is an admin and the current route is under `/admin`, so ordinary users
 * never see it.
 *
 * The security tab carries the unreviewed-flag count from `/api/me`, which is
 * the one number an admin wants without having to click through.
 */
export function AdminNav() {
  const pathname = usePathname();
  const { user } = useSession();

  return (
    <div className="border-t bg-muted/30">
      <nav
        aria-label="Admin sections"
        className="mx-auto flex w-full max-w-6xl gap-1 overflow-x-auto px-4 md:px-6 [&::-webkit-scrollbar]:hidden"
      >
        {ADMIN_SECTIONS.map((section) => {
          const active = pathname.startsWith(section.href);
          const showCount =
            section.href === "/admin/security" && !!user.pendingReviews;

          return (
            <Link
              key={section.href}
              href={section.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <section.icon className="size-4" />
              {section.label}
              {showCount && (
                <Badge
                  variant="destructive"
                  className="h-4 min-w-4 px-1 text-[10px] tabular-nums"
                >
                  {user.pendingReviews}
                </Badge>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
