"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Spinner } from "@/components/ui/spinner";
import {
  UserCombobox,
  toUserOption,
  type UserOption,
} from "@/components/admin/user-combobox";
import {
  adminCreateServer,
  adminListNodes,
  adminListUsers,
  ApiError,
  listBlueprints,
} from "@/lib/api";
import { formatMb } from "@/lib/format";
import type { BlueprintView, NodeView } from "@/lib/types";

/**
 * Admin-only provisioning dialog. Ordinary users never see this control — a
 * fresh account simply has no servers until an admin creates one for it.
 *
 * Owners and game blueprints are loaded from the backend when the dialog opens.
 * On success it calls `onCreated` so the parent reloads its list.
 */
export function CreateServerDialog({
  onCreated,
}: {
  onCreated: () => void | Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [initialUsers, setInitialUsers] = React.useState<UserOption[]>([]);
  const [blueprints, setBlueprints] = React.useState<BlueprintView[]>([]);
  const [nodes, setNodes] = React.useState<NodeView[]>([]);
  const [owner, setOwner] = React.useState<UserOption | null>(null);
  const [name, setName] = React.useState("");
  const [blueprintKey, setBlueprintKey] = React.useState("");
  // "auto" lets the scheduler place the server; any other value pins the node.
  const [nodeId, setNodeId] = React.useState("auto");
  const [cpu, setCpu] = React.useState("2");
  const [memoryGb, setMemoryGb] = React.useState("4");
  const [diskGb, setDiskGb] = React.useState("25");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const blueprint = blueprints.find((p) => p.key === blueprintKey);

  // Load owners and blueprints when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [users, blueprintList, nodeList] = await Promise.all([
          adminListUsers(),
          listBlueprints(),
          adminListNodes(),
        ]);
        if (cancelled) return;
        setInitialUsers(users.map(toUserOption));
        setBlueprints(blueprintList);
        setNodes(nodeList.map((entry) => entry.node));
        // Default the owner to the first non-admin, else the first account.
        const defaultUser = users.find((u) => u.role === "user") ?? users[0];
        setOwner((current) => current ?? (defaultUser ? toUserOption(defaultUser) : null));
        setBlueprintKey((current) => current || blueprintList[0]?.key || "");
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : "Failed to load form data.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!owner) {
      setError("Choose an owner.");
      return;
    }
    if (!blueprint) {
      setError("Choose a game blueprint.");
      return;
    }

    const cpuLimit = Number(cpu);
    const memoryLimitMb = Math.round(Number(memoryGb) * 1024);
    const diskLimitMb = Math.round(Number(diskGb) * 1024);
    if (
      !Number.isFinite(cpuLimit) ||
      cpuLimit < blueprint.minimums.cpuLimit ||
      memoryLimitMb < blueprint.minimums.memoryLimitMb ||
      diskLimitMb < blueprint.minimums.diskLimitMb
    ) {
      setError(
        `Resources are below the minimum for ${blueprint.name}: ` +
          `${blueprint.minimums.cpuLimit} cores, ` +
          `${formatMb(blueprint.minimums.memoryLimitMb)} memory, ` +
          `${formatMb(blueprint.minimums.diskLimitMb)} disk.`,
      );
      return;
    }

    setSubmitting(true);
    try {
      await adminCreateServer({
        name,
        ownerId: owner.value,
        blueprintKey,
        cpuLimit,
        memoryLimitMb,
        diskLimitMb,
        // Omit when "auto" so the scheduler picks the node.
        ...(nodeId !== "auto" ? { nodeId } : {}),
      });
      setOpen(false);
      setName("");
      await onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Provisioning failed. Check the backend logs and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus />
        Provision server
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Provision a server</DialogTitle>
          <DialogDescription>
            Create a game server on behalf of a user. The server appears on their
            &quot;Your servers&quot; page once provisioning completes.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="cs-owner">Owner</FieldLabel>
              <UserCombobox
                id="cs-owner"
                value={owner}
                onChange={setOwner}
                initialUsers={initialUsers}
              />
              <FieldDescription>
                The user who will own and manage this server.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="cs-name">Server name</FieldLabel>
              <Input
                id="cs-name"
                required
                maxLength={64}
                placeholder="SkyHaven SMP"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Game</FieldLabel>
              <Select
                value={blueprintKey}
                onValueChange={(v) => {
                  if (v) setBlueprintKey(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a game" />
                </SelectTrigger>
                <SelectContent>
                  {blueprints.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Node</FieldLabel>
              <Select
                value={nodeId}
                onValueChange={(v) => {
                  if (v) setNodeId(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Auto" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (let the scheduler choose)</SelectItem>
                  {nodes.map((node) => (
                    <SelectItem
                      key={node.id}
                      value={node.id}
                      disabled={!node.isActive}
                    >
                      {node.name}
                      {node.isActive ? "" : " (draining)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Leave on Auto to place by free capacity, or pin a specific node.
              </FieldDescription>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field>
                <FieldLabel htmlFor="cs-cpu">CPU cores</FieldLabel>
                <Input
                  id="cs-cpu"
                  type="number"
                  required
                  min={blueprint?.minimums.cpuLimit ?? 0.5}
                  max={64}
                  step={0.5}
                  value={cpu}
                  onChange={(e) => setCpu(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="cs-memory">Memory (GB)</FieldLabel>
                <Input
                  id="cs-memory"
                  type="number"
                  required
                  min={
                    blueprint ? Math.ceil(blueprint.minimums.memoryLimitMb / 1024) : 1
                  }
                  max={256}
                  step={1}
                  value={memoryGb}
                  onChange={(e) => setMemoryGb(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="cs-disk">Disk (GB)</FieldLabel>
                <Input
                  id="cs-disk"
                  type="number"
                  required
                  min={blueprint ? Math.ceil(blueprint.minimums.diskLimitMb / 1024) : 1}
                  max={2000}
                  step={1}
                  value={diskGb}
                  onChange={(e) => setDiskGb(e.target.value)}
                />
              </Field>
            </div>
            {blueprint && (
              <p className="text-xs text-muted-foreground">
                Minimums for {blueprint.name}: {blueprint.minimums.cpuLimit} cores,{" "}
                {formatMb(blueprint.minimums.memoryLimitMb)} memory,{" "}
                {formatMb(blueprint.minimums.diskLimitMb)} disk.
                {nodeId === "auto"
                  ? " The node is chosen automatically by the scheduler."
                  : " Placed on the selected node if it has free capacity."}
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !owner || !blueprintKey}>
              {submitting && <Spinner />}
              Create server
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
