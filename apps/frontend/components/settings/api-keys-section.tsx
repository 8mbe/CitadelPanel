"use client";

import * as React from "react";
import { Check, Copy, KeyRound, Plus } from "lucide-react";

import { ApiError, authRequest } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { formatRelative } from "@/lib/format";

/**
 * API key management, backed by Better Auth's API-key plugin endpoints.
 *
 * Keys authenticate `/api/*` requests via the `x-api-key` header or
 * `Authorization: Bearer <key>` and carry the owner's session, so a key can do
 * exactly what its owner can, and no more. The full key is shown only once at
 * creation; afterwards only a masked prefix is recoverable.
 */
interface ApiKeyRow {
  id: string;
  name: string | null;
  prefix: string | null;
  start: string | null;
  enabled: boolean;
  createdAt: string | null;
  expiresAt: string | null;
}

export function ApiKeysSection() {
  const [keys, setKeys] = React.useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await authRequest<{ data?: ApiKeyRow[] }>(
        "/api/auth/api-key/list",
      );
      setKeys(data.data ?? []);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not load API keys.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load. The fetch lives inside an async IIFE so the setStates happen
  // after the first await, not synchronously in the effect body (which this
  // codebase's lint rule rejects as a cascading-render smell).
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authRequest<{ data?: ApiKeyRow[] }>(
          "/api/auth/api-key/list",
        );
        if (!cancelled) setKeys(data.data ?? []);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : "Could not load API keys.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" />
          API keys
        </CardTitle>
        <CardDescription>
          Keys let scripts and tools call the panel API on your behalf. Use the{" "}
          <code className="text-foreground">x-api-key</code> header or{" "}
          <code className="text-foreground">Authorization: Bearer</code>. Treat
          them like passwords. They grant the same access as your account.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <CreateKeyForm onCreated={load} />

        {error && <p className="text-sm text-destructive">{error}</p>}

        {loading ? (
          <Skeleton className="h-20 w-full" />
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No API keys yet. Create one to get started.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <KeyRow key={key.id} apiKey={key} onRevoked={load} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function CreateKeyForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [newKey, setNewKey] = React.useState<string | null>(null);

  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // The plugin returns the full key only here, as `key` on the ApiKey body.
      const created = await authRequest<ApiKeyRow & { key: string }>(
        "/api/auth/api-key/create",
        {
          method: "POST",
          body: JSON.stringify({ name }),
        },
      );
      setNewKey(created.key);
      setName("");
      onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not create the key.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={create} className="flex flex-col gap-3">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="api-key-name">New key name</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="api-key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={64}
                placeholder="e.g. CI deploy script"
              />
              <Button type="submit" disabled={loading || name.trim() === ""}>
                {loading ? <Spinner /> : <Plus />}
                Create
              </Button>
            </div>
          </Field>
        </FieldGroup>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {newKey && <GeneratedKey token={newKey} onDismiss={() => setNewKey(null)} />}
    </div>
  );
}

/** The one-time full key, with copy-to-clipboard. Dismissed, it is gone. */
function GeneratedKey({
  token,
  onDismiss,
}: {
  token: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; the operator can still select the text manually.
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-start gap-2 text-sm">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span className="text-muted-foreground">
          Copy this key now. It is stored hashed and cannot be shown again.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          {token}
        </code>
        <Button type="button" size="icon" variant="outline" onClick={copy}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}

function KeyRow({
  apiKey,
  onRevoked,
}: {
  apiKey: ApiKeyRow;
  onRevoked: () => void;
}) {
  const [revoking, setRevoking] = React.useState(false);

  const revoke = async () => {
    if (!window.confirm(`Revoke "${apiKey.name ?? "this key"}"? This cannot be undone.`)) {
      return;
    }
    setRevoking(true);
    try {
      await authRequest("/api/auth/api-key/delete", {
        method: "POST",
        body: JSON.stringify({ keyId: apiKey.id }),
      });
      onRevoked();
    } catch {
      setRevoking(false);
    }
  };

  return (
    <TableRow>
      <TableCell className="font-medium">
        {apiKey.name ?? <span className="text-muted-foreground">Untitled</span>}
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {apiKey.prefix ? `${apiKey.prefix}…` : "Unknown"}
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        {apiKey.createdAt ? formatRelative(apiKey.createdAt) : "Unknown"}
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="sm"
          onClick={revoke}
          disabled={revoking}
          className="text-destructive"
        >
          {revoking ? <Spinner /> : "Revoke"}
        </Button>
      </TableCell>
    </TableRow>
  );
}
