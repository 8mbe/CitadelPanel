"use client";

import * as React from "react";
import {
  Check,
  Copy,
  Database,
  KeyRound,
  Plus,
  Trash2,
} from "lucide-react";

import { CopyButton } from "@/components/copy-button";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { useServerData } from "@/components/server/server-data-context";
import {
  ApiError,
  addServerDatabase,
  getServerDatabases,
  removeServerDatabase,
  resetServerDatabasePassword,
  type ServerDatabase,
} from "@/lib/api";

/** One connection detail: muted label, mono value, copy affordance. */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 truncate font-mono text-sm">{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

/**
 * One provisioned database row.
 *
 * Shows the connection details the game server needs (host, port, name, user).
 * The password is never stored in a way that can be re-read: it is shown once
 * at creation or reset, then masked. A "Reset password" button generates a new
 * one and shows it once.
 */
function DatabaseRow({
  database,
  onRemove,
  onResetPassword,
  busy,
}: {
  database: ServerDatabase;
  onRemove: () => void;
  onResetPassword: () => void;
  busy: boolean;
}) {
  // The plaintext password arrives only at creation or reset; show it then.
  const revealed = database.password;
  const [passwordCopied, setPasswordCopied] = React.useState(false);

  const copyPassword = () => {
    if (!revealed) return;
    navigator.clipboard.writeText(revealed).then(() => {
      setPasswordCopied(true);
      setTimeout(() => setPasswordCopied(false), 1500);
    });
  };

  return (
    <div className="flex flex-col gap-2.5 py-3.5 first:pt-1 last:pb-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Database className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-sm font-medium">
            {database.name}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onResetPassword}
          >
            <KeyRound className="size-3.5" />
            Reset password
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove database"
            disabled={busy}
            onClick={onRemove}
          >
            {busy ? <Spinner /> : <Trash2 />}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 pl-6">
        <Detail label="Host" value={database.host} />
        <Detail label="Port" value={String(database.port)} />
        <Detail label="User" value={database.user} />
      </div>

      {revealed ? (
        <div className="ml-6 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5">
          <span className="w-16 shrink-0 text-xs text-amber-700 dark:text-amber-400">
            Password
          </span>
          <code className="min-w-0 flex-1 break-all font-mono text-xs text-amber-900 dark:text-amber-200">
            {revealed}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-5 shrink-0 text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
            aria-label="Copy password"
            onClick={copyPassword}
          >
            {passwordCopied ? <Check /> : <Copy />}
          </Button>
        </div>
      ) : (
        <p className="ml-6 text-xs text-muted-foreground">
          Password hidden — reset to generate a new one.
        </p>
      )}
    </div>
  );
}

/**
 * The Database tab.
 *
 * Lets a server owner provision MySQL-compatible databases on the node's shared
 * MariaDB. Each database gets a scoped user with access to that one database
 * only. The database host is the MariaDB container's IP on the node's internal
 * Docker network — the game server reaches it because the agent attaches the
 * server's container to that network when the database is created.
 *
 * The database password is generated server-side and shown exactly once (at
 * creation or after a reset). It is stored encrypted and can never be retrieved
 * again.
 */
export function DatabaseTab({ serverId }: { serverId: string }) {
  const { refresh } = useServerData();
  const [databases, setDatabases] = React.useState<ServerDatabase[] | null>(null);
  const [denied, setDenied] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const [adding, setAdding] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await getServerDatabases(serverId);
        if (!cancelled) setDatabases(list);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          if (!cancelled) setDenied(true);
        } else if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : "Failed to load databases.",
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

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      const db = await addServerDatabase(serverId);
      // The new database arrives with its plaintext password — show it once.
      setDatabases((prev) => [...(prev ?? []), { ...db, password: db.password }]);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create database.");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (db: ServerDatabase) => {
    setBusyId(db.id);
    setError(null);
    try {
      await removeServerDatabase(serverId, db.id);
      setDatabases((prev) => (prev ?? []).filter((d) => d.id !== db.id));
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove database.");
    } finally {
      setBusyId(null);
    }
  };

  const resetPassword = async (db: ServerDatabase) => {
    setBusyId(db.id);
    setError(null);
    try {
      const { password } = await resetServerDatabasePassword(serverId, db.id);
      // Show the new password once.
      setDatabases((prev) =>
        (prev ?? []).map((d) => (d.id === db.id ? { ...d, password } : d)),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to reset password.");
    } finally {
      setBusyId(null);
    }
  };

  if (denied) {
    return (
      <Empty className="min-h-[12rem]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Database />
          </EmptyMedia>
          <EmptyTitle>No access</EmptyTitle>
          <EmptyDescription>
            You need permission to manage this server&apos;s databases.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="size-4 text-muted-foreground" />
          Databases
        </CardTitle>
        <CardDescription>
          Provision a MySQL-compatible database on this server&apos;s node. Each
          database has a dedicated user with access to that database only; the
          password is shown once after creation or reset.
        </CardDescription>
        <CardAction>
          <Button type="button" size="sm" disabled={adding} onClick={add}>
            {adding ? <Spinner /> : <Plus />}
            Create database
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Spinner />
          </div>
        ) : databases === null ? (
          <p className="py-4 text-sm text-destructive">{error}</p>
        ) : databases.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No databases provisioned yet.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {databases.map((db) => (
              <DatabaseRow
                key={db.id}
                database={db}
                onRemove={() => void remove(db)}
                onResetPassword={() => void resetPassword(db)}
                busy={busyId === db.id}
              />
            ))}
          </div>
        )}
        {error && databases !== null && (
          <p className="pt-3 text-sm text-destructive">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
