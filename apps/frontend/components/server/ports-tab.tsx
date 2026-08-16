"use client";

import * as React from "react";
import { Network, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useServerData } from "@/components/server/server-data-context";
import {
  ApiError,
  addServerPort,
  getServerPorts,
  removeServerPort,
  type ServerPort,
} from "@/lib/api";

/**
 * One published port row: {PORT}/{proto}.
 *
 * Bindings are identity mappings — the same number is published on the host and
 * bound inside the container — so a port is a single number, not a pair.
 *
 * Blueprint ports (the game's built-in ports, including the primary player port)
 * are shown read-only with a badge, so the owner understands why they cannot be
 * removed. Additional ports the owner added carry a remove button.
 */
function PortRow({
  port,
  onRemove,
  removing,
}: {
  port: ServerPort;
  onRemove?: () => void;
  removing?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-sm tabular-nums">
          {port.port}
          <span className="text-muted-foreground">/{port.protocol}</span>
        </span>
        {port.label && (
          <span className="truncate text-xs text-muted-foreground">
            {port.label}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {port.isPrimary ? (
          <Badge variant="default">Primary</Badge>
        ) : port.isAdditional ? (
          <Badge variant="secondary">Additional</Badge>
        ) : (
          <Badge variant="outline">Blueprint</Badge>
        )}
        {port.isAdditional && onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove port"
            disabled={removing}
            onClick={onRemove}
          >
            {removing ? <Spinner /> : <Trash2 />}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The Ports tab.
 *
 * Shows every published port for this server as {PORT}/{protocol}. The game's
 * blueprint ports are fixed by the game and cannot be removed here. The owner
 * may publish additional ports by their exact number — the port must be in the
 * node's reserved port pool and free; it is forwarded to the container as the
 * same number (host N → container N).
 *
 * Adding or removing a port recreates the container (Docker cannot re-bind ports
 * on a running container), so a running server restarts briefly. That is stated
 * inline so it is not a surprise.
 */
export function PortsTab({ serverId }: { serverId: string }) {
  const { refresh } = useServerData();
  const [ports, setPorts] = React.useState<ServerPort[] | null>(null);
  const [denied, setDenied] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Bumped after a mutation to reload without a synchronous setState in an effect.
  const [refreshKey, setRefreshKey] = React.useState(0);

  // Add-form state.
  const [port, setPort] = React.useState("");
  const [protocol, setProtocol] = React.useState<"tcp" | "udp">("tcp");
  const [label, setLabel] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [removingKey, setRemovingKey] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await getServerPorts(serverId);
        if (!cancelled) setPorts(list);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          if (!cancelled) setDenied(true);
        } else if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : "Failed to load ports.",
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

  const additionalCount = ports?.filter((p) => p.isAdditional).length ?? 0;

  const add = async () => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      setError("Port must be a whole number between 1 and 65535.");
      return;
    }

    setAdding(true);
    setError(null);
    setNote(null);
    try {
      await addServerPort(serverId, {
        port: p,
        protocol,
        label: label.trim() || undefined,
      });
      setPort("");
      setLabel("");
      setRefreshKey((k) => k + 1);
      await refresh();
      setNote(
        "Port published. The container was recreated to apply the new binding.",
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add port.");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (port: ServerPort) => {
    const key = `${port.port}/${port.protocol}`;
    setRemovingKey(key);
    setError(null);
    setNote(null);
    try {
      await removeServerPort(serverId, port.port, port.protocol);
      setRefreshKey((k) => k + 1);
      await refresh();
      setNote(
        "Port removed. The container was recreated to release the binding.",
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove port.");
    } finally {
      setRemovingKey(null);
    }
  };

  if (denied) {
    return (
      <Empty className="min-h-[12rem]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Network />
          </EmptyMedia>
          <EmptyTitle>No access</EmptyTitle>
          <EmptyDescription>
            You need permission to manage this server&apos;s settings to view its
            ports.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Ports</CardTitle>
          <CardDescription>
            Ports published for this server, shown as{" "}
            <span className="font-mono">port/protocol</span>. Each port is
            forwarded to the container as the same number. The game&apos;s
            blueprint ports (including the primary player port) are fixed by the
            game and cannot be removed here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Spinner />
            </div>
          ) : ports === null ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : ports.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This server has no published ports.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {ports.map((port) => {
                const key = `${port.port}/${port.protocol}`;
                return (
                  <PortRow
                    key={key}
                    port={port}
                    onRemove={() => void remove(port)}
                    removing={removingKey === key}
                  />
                );
              })}
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publish a port</CardTitle>
          <CardDescription>
            Publish an additional port for plugins, metrics, or a second game
            mode.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FieldDescription>
            Enter the exact port to publish — it is forwarded to the container as
            the same number (host → container), and the game or plugin should be
            configured to listen on it. The port must belong to the node&apos;s
            reserved port pool and be free; anything else is rejected. Publishing
            a port recreates the container, so a running server restarts briefly.
          </FieldDescription>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field className="flex-1">
              <FieldLabel htmlFor="port-number">Port</FieldLabel>
              <Input
                id="port-number"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="25566"
              />
            </Field>
            <Field className="w-full sm:w-28">
              <FieldLabel htmlFor="port-protocol">Protocol</FieldLabel>
              <Select
                value={protocol}
                onValueChange={(v) => v && setProtocol(v as "tcp" | "udp")}
              >
                <SelectTrigger id="port-protocol">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tcp">TCP</SelectItem>
                  <SelectItem value="udp">UDP</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field className="flex-1">
              <FieldLabel htmlFor="port-label">
                Label{" "}
                <span className="text-muted-foreground/70">(optional)</span>
              </FieldLabel>
              <Input
                id="port-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Metrics"
                maxLength={64}
              />
            </Field>
            <Button
              type="button"
              disabled={adding || port.trim() === ""}
              onClick={add}
            >
              {adding && <Spinner />}
              Publish port
            </Button>
          </div>
          {additionalCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {additionalCount} additional port
              {additionalCount === 1 ? "" : "s"} on this server.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
