"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  Ban as BanIcon,
  Shield,
  ShieldCheck,
  User as UserIcon,
} from "lucide-react";

import { useSession } from "@/components/session-provider";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  adminGetUser,
  adminUnbanUser,
  adminUpdateUserRole,
  ApiError,
  type AdminUserDetail,
} from "@/lib/api";
import { formatMb, formatRelative } from "@/lib/format";
import type { ServerStatus } from "@/lib/types";

/**
 * Admin user detail page.
 *
 * Surfaces a single account's profile and the servers it owns. Role and ban
 * actions are available inline (reusing the admin user-management API), so an
 * admin can act on an account reached from the audit log or the user list
 * without bouncing back to the list.
 */

export default function AdminUserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { user: me } = useSession();

  const [detail, setDetail] = React.useState<AdminUserDetail | null>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "missing">(
    "loading",
  );

  const reload = React.useCallback(async () => {
    try {
      const result = await adminGetUser(id);
      setDetail(result);
      setState("ready");
    } catch {
      setState("missing");
    }
  }, [id]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await adminGetUser(id);
        if (cancelled) return;
        setDetail(result);
        setState("ready");
      } catch {
        if (cancelled) return;
        setState("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state === "loading") {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (state === "missing" || !detail) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <Empty className="max-w-sm">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UserIcon />
            </EmptyMedia>
            <EmptyTitle>User not found</EmptyTitle>
            <EmptyDescription>
              The account you&apos;re looking for doesn&apos;t exist or was removed.
            </EmptyDescription>
          </EmptyHeader>
          <Button render={<Link href="/admin/users" />} nativeButton={false}>
            Back to users
          </Button>
        </Empty>
      </div>
    );
  }

  const isSelf = detail.id === me.id;

  return (
    <div className="flex flex-col gap-6">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        render={<Link href="/admin/users" />}
        nativeButton={false}
      >
        <ArrowLeft />
        Back to users
      </Button>

      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            {detail.name ?? detail.email}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{detail.email}</span>
            {detail.role === "admin" ? (
              <Badge variant="secondary" className="gap-1">
                <Shield className="size-3" />
                Admin
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1">
                <UserIcon className="size-3" />
                User
              </Badge>
            )}
            {detail.banned ? (
              <Badge variant="destructive" className="gap-1">
                <BanIcon className="size-3" />
                Banned
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="text-emerald-600 dark:text-emerald-400"
              >
                Active
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {detail.createdAt && (
              <span>Joined {formatRelative(detail.createdAt)}</span>
            )}
            <span>
              {detail.servers.length} server
              {detail.servers.length === 1 ? "" : "s"}
            </span>
            {detail.banned && detail.banReason && (
              <span className="text-destructive">Reason: {detail.banReason}</span>
            )}
            {detail.banned && detail.banExpires && (
              <span>expires {formatRelative(detail.banExpires)}</span>
            )}
            {detail.banned && !detail.banExpires && (
              <span>permanent ban</span>
            )}
          </div>
        </div>

        <UserActions
          user={detail}
          isSelf={isSelf}
          onChanged={reload}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {detail.servers.length === 0 ? (
            <Empty className="min-h-[12rem] rounded-b-xl">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UserIcon />
                </EmptyMedia>
                <EmptyTitle>No servers</EmptyTitle>
                <EmptyDescription>
                  This account doesn&apos;t own any servers.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Server</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Resources</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.servers.map((server) => (
                  <TableRow key={server.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <Link
                          href={`/servers/${server.id}`}
                          className="font-medium text-foreground underline-offset-4 hover:underline"
                        >
                          {server.name}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {server.blueprintKey ?? "unknown"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={server.status as ServerStatus} />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatMb(server.memoryLimitMb)} ·{" "}
                      {formatMb(server.diskLimitMb)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatRelative(server.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Open ${server.name}`}
                        render={<Link href={`/servers/${server.id}`} />}
                        nativeButton={false}
                      >
                        <ArrowUpRight />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Inline role/unban actions for a user. Role changes and unbans are reversible,
 * so they fire directly from this page; banning is destructive (it signs the
 * user out everywhere and suspends their servers) and needs the reason/duration
 * dialog that lives on the users list, so "Ban user" links there rather than
 * acting without confirmation. A self-account disables role change and ban to
 * prevent self-lockout, matching the list page's guards.
 */
function UserActions({
  user,
  isSelf,
  onChanged,
}: {
  user: AdminUserDetail;
  isSelf: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={`Manage ${user.name ?? user.email}`}
            />
          }
        >
          Manage
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {user.role === "admin" ? (
            <DropdownMenuItem
              disabled={isSelf}
              onClick={() => run(() => adminUpdateUserRole(user.id, "user"))}
            >
              <ShieldCheck />
              Demote to user
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() => run(() => adminUpdateUserRole(user.id, "admin"))}
            >
              <Shield />
              Promote to admin
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {user.banned ? (
            <DropdownMenuItem
              onClick={() => run(() => adminUnbanUser(user.id))}
            >
              <ShieldCheck />
              Unban user
            </DropdownMenuItem>
          ) : (
            // Ban needs a reason + duration (the dialog on the users list), so
            // send the admin there rather than banning with no confirmation.
            <DropdownMenuItem
              disabled={isSelf}
              render={<Link href="/admin/users" />}
              nativeButton={false}
            >
              <BanIcon />
              Ban user…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
