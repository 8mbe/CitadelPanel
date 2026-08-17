"use client";

import * as React from "react";
import { Check, Copy, KeyRound, Plus, Search, Shield, User as UserIcon } from "lucide-react";

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
  adminCreateApiKey,
  adminDeleteApiKey,
  adminListApiKeys,
  adminSetApiKeyEnabled,
  ApiError,
  type AdminApiKeyView,
} from "@/lib/api";
import { formatRelative } from "@/lib/format";

/**
 * Admin API-key oversight: every key on the panel, who owns it, when it was
 * last used, and enable/disable + revoke as the compromise response. Keys
 * carry their owner's full authority (including admin, when the owner is one),
 * so this is the one place to answer "what scripts can act on this panel?".
 *
 * Owners still manage their own keys from /settings; creation here mints a key
 * for the calling admin.
 */
export default function AdminApiKeysPage() {
  const { user: me } = useSession();
  const [keys, setKeys] = React.useState<AdminApiKeyView[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  // The one-time token of a just-created key; null until then.
  const [newToken, setNewToken] = React.useState<string | null>(null);
  // Bumped after any mutation to reload the (possibly filtered) list.
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await adminListApiKeys(query);
        if (!cancelled) setKeys(rows);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load API keys.");
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

  const adminKeys = keys.filter((k) => k.ownerRole === "admin").length;
  const stale = keys.filter((k) => k.status !== "active").length;

  return (
    <>
      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            API keys
          </h1>
          <p className="text-sm text-muted-foreground">
            {loading
              ? "Loading keys…"
              : error
                ? error
                : query
                  ? `${keys.length} match for “${query}”.`
                  : `${keys.length} keys on the panel. ${adminKeys} held by administrators, ${stale} disabled or expired.`}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative w-full md:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search key, owner email or name…"
              className="pl-8"
              aria-label="Search API keys"
            />
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            New key
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Last used</TableHead>
                <TableHead className="text-right">Created</TableHead>
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
                      <Skeleton className="h-5 w-44" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-5 w-10" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-5 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-5 w-16" />
                    </TableCell>
                    <TableCell className="w-10" />
                  </TableRow>
                ))
              ) : keys.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="h-32 text-center text-sm text-muted-foreground"
                  >
                    {query
                      ? "No keys match your search."
                      : "No API keys exist yet. Scripts can authenticate once one is created."}
                  </TableCell>
                </TableRow>
              ) : (
                keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">
                          {key.name ?? (
                            <span className="text-muted-foreground">Untitled</span>
                          )}
                          {key.ownerId === me.id && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              yours
                            </span>
                          )}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {key.prefix ? `${key.prefix}…` : "—"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {key.ownerRole === "admin" ? (
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
                        <span className="text-xs text-muted-foreground">
                          {key.ownerEmail ?? "deleted account"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge apiKey={key} />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {key.requestCount}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {key.lastUsedAt ? formatRelative(key.lastUsedAt) : "never"}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {key.createdAt ? formatRelative(key.createdAt) : "—"}
                    </TableCell>
                    <TableCell>
                      <KeyActions apiKey={key} onChanged={reload} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) {
            setNewToken(null);
            reload();
          }
        }}
        onCreated={(token) => setNewToken(token)}
        newToken={newToken}
      />
    </>
  );
}

function StatusBadge({ apiKey }: { apiKey: AdminApiKeyView }) {
  if (apiKey.status === "expired") {
    return (
      <div className="flex flex-col gap-0.5">
        <Badge variant="outline" className="w-fit text-muted-foreground">
          Expired
        </Badge>
      </div>
    );
  }
  if (apiKey.status === "disabled") {
    return <Badge variant="secondary" className="w-fit">Disabled</Badge>;
  }
  return (
    <Badge
      variant="outline"
      className="w-fit text-emerald-600 dark:text-emerald-400"
    >
      Active
    </Badge>
  );
}

function KeyActions({
  apiKey,
  onChanged,
}: {
  apiKey: AdminApiKeyView;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "The operation failed.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (
      !window.confirm(
        `Revoke "${apiKey.name ?? apiKey.prefix ?? "this key"}"? Scripts using it stop working immediately. This cannot be undone.`,
      )
    ) {
      return;
    }
    await run(() => adminDeleteApiKey(apiKey.id));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Manage key ${apiKey.name ?? apiKey.prefix ?? ""}`}
          />
        }
      >
        •••
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={busy || apiKey.status === "expired"}
          onClick={() =>
            run(async () => {
              await adminSetApiKeyEnabled(apiKey.id, !apiKey.enabled);
            })
          }
        >
          {apiKey.enabled ? "Disable" : "Enable"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={busy} onClick={revoke}>
          Revoke…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Mint a key for the calling admin. The full key is shown exactly once in a
 * dismissible panel; after that only the hashed prefix remains.
 */
function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
  newToken,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (token: string) => void;
  newToken: string | null;
}) {
  const [name, setName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { token } = await adminCreateApiKey(name.trim() || "Admin key");
      setName("");
      onCreated(token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create the key.");
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; the admin can still select the text manually.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5" />
            New admin API key
          </DialogTitle>
          <DialogDescription>
            The key carries your full authority, including admin actions on
            every endpoint. It is stored hashed and shown only once.
          </DialogDescription>
        </DialogHeader>

        {newToken ? (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="flex items-start gap-2 text-sm">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <span className="text-muted-foreground">
                Copy this key now — it cannot be shown again. Send it as{" "}
                <code className="text-foreground">x-api-key</code> or{" "}
                <code className="text-foreground">Authorization: Bearer</code>.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
                {newToken}
              </code>
              <Button type="button" size="icon" variant="outline" onClick={copy}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="api-key-name">Key name</FieldLabel>
              <Input
                id="api-key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
                placeholder="e.g. Terraform provisioning"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !submitting) void submit();
                }}
              />
              <FieldDescription>
                Something that identifies the script or tool that will use it.
              </FieldDescription>
            </Field>
          </FieldGroup>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {!newToken && (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting && <Spinner />}
              Create key
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
