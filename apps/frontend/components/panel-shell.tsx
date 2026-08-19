"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { LogOut, Menu, Server, Settings, ShieldCheck } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import { ADMIN_SECTIONS, AdminNav } from "@/components/admin/admin-nav";
import { useBranding } from "@/components/branding-provider";
import { SiteFooter, type LegalAvailability } from "@/components/site-footer";
import { useSession } from "@/components/session-provider";
import { cn } from "@/lib/utils";

/**
 * The panel shell: a thin top bar and the page content below. Navigation is
 * driven by the pages themselves (server selection → server sections), not by
 * a persistent sidebar.
 *
 * The brand is text only, and the text comes from the operator's `branding`
 * setting — there is no product glyph beside it, because a fixed icon next to a
 * renameable name reads as someone else's logo on a panel the operator has
 * branded as their own.
 *
 * Admin surfaces are role-gated here. This is presentation only — every
 * `/api/admin/*` route re-checks the role server-side, so hiding the links is
 * about not showing users doors they cannot open, not about security.
 */
export function PanelShell({
  legal,
  children,
}: {
  legal: LegalAvailability;
  children: React.ReactNode;
}) {
  const { user } = useSession();
  const { siteName } = useBranding();
  const router = useRouter();
  const pathname = usePathname();
  const isAdmin = user.role === "admin";
  const inAdmin = pathname.startsWith("/admin");

  // End the session server-side, then drop the cached client session and send
  // the browser to sign in. A full navigation (not router.replace) clears any
  // in-memory state that assumed a signed-in user.
  const signOut = async () => {
    try {
      // Better Auth's /sign-out parses the body as JSON, so an empty body is a
      // 400 before the cookie-clearing handler ever runs — send an empty object.
      await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      // Network failure is not fatal — head to login regardless.
    }
    window.location.href = "/login";
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-3 sm:gap-3 sm:px-4 md:px-6">
          {/* The section switcher collapses into a sheet below `md`, where the
              two inline buttons plus a long site name would not fit. Only admins
              have sections to switch between, so only they get the trigger. */}
          {isAdmin && <MobileNav inAdmin={inAdmin} pendingReviews={user.pendingReviews} />}

          <Link
            href="/"
            className="flex min-w-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate font-heading text-sm font-semibold tracking-tight">
              {siteName}
            </span>
          </Link>

          {isAdmin && (
            <nav
              aria-label="Sections"
              className="hidden items-center gap-1 md:flex"
            >
              <Button
                variant="ghost"
                size="sm"
                render={<Link href="/" />}
                nativeButton={false}
                className={cn(!inAdmin && "bg-muted text-foreground")}
              >
                My servers
              </Button>
              <Button
                variant="ghost"
                size="sm"
                render={<Link href="/admin/servers" />}
                nativeButton={false}
                className={cn(inAdmin && "bg-muted text-foreground")}
              >
                <ShieldCheck data-icon="inline-start" />
                Admin
                {user.pendingReviews ? (
                  <Badge
                    variant="secondary"
                    className="ml-1 h-4 min-w-4 px-1 text-[10px] tabular-nums"
                  >
                    {user.pendingReviews}
                  </Badge>
                ) : null}
              </Button>
            </nav>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="rounded-full"
                    aria-label="User menu"
                  />
                }
              >
                <Avatar className="size-7">
                  <AvatarFallback className="bg-muted text-xs">
                    {user.avatarSeed}
                  </AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{user.name}</span>
                      <span className="truncate text-xs font-normal text-muted-foreground">
                        {user.email}
                      </span>
                      {isAdmin && (
                        <span className="mt-1 text-[10px] font-normal tracking-wide text-muted-foreground uppercase">
                          Administrator
                        </span>
                      )}
                    </div>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => router.push("/settings")}>
                  <Settings />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={signOut}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Admin sub-navigation, only while inside /admin. */}
        {isAdmin && inAdmin && <AdminNav />}
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 md:px-6">
        {children}
      </main>

      <SiteFooter legal={legal} siteName={siteName} />
    </div>
  );
}

/**
 * The small-screen section switcher.
 *
 * Lists the same destinations as the desktop nav plus the admin sub-sections, so
 * a phone can reach every admin page in one tap rather than none — the desktop
 * nav is `hidden md:flex`, and before this existed there was no route to `/admin`
 * on a narrow viewport at all.
 */
function MobileNav({
  inAdmin,
  pendingReviews,
}: {
  inAdmin: boolean;
  pendingReviews?: number;
}) {
  const pathname = usePathname();

  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="-ml-1 md:hidden"
            aria-label="Open navigation"
          />
        }
      >
        <Menu />
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0">
        <SheetHeader>
          <SheetTitle>Navigation</SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-0.5 overflow-y-auto p-2">
          <SheetClose
            render={
              <Link
                href="/"
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  inAdmin
                    ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                    : "bg-muted text-foreground",
                )}
              />
            }
          >
            <Server className="size-4" />
            My servers
          </SheetClose>

          <p className="mt-3 px-3 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Admin
          </p>
          {ADMIN_SECTIONS.map((section) => {
            const active = pathname.startsWith(section.href);
            const showCount =
              section.href === "/admin/security" && !!pendingReviews;
            return (
              <SheetClose
                key={section.href}
                render={
                  <Link
                    href={section.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  />
                }
              >
                <section.icon className="size-4" />
                {section.label}
                {showCount && (
                  <Badge
                    variant="destructive"
                    className="ml-auto h-4 min-w-4 px-1 text-[10px] tabular-nums"
                  >
                    {pendingReviews}
                  </Badge>
                )}
              </SheetClose>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
