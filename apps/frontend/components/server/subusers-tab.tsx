"use client";

import * as React from "react";
import { Trash2, UserPlus } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, inviteSubuser, listSubusers, removeSubuser } from "@/lib/api";
import { initials } from "@/lib/format";
import type { SubuserView } from "@/lib/types";

/**
 * Subuser permissions the backend understands (auth/rbac.SUBUSER_PERMISSIONS).
 * The invite form sends a flag map keyed by these.
 */
const PERMISSION_OPTIONS = [
  { key: "console", label: "Console access" },
  { key: "start_stop", label: "Start / stop" },
  { key: "files", label: "File manager" },
  { key: "settings", label: "Edit settings" },
  { key: "backups", label: "Backups" },
  { key: "database", label: "Database" },
];

export function SubusersTab({ serverId }: { serverId: string }) {
  const [subusers, setSubusers] = React.useState<SubuserView[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Bumped after an invite to reload without a synchronous setState in an effect.
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listSubusers(serverId);
        if (cancelled) return;
        setSubusers(list);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        // 403 here means the caller is not owner/admin — subuser management is
        // owner-only, so present that as an empty, non-actionable state.
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          setSubusers([]);
        } else {
          setError(
            err instanceof ApiError ? err.message : "Failed to load subusers.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, refreshKey]);

  const remove = async (userId: string) => {
    try {
      await removeSubuser(serverId, userId);
      setSubusers((prev) => prev.filter((s) => s.userId !== userId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove subuser.");
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Users with scoped access to this server.
        </p>
        <InviteDialog
          serverId={serverId}
          onInvited={() => setRefreshKey((k) => k + 1)}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {subusers.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No subusers</EmptyTitle>
            <EmptyDescription>
              Invite trusted players to help manage this server. They need an
              existing account on the panel.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>User</TableHead>
              <TableHead>Permissions</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {subusers.map((sub) => (
              <TableRow key={sub.userId}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar className="size-8">
                      <AvatarFallback className="text-xs">
                        {initials(sub.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{sub.name}</p>
                      <p className="text-xs text-muted-foreground">{sub.email}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex max-w-md flex-wrap gap-1">
                    {sub.permissions.map((p) => (
                      <Badge key={p} variant="secondary" className="font-mono text-[10px]">
                        {p}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${sub.name}`}
                    onClick={() => remove(sub.userId)}
                  >
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function InviteDialog({
  serverId,
  onInvited,
}: {
  serverId: string;
  onInvited: () => void | Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [perms, setPerms] = React.useState<string[]>(["console"]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const togglePerm = (key: string) =>
    setPerms((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
    );

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || perms.length === 0) return;

    setSubmitting(true);
    setError(null);
    try {
      // The backend takes a flag map, not a list.
      const map = Object.fromEntries(perms.map((key) => [key, true]));
      await inviteSubuser(serverId, email.trim(), map);
      setOpen(false);
      setEmail("");
      setPerms(["console"]);
      await onInvited();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to send invite.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <UserPlus />
        Invite subuser
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite subuser</DialogTitle>
          <DialogDescription>
            The user must already have an account on the panel.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={invite} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="subuser-email">Email address</FieldLabel>
            <Input
              id="subuser-email"
              type="email"
              required
              placeholder="player@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Permissions</FieldLabel>
            <FieldDescription>Scope what this user can do.</FieldDescription>
            <div className="grid grid-cols-2 gap-2">
              {PERMISSION_OPTIONS.map((perm) => (
                <label
                  key={perm.key}
                  className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted/50"
                >
                  <Checkbox
                    checked={perms.includes(perm.key)}
                    onCheckedChange={() => togglePerm(perm.key)}
                  />
                  {perm.label}
                </label>
              ))}
            </div>
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={perms.length === 0 || submitting}>
              {submitting && <Spinner />}
              Send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
