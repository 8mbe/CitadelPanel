"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Castle, LogOut, Settings, ShieldCheck } from "lucide-react";

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
import { ModeToggle } from "@/components/mode-toggle";
import { AdminNav } from "@/components/admin/admin-nav";
import { SessionProvider, useSession } from "@/components/session-provider";
import { cn } from "@/lib/utils";

/**
 * The panel shell: a thin top bar and the page content below. Navigation is
 * driven by the pages themselves (server selection → server sections), not by
 * a persistent sidebar.
 *
 * Admin surfaces are role-gated here. This is presentation only — every
 * `/api/admin/*` route re-checks the role server-side, so hiding the links is
 * about not showing users doors they cannot open, not about security.
 */
function PanelShell({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const isAdmin = user.role === "admin";
  const inAdmin = pathname.startsWith("/admin");

  // End the session server-side, then drop the cached client session and send
  // the browser to sign in. A full navigation (not router.replace) clears any
  // in-memory state that assumed a signed-in user.
  const signOut = async () => {
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Network failure is not fatal — head to login regardless.
    }
    window.location.href = "/login";
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 md:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Castle className="size-4" />
            </span>
            <span className="font-heading text-sm font-semibold tracking-tight">
              CitadelPanel
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

          <div className="ml-auto flex items-center gap-1">
            <ModeToggle />
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
                      <span className="text-xs font-normal text-muted-foreground">
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
    </div>
  );
}

export default function PanelLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <SessionProvider>
      <PanelShell>{children}</PanelShell>
    </SessionProvider>
  );
}
