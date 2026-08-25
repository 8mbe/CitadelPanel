"use client";

import * as React from "react";
import {
  Ban,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  User as UserIcon,
  UserPlus,
} from "lucide-react";
import Link from "next/link";

import { AddUserDialog } from "@/components/admin/add-user-dialog";
import { DeleteUserDialog } from "@/components/admin/delete-user-dialog";
import { useSession } from "@/components/session-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  adminBanUser,
  adminListUsers,
  adminUnbanUser,
  adminUpdateUserRole,
  ApiError,
  type ApiUser,
} from "@/lib/api";
import { formatRelative } from "@/lib/format";

/**
 * Admin user directory: searchable account list with role management and
 * ban/unban. Banning a user signs them out everywhere (session revocation) and
 * suspends all their servers; the user sees the ban reason + remaining duration
 * when they next try to sign in.
 */
export default function AdminUsersPage() {
  const { user: me } = useSession();
  const [users, setUsers] = React.useState<ApiUser[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  // Bumped after any mutation to reload the (possibly filtered) list.
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [addOpen, setAddOpen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const apiUsers = await adminListUsers(query);
        if (!cancelled) setUsers(apiUsers);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load accounts.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, refreshKey]);

  const reload = () => setRefreshKey((k) => k + 1);

  const handleRoleChange = async (userId: string, newRole: "admin" | "user") => {
    try {
      await adminUpdateUserRole(userId, newRole);
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)),
      );
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Failed to update role.");
    }
  };

  const admins = users.filter((u) => u.role === "admin").length;
  const banned = users.filter((u) => u.banned).length;

  return (
    <>
      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            Users
          </h1>
          <p className="text-sm text-muted-foreground">
            {loading
              ? "Loading accounts…"
              : error
                ? error
                : query
                  ? `${users.length} match for “${query}”. ${admins} admin, ${banned} banned.`
                  : `${users.length} accounts on the panel. ${admins} with administrator privileges, ${banned} banned.`}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative w-full md:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search email or name…"
              className="pl-8"
              aria-label="Search users"
            />
          </div>
          <Button onClick={() => setAddOpen(true)}>
            <UserPlus />
            Add user
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Servers</TableHead>
                <TableHead className="text-right">Joined</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Skeleton className="h-9 w-48" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-5 w-8" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-5 w-20" />
                    </TableCell>
                    <TableCell className="w-10" />
                  </TableRow>
                ))
              ) : users.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-32 text-center text-sm text-muted-foreground"
                  >
                    {query ? "No accounts match your search." : "No accounts found."}
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <Link
                          href={`/admin/users/${user.id}`}
                          className="font-medium text-foreground underline-offset-4 hover:underline"
                        >
                          {user.name}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {user.email}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {user.role === "admin" ? (
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
                    </TableCell>
                    <TableCell>
                      {user.banned ? (
                        <div className="flex flex-col gap-0.5">
                          <Badge variant="destructive" className="w-fit gap-1">
                            <Ban className="size-3" />
                            Banned
                          </Badge>
                          {user.banReason && (
                            <span className="text-xs text-muted-foreground line-clamp-1 max-w-[16rem]">
                              {user.banReason}
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {user.banExpires
                              ? `expires ${formatRelative(user.banExpires)}`
                              : "permanent"}
                          </span>
                        </div>
                      ) : (
                        <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">
                          Active
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {user.serverCount}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {user.createdAt ? formatRelative(user.createdAt) : "Unknown"}
                    </TableCell>
                    <TableCell>
                      <UserActions
                        user={user}
                        isSelf={user.id === me.id}
                        onRoleChange={handleRoleChange}
                        onChanged={reload}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AddUserDialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          // Closing is when the new account joins the list, whether the admin
          // dismissed the credentials panel or cancelled outright.
          if (!open) reload();
        }}
      />
    </>
  );
}

function UserActions({
  user,
  isSelf,
  onRoleChange,
  onChanged,
}: {
  user: ApiUser;
  isSelf: boolean;
  onRoleChange: (userId: string, role: "admin" | "user") => void | Promise<void>;
  /** Reload the list: a ban, unban or deletion changes rows we do not patch. */
  onChanged: () => void | Promise<void>;
}) {
  const [banOpen, setBanOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  // Deletion is gated server-side on the same two facts; repeated here only to
  // say *why* the item is unavailable, which a disabled row otherwise leaves
  // the admin guessing at.
  const blocker = isSelf
    ? "Use your account settings"
    : !user.banned
      ? "Ban the account first"
      : user.serverCount > 0
        ? `Owns ${user.serverCount} server${user.serverCount === 1 ? "" : "s"}`
        : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Manage ${user.name}`}
            />
          }
        >
          •••
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {user.role === "admin" ? (
            <DropdownMenuItem
              disabled={isSelf}
              onClick={() => onRoleChange(user.id, "user")}
            >
              <ShieldCheck />
              Demote to user
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => onRoleChange(user.id, "admin")}>
              <Shield />
              Promote to admin
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {user.banned ? (
            <UnbanItem userId={user.id} onDone={onChanged} />
          ) : (
            <DropdownMenuItem
              disabled={isSelf}
              onClick={() => setBanOpen(true)}
            >
              <Ban />
              Ban user…
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={blocker !== null}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 />
            <span className="flex flex-col">
              Delete account…
              {blocker && (
                <span className="text-xs text-muted-foreground">{blocker}</span>
              )}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <BanDialog
        user={user}
        open={banOpen}
        onOpenChange={setBanOpen}
        onDone={onChanged}
      />

      <DeleteUserDialog
        user={user}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={onChanged}
      />
    </>
  );
}

function UnbanItem({
  userId,
  onDone,
}: {
  userId: string;
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <DropdownMenuItem
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await adminUnbanUser(userId);
          await onDone();
        } catch (err) {
          alert(err instanceof ApiError ? err.message : "Failed to unban user.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <ShieldCheck />
      Unban user
    </DropdownMenuItem>
  );
}

/**
 * Ban confirmation dialog: free-form reason + duration.
 *
 * Duration is offered as presets (Never / 1h / 1d / 1w) plus the backend also
 * accepts a raw seconds value; the presets cover the common cases cleanly. On
 * ban, the user's sessions are revoked and their servers suspended, and the
 * copy makes that explicit.
 */
function BanDialog({
  user,
  open,
  onOpenChange,
  onDone,
}: {
  user: ApiUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void | Promise<void>;
}) {
  const [reason, setReason] = React.useState("");
  const [duration, setDuration] = React.useState<"never" | "1h" | "1d" | "1w">("never");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const DURATION_SECONDS: Record<typeof duration, number | undefined> = {
    never: undefined,
    "1h": 60 * 60,
    "1d": 60 * 60 * 24,
    "1w": 60 * 60 * 24 * 7,
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await adminBanUser(user.id, {
        reason: reason.trim() || undefined,
        banExpiresInSeconds: DURATION_SECONDS[duration],
      });
      setReason("");
      setDuration("never");
      onOpenChange(false);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to ban user.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="size-5 text-destructive" />
            Ban {user.name}
          </DialogTitle>
          <DialogDescription>
            The user will be signed out everywhere and cannot sign back in. All
            of their servers will be suspended.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="ban-reason">Reason (optional)</FieldLabel>
            <Input
              id="ban-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Abuse of service"
              maxLength={500}
            />
            <FieldDescription>
              Shown to the user when they try to sign in.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Duration</FieldLabel>
            <Select
              value={duration}
              onValueChange={(v) => {
                if (v === "never" || v === "1h" || v === "1d" || v === "1w") {
                  setDuration(v);
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never">Permanent</SelectItem>
                <SelectItem value="1h">1 hour</SelectItem>
                <SelectItem value="1d">1 day</SelectItem>
                <SelectItem value="1w">1 week</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={submitting}>
            {submitting && <Spinner />}
            Ban user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
