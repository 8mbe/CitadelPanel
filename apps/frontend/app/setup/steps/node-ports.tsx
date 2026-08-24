"use client";

import * as React from "react";
import { Check, Plus } from "lucide-react";

import {
  ApiError,
  adminAddNodePortPoolEntry,
  adminListNodePortPool,
} from "@/lib/api";
import type { NodePortPoolEntry } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

import { ErrorNote, SuccessNote, WarningNote } from "./wizard-ui";

/**
 * Reserving the node's first port range, immediately after it is registered.
 *
 * This is here rather than left to the admin area because a node with no port
 * pool cannot host anything: provisioning fails at allocation with an error
 * that reads like a bug. Registering a node and stopping is the single easiest
 * way to end setup with an install that looks finished and is not.
 *
 * The pool can only be reserved through a reachable agent (the panel verifies
 * every port is actually free on the host), so an offline node gets an
 * explanation and a retry rather than a dead form.
 */

/** Enough for a first handful of servers, on the port games actually use. */
const SUGGESTED_SPEC = "25565-25584";

export function NodePortPool({
  nodeId,
  agentReachable,
  onPoolChange,
}: {
  nodeId: string;
  agentReachable: boolean;
  /** Lets the parent gate "create a server" on there being somewhere to put it. */
  onPoolChange?: (entries: NodePortPoolEntry[]) => void;
}) {
  const [entries, setEntries] = React.useState<NodePortPoolEntry[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [spec, setSpec] = React.useState(SUGGESTED_SPEC);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const list = await adminListNodePortPool(nodeId);
      setEntries(list);
      setLoadError(null);
      onPoolChange?.(list);
    } catch (err) {
      setEntries([]);
      setLoadError(
        err instanceof ApiError
          ? err.message
          : "The reserved ranges could not be read back.",
      );
    }
    // `onPoolChange` is a parent callback; re-running on its identity would
    // re-fetch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  React.useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  const reserve = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const entry = await adminAddNodePortPoolEntry(nodeId, spec.trim());
      const next = [...(entries ?? []), entry];
      setEntries(next);
      onPoolChange?.(next);
      setSpec("");
    } catch (err) {
      setSaveError(
        err instanceof ApiError
          ? err.message
          : "The range could not be reserved. Check the agent is running and try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const totalPorts = (entries ?? []).reduce((sum, e) => sum + e.ports.length, 0);
  const specValid = /^\d{1,5}(-\d{1,5})?(\s*,\s*\d{1,5}(-\d{1,5})?)*$/.test(
    spec.trim(),
  );

  if (!agentReachable) {
    return (
      <WarningNote>
        Ports are reserved by asking the agent which are free on the host, so
        this has to wait until it responds. Start the agent on the node, then
        reserve a range from <strong>Admin &rarr; Nodes</strong>. Until a node
        has one, provisioning a server on it will fail.
      </WarningNote>
    );
  }

  if (entries === null) {
    return <Skeleton className="h-24 w-full" />;
  }

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor="setup-port-spec">Port range for servers</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="setup-port-spec"
            value={spec}
            onChange={(e) => {
              setSpec(e.target.value);
              setSaveError(null);
            }}
            placeholder="25565-25584"
            aria-invalid={spec.trim() !== "" && !specValid}
          />
          <Button
            type="button"
            variant="outline"
            onClick={reserve}
            disabled={saving || spec.trim() === "" || !specValid}
          >
            {saving ? <Spinner /> : <Plus />}
            Reserve
          </Button>
        </div>
        <FieldDescription>
          {spec.trim() !== "" && !specValid
            ? "Use a range like 25565-25584, or a list like 25565,25577."
            : "Each server gets a port from this pool. The panel checks every port is free on the host before reserving it."}
        </FieldDescription>
      </Field>

      {entries.length > 0 && (
        <SuccessNote>
          <span className="flex flex-wrap items-center gap-1.5">
            {totalPorts} ports reserved:
            {entries.map((entry) => (
              <Badge key={entry.id} variant="secondary" className="font-mono">
                {entry.spec}
              </Badge>
            ))}
            <Check className="size-3.5" />
          </span>
        </SuccessNote>
      )}

      {entries.length === 0 && !saveError && !loadError && (
        <p className="text-sm text-muted-foreground">
          No ports reserved yet. Without a range this node cannot host a server.
        </p>
      )}

      {loadError && (
        <ErrorNote title="Could not read the reserved ranges" onRetry={load}>
          {loadError}
        </ErrorNote>
      )}
      {saveError && (
        <ErrorNote
          title="Could not reserve that range"
          onRetry={reserve}
          retrying={saving}
        >
          {saveError}
        </ErrorNote>
      )}
    </div>
  );
}
