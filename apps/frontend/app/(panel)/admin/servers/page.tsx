"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Ban,
  CircleCheck,
  Pencil,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { CreateServerDialog } from "@/components/admin/create-server-dialog";
import { EditResourcesDialog } from "@/components/admin/edit-resources-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
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
import { Textarea } from "@/components/ui/textarea";
import {
  adminListServers,
  adminSuspendServer,
  adminUnsuspendServer,
  ApiError,
  deleteServer,
  toServerView,
  type AdminServerSummary,
} from "@/lib/api";
import { formatMb } from "@/lib/format";
import type { ServerStatus } from "@/lib/types";

/**
 * Admin view of every server on the panel, across all users. This is also the
 * only place a server can be created: provisioning is an admin action.
 *
 * The listing comes from the backend and carries owner email plus a live CPU /
 * memory sample per server (null when the node is unreachable). Each row has a
 * management menu: edit resource limits, suspend/unsuspend, or delete.
 *
 * The search box matches a server's name or its owner's name/email, and is
 * resolved server-side: an admin looking for one customer's server should not
 * have to know which of the two they are typing. It is debounced because every
 * listing samples live usage from each node the matches live on.
 */
export default function AdminServersPage() {
  const [servers, setServers] = React.useState<AdminServerSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  // The query the rows on screen were fetched for. Comparing it to what is
  // typed derives "searching" without a setState in the effect body.
  const [loadedQuery, setLoadedQuery] = React.useState("");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [editTarget, setEditTarget] = React.useState<AdminServerSummary | null>(null);
  const [suspendTarget, setSuspendTarget] =
    React.useState<AdminServerSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<AdminServerSummary | null>(
    null,
  );

  const trimmed = query.trim();

  React.useEffect(() => {
    let cancelled = false;
    // Debounced: a listing costs one usage sample per node the matches sit on,
    // so it should not fire on every keystroke.
    const handle = setTimeout(async () => {
      try {
        const result = await adminListServers(trimmed || undefined);
        if (cancelled) return;
        setServers(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to load servers.");
      } finally {
        // Marks the attempt finished, success or not, so a failed search does
        // not leave the header stuck on "Searching…".
        if (!cancelled) {
          setLoading(false);
          setLoadedQuery(trimmed);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [trimmed, refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);
  const searching = !loading && trimmed !== loadedQuery;
  const running = servers.filter((s) => s.status === "running").length;

  return (
    <>
      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            Servers
          </h1>
          <p className="text-sm text-muted-foreground">
            {loading
              ? "Loading servers…"
              : searching
                ? "Searching…"
                : trimmed
                  ? `${servers.length} ${servers.length === 1 ? "server" : "servers"} match “${trimmed}”. ${running} running.`
                  : `Every server on the panel. ${running} of ${servers.length} running. Users cannot create servers themselves, so provision one for them here.`}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search server or owner…"
              className="pl-8"
              aria-label="Search servers by name, owner name or owner email"
            />
          </div>
          <CreateServerDialog onCreated={refresh} />
        </div>
      </div>

      {error ? (
        <Empty className="min-h-[16rem]">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlert />
            </EmptyMedia>
            <EmptyTitle>Couldn&apos;t load servers</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Server</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Resources</TableHead>
                  <TableHead className="text-right">CPU</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <Skeleton className="h-9 w-40" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-5 w-36" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-5 w-20" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="ml-auto h-5 w-24" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="ml-auto h-5 w-12" />
                      </TableCell>
                      <TableCell className="w-10" />
                    </TableRow>
                  ))
                ) : servers.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="h-32 text-center text-sm text-muted-foreground"
                    >
                      {trimmed
                        ? "No servers match your search."
                        : "No servers yet. Provision the first one with the button above."}
                    </TableCell>
                  </TableRow>
                ) : (
                  servers.map((server) => (
                    <TableRow key={server.id} className="group">
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{server.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {server.blueprintKey ?? "unknown"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {/* Name above email, because the search matches either
                            one and a name-match should be visible in the row. */}
                        {server.ownerName ? (
                          <div className="flex flex-col">
                            <span>{server.ownerName}</span>
                            <span className="text-xs text-muted-foreground">
                              {server.ownerEmail}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">
                            {server.ownerEmail}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={server.status as ServerStatus} />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {formatMb(server.memoryLimitMb)} ·{" "}
                        {formatMb(server.diskLimitMb)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {server.cpuPercent !== null
                          ? `${Math.round(server.cpuPercent)}%`
                          : "Unknown"}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Manage ${server.name}`}
                              />
                            }
                          >
                            •••
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              render={<Link href={`/servers/${server.id}`} />}
                              nativeButton={false}
                            >
                              <ArrowUpRight />
                              Open server
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setEditTarget(server)}>
                              <Pencil />
                              Edit resources
                            </DropdownMenuItem>
                            {server.status === "suspended" ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  void handleUnsuspend(server, refresh)
                                }
                              >
                                <CircleCheck />
                                Unsuspend
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onClick={() => setSuspendTarget(server)}
                              >
                                <Ban />
                                Suspend
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDeleteTarget(server)}
                            >
                              <Trash2 />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {editTarget && (
        <EditResourcesDialog
          server={toServerView(editTarget)}
          open
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
          onUpdated={() => {
            setEditTarget(null);
            refresh();
          }}
        />
      )}

      <SuspendServerDialog
        target={suspendTarget}
        onOpenChange={(open) => {
          if (!open) setSuspendTarget(null);
        }}
        onSuspended={() => {
          setSuspendTarget(null);
          refresh();
        }}
      />

      <DeleteServerDialog
        target={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleted={() => {
          setDeleteTarget(null);
          refresh();
        }}
      />
    </>
  );
}

/** Unsuspend inline from the row menu. No extra input needed. */
async function handleUnsuspend(
  server: AdminServerSummary,
  refresh: () => void,
): Promise<void> {
  try {
    await adminUnsuspendServer(server.id);
    refresh();
  } catch (err) {
    // Surface via the list refresh path; a hard failure is rare and the
    // status will simply stay "suspended".
    console.error(`Failed to unsuspend ${server.id}:`, err);
  }
}

/**
 * Read-only identity block shared by the suspend/delete dialogs: names the
 * server and its owner so the admin confirms they are acting on the right one.
 * The owner's display name is shown with their email in parentheses when set,
 * falling back to the bare email otherwise.
 */
function ServerIdentity({ target }: { target: AdminServerSummary }) {
  const owner =
    target.ownerName && target.ownerName.length > 0
      ? `${target.ownerName} (${target.ownerEmail})`
      : target.ownerEmail;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-muted/40 p-3 text-sm">
      <dt className="text-muted-foreground">Server</dt>
      <dd className="font-medium">{target.name}</dd>
      <dt className="text-muted-foreground">Owner</dt>
      <dd className="font-medium">{owner}</dd>
    </dl>
  );
}

/**
 * Confirm-and-suspend dialog. A reason is required and shown to the owner.
 * Mounted only while a target is set, so field state starts fresh each open.
 */
function SuspendServerDialog({
  target,
  onOpenChange,
  onSuspended,
}: {
  target: AdminServerSummary | null;
  onOpenChange: (open: boolean) => void;
  onSuspended: () => void;
}) {
  if (!target) return null;
  return (
    <SuspendServerForm
      target={target}
      onOpenChange={onOpenChange}
      onSuspended={onSuspended}
    />
  );
}

function SuspendServerForm({
  target,
  onOpenChange,
  onSuspended,
}: {
  target: AdminServerSummary;
  onOpenChange: (open: boolean) => void;
  onSuspended: () => void;
}) {
  const [reason, setReason] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const confirm = async () => {
    if (!reason.trim()) {
      setError("Give a reason. The owner sees it.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await adminSuspendServer(target.id, reason.trim());
      onSuspended();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to suspend server.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Suspend server</DialogTitle>
          <DialogDescription>
            {`Stop "${target.name}" and block the owner from starting it until unsuspended.`}
          </DialogDescription>
        </DialogHeader>
        <ServerIdentity target={target} />
        <Field>
          <FieldLabel htmlFor="suspend-reason">Reason</FieldLabel>
          <Textarea
            id="suspend-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Non-payment, abuse report, maintenance…"
            rows={3}
          />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting && <Spinner />}
            Suspend server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirm-and-delete dialog, with an opt-in to also wipe the data files.
 * Mounted only while a target is set, so field state starts fresh each open.
 */
function DeleteServerDialog({
  target,
  onOpenChange,
  onDeleted,
}: {
  target: AdminServerSummary | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  if (!target) return null;
  return (
    <DeleteServerForm
      target={target}
      onOpenChange={onOpenChange}
      onDeleted={onDeleted}
    />
  );
}

function DeleteServerForm({
  target,
  onOpenChange,
  onDeleted,
}: {
  target: AdminServerSummary;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [deleteData, setDeleteData] = React.useState(false);
  const [force, setForce] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Forcing is only offered once a delete has actually been refused by the node.
  // It is the answer to a node that is gone for good, not a checkbox to tick on
  // the way past a node that is merely restarting.
  const [canForce, setCanForce] = React.useState(false);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await deleteServer(target.id, deleteData, force);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete server.");
      setCanForce(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete server</DialogTitle>
          <DialogDescription>
            {`Permanently delete "${target.name}" and its container. This cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        <ServerIdentity target={target} />
        <Field orientation="horizontal">
          <Checkbox
            id="delete-data"
            checked={deleteData}
            onCheckedChange={(checked) => setDeleteData(checked === true)}
          />
          <FieldLabel htmlFor="delete-data" className="font-normal">
            Also delete the server&apos;s data files on the node
          </FieldLabel>
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {canForce && (
          <Field orientation="horizontal">
            <Checkbox
              id="delete-force"
              checked={force}
              onCheckedChange={(checked) => setForce(checked === true)}
            />
            <FieldLabel htmlFor="delete-force" className="font-normal">
              Force: delete the panel&apos;s record anyway, leaving the container
              and files on the node
            </FieldLabel>
          </Field>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting && <Spinner />}
            {force ? "Force delete" : "Delete server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
