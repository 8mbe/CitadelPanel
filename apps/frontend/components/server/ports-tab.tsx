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
 * One published port row.
 *
 * Bindings are identity mappings. The same number is published on the host and
 * bound inside the container, and every port is claimed on TCP and UDP both, so
 * a port is a single number with no protocol to qualify it.
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
          <span className="text-muted-foreground"> · TCP + UDP</span>
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
 * Shows every published port for this server. The game's blueprint ports are
 * fixed by the game and cannot be removed here. The owner may publish an
 * additional port, but does **not** pick its number: the panel draws a free one
 * from the node's pool at random and reports which it got. Asking the owner for
 * a number only ever produced errors that were not theirs to fix ("not in the
 * pool", "already allocated"), for a number that means nothing until the panel
 * has allocated it.
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

  // Add-form state: a label is the only thing the owner supplies.
  const [label, setLabel] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [removingKey, setRemovingKey] = React.useState<number | null>(null);
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
    setAdding(true);
    setError(null);
    setNote(null);
    try {
      const known = new Set(ports?.map((p) => p.port) ?? []);
      const updated = await addServerPort(serverId, {
        label: label.trim() || undefined,
      });
      setLabel("");
      setRefreshKey((k) => k + 1);
      await refresh();
      // Name the allocated number: the owner did not choose it, so this is the
      // only place they learn what to point a plugin config at.
      const allocated = updated.ports.find((p) => !known.has(p.port));
      setNote(
        allocated
          ? `Port ${allocated.port} published (TCP and UDP). The container was recreated to apply the new binding.`
          : "Port published. The container was recreated to apply the new binding.",
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add port.");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (port: ServerPort) => {
    setRemovingKey(port.port);
    setError(null);
    setNote(null);
    try {
      await removeServerPort(serverId, port.port);
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
            Ports published for this server. Each one is forwarded to the
            container as the same number, on TCP and UDP both, so there is never
            a protocol to pick. The game&apos;s blueprint ports (including the
            primary player port) are fixed by the game and cannot be removed
            here.
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
              {ports.map((port) => (
                <PortRow
                  key={port.port}
                  port={port}
                  onRemove={() => void remove(port)}
                  removing={removingKey === port.port}
                />
              ))}
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
            The port number is assigned for you. A free one is drawn at random
            from this node&apos;s pool and published on TCP and UDP as the same
            number inside and outside the container. Configure the game or plugin
            to listen on the number you get back. Publishing a port recreates the
            container, so a running server restarts briefly.
          </FieldDescription>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
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
            <Button type="button" disabled={adding} onClick={add}>
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
