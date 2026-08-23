"use client";

import * as React from "react";
import { Network, Plus, Trash2 } from "lucide-react";

import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useServerData } from "@/components/server/server-data-context";
import { useSession } from "@/components/session-provider";
import {
  ApiError,
  createServerLink,
  getServerLinks,
  listServers,
  removeServerLink,
  type ServerLink,
} from "@/lib/api";
import type { ServerView } from "@/lib/types";

/**
 * The "Connected servers" card in the Settings tab.
 *
 * A link is an explicit connection between two of the owner's servers. It is
 * what a proxy needs to reach its backends, or a plugin to reach another
 * server. The address shown is stable by construction: same-node links use the
 * peer's container name on a private pairwise Docker network (`citadel-<id>`,
 * resolved by Docker's DNS, never an IP, which changes on every recreate);
 * cross-node links use the peer node's public hostname and port.
 *
 * Reads need the `settings` permission (same as ports); creating and removing
 * links is owner/admin-only because a link attaches the *target's* container to
 * a shared network. The API enforces that, the card only hides the controls.
 */
export function ConnectedServersCard() {
  const { server } = useServerData();
  const { user } = useSession();

  const [links, setLinks] = React.useState<ServerLink[] | null>(null);
  const [denied, setDenied] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [removingId, setRemovingId] = React.useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const canManage =
    server.viewer?.kind === "owner" || server.viewer?.kind === "admin";

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLinks(await getServerLinks(server.id));
    } catch (err) {
      // 403 means the caller lacks `settings`, so hide the card rather than
      // show an error, matching the environment card.
      if (err instanceof ApiError && err.status === 403) {
        setDenied(true);
      } else {
        setError(
          err instanceof ApiError ? err.message : "Failed to load connections.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const remove = async (link: ServerLink) => {
    setRemovingId(link.id);
    setError(null);
    try {
      await removeServerLink(server.id, link.id);
      setLinks((prev) => (prev ?? []).filter((l) => l.id !== link.id));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to remove connection.",
      );
    } finally {
      setRemovingId(null);
    }
  };

  if (denied) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="size-4 text-muted-foreground" />
          Connected servers
        </CardTitle>
        <CardDescription>
          Connect this server to your other servers and use the address shown
          in place of a public IP. Same-node connections run over a private
          network and survive restarts.
        </CardDescription>
        {canManage && (
          <CardAction>
            <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
              <Plus />
              Connect servers
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Spinner />
          </div>
        ) : links === null ? (
          <p className="py-4 text-sm text-destructive">{error}</p>
        ) : links.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No other servers connected yet.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {links.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                canManage={canManage}
                busy={removingId === link.id}
                onRemove={() => void remove(link)}
              />
            ))}
          </div>
        )}
        {error && links !== null && (
          <p className="pt-3 text-sm text-destructive">{error}</p>
        )}
      </CardContent>
      {canManage && (
        <ConnectServersDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onConnected={load}
        />
      )}
    </Card>
  );
}

/** One connected peer: name, mode badge, copyable address, remove control. */
function LinkRow({
  link,
  canManage,
  busy,
  onRemove,
}: {
  link: ServerLink;
  canManage: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const address = link.port !== null ? `${link.host}:${link.port}` : link.host;

  return (
    <div className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {link.target.name}
          </span>
          <Badge variant={link.mode === "internal" ? "secondary" : "outline"}>
            {link.mode === "internal" ? "Internal" : "Cross-node"}
          </Badge>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 truncate font-mono text-xs">
            {address}
          </code>
          <CopyButton value={address} label="connection address" size="icon-xs" />
        </div>
      </div>
      {canManage && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Disconnect ${link.target.name}`}
          disabled={busy}
          onClick={onRemove}
        >
          {busy ? <Spinner /> : <Trash2 />}
        </Button>
      )}
    </div>
  );
}

/**
 * The "Connect servers" dialog.
 *
 * Lists the caller's other servers (owned or administered, since a link needs
 * owner access to both sides), lets them pick which published port to use, and
 * previews the address before connecting. Same-node peers show the internal
 * container hostname; cross-node peers show the peer node's public address.
 */
function ConnectServersDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => Promise<void>;
}) {
  const { server } = useServerData();
  const { user } = useSession();

  const [candidates, setCandidates] = React.useState<ServerLinkCandidate[] | null>(null);
  const [targetId, setTargetId] = React.useState<string>("");
  const [port, setPort] = React.useState<number | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Load the candidate list once, when the dialog is first opened. Listing
  // servers on every render of the settings tab would be wasted work.
  React.useEffect(() => {
    if (!open || candidates !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const servers = await listServers();
        if (cancelled) return;
        setCandidates(
          servers.filter(
            (candidate) =>
              candidate.id !== server.id &&
              (candidate.ownerId === user.id || user.role === "admin"),
          ),
        );
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : "Failed to list servers.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, candidates, server.id, user.id, user.role]);

  const target = candidates?.find((candidate) => candidate.id === targetId) ?? null;
  const sameNode = target !== null && target.nodeId === server.nodeId;
  const selectedPort = port ?? target?.primaryPort ?? 0;

  const address =
    target === null
      ? null
      : sameNode
        ? `citadel-${target.id.slice(0, 12)}:${selectedPort}`
        : target.nodeHostname && selectedPort > 0
          ? `${target.nodeHostname}:${selectedPort}`
          : target.nodeHostname;

  // Reset the pick when the dialog reopens, so a previous selection never
  // leaks into the next session.
  React.useEffect(() => {
    if (open) {
      setTargetId("");
      setPort(null);
      setError(null);
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      await createServerLink(server.id, target.id);
      onOpenChange(false);
      await onConnected();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to connect server.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect servers</DialogTitle>
          <DialogDescription>
            Pick one of your servers to connect it to {server.name}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="link-server">Server</FieldLabel>
              {candidates === null ? (
                <div className="flex items-center justify-center py-4 text-muted-foreground">
                  <Spinner />
                </div>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  You have no other servers to connect.
                </p>
              ) : (
                <Select
                  value={targetId}
                  onValueChange={(value) => {
                    if (!value) return;
                    setTargetId(value);
                    // The port choice resets with the target; the primary port
                    // is the sensible default.
                    setPort(null);
                  }}
                >
                  <SelectTrigger id="link-server">
                    <SelectValue placeholder="Choose a server" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.name}
                        {candidate.nodeId === server.nodeId
                          ? " · same node"
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>

            {target && target.ports.length > 0 && (
              <Field>
                <FieldLabel htmlFor="link-port">Port</FieldLabel>
                <Select
                  value={String(selectedPort)}
                  onValueChange={(value) => {
                    if (value) setPort(Number(value));
                  }}
                >
                  <SelectTrigger id="link-port">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {target.ports.map((p) => (
                      <SelectItem key={p.port} value={String(p.port)}>
                        {p.port}
                        {p.isPrimary ? " · primary" : ""}
                        {p.label ? ` · ${p.label}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {sameNode
                    ? "Internal network address. Use it in place of a public IP in configs; it never changes."
                    : "Public address. The peer runs on another node, so traffic crosses the network."}
                </FieldDescription>
              </Field>
            )}

            {address && (
              <div className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-sm">
                  {address}
                </code>
                <CopyButton value={address} label="connection address" />
              </div>
            )}
          </FieldGroup>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!target || submitting}>
              {submitting && <Spinner />}
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A server eligible as a link target (one of the caller's own, minus this server). */
type ServerLinkCandidate = ServerView;
