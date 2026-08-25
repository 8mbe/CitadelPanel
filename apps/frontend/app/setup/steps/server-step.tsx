"use client";

import * as React from "react";
import { Castle, ServerCog } from "lucide-react";

import {
  ApiError,
  adminCreateServer,
  listBlueprints,
  type ApiServerSummary,
} from "@/lib/api";
import type { BlueprintView } from "@/lib/types";
import { formatMb } from "@/lib/format";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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

import { InstallProgress } from "./server-install";
import { BlockingIssues, ErrorNote, StepNav } from "./wizard-ui";

/**
 * Step 6: create the operator's first server.
 *
 * The wizard ends here rather than at "your panel is configured" because a
 * configured panel with nothing in it does not tell an operator whether any of
 * it works. Provisioning one server exercises the node, its Docker socket, its
 * data root and its port pool in one action, so a mistake in any of them
 * surfaces now, while the operator is still in the flow that made it.
 *
 * The server is created for the admin themselves. Handing servers to other
 * accounts belongs in the admin area, where there is an owner picker.
 */
export function ServerStep({
  ownerId,
  nodeId,
  nodeReady,
  onFinish,
  onBack,
}: {
  ownerId: string;
  /** The node registered a step ago, or null when that step was skipped. */
  nodeId: string | null;
  /** A node with no reachable agent or no port pool cannot take a server yet. */
  nodeReady: boolean;
  onFinish: (created: ApiServerSummary | null) => void;
  onBack: () => void;
}) {
  const [blueprints, setBlueprints] = React.useState<BlueprintView[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [name, setName] = React.useState("");
  const [blueprintKey, setBlueprintKey] = React.useState("");
  const [cpu, setCpu] = React.useState("2");
  const [memoryGb, setMemoryGb] = React.useState("4");
  const [diskGb, setDiskGb] = React.useState("25");

  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<ApiServerSummary | null>(null);

  const load = React.useCallback(async () => {
    try {
      setBlueprints(await listBlueprints());
      setLoadError(null);
    } catch (err) {
      setBlueprints([]);
      setLoadError(
        err instanceof ApiError
          ? err.message
          : "The game templates could not be loaded.",
      );
    }
  }, []);

  React.useEffect(() => {
    if (!nodeId) return;
    (async () => {
      await load();
    })();
  }, [nodeId, load]);

  const blueprint = blueprints?.find((b) => b.key === blueprintKey);

  // Picking a game refills the resources with what it actually needs, so the
  // operator is not left guessing whether 2 CPU is enough for the thing they
  // just chose.
  const chooseBlueprint = (key: string) => {
    setBlueprintKey(key);
    const chosen = blueprints?.find((b) => b.key === key);
    if (!chosen) return;
    setCpu(String(Math.max(Number(cpu), chosen.minimums.cpuLimit)));
    setMemoryGb(
      String(Math.max(Number(memoryGb), Math.ceil(chosen.minimums.memoryLimitMb / 1024))),
    );
    setDiskGb(
      String(Math.max(Number(diskGb), Math.ceil(chosen.minimums.diskLimitMb / 1024))),
    );
  };

  const issues: string[] = [];
  if (name.trim() === "") issues.push("Name the server.");
  if (blueprintKey === "") issues.push("Choose a game.");
  if (blueprint) {
    if (Number(cpu) < blueprint.minimums.cpuLimit) {
      issues.push(`${blueprint.name} needs at least ${blueprint.minimums.cpuLimit} CPU.`);
    }
    if (Number(memoryGb) * 1024 < blueprint.minimums.memoryLimitMb) {
      issues.push(
        `${blueprint.name} needs at least ${formatMb(blueprint.minimums.memoryLimitMb)} of memory.`,
      );
    }
    if (Number(diskGb) * 1024 < blueprint.minimums.diskLimitMb) {
      issues.push(
        `${blueprint.name} needs at least ${formatMb(blueprint.minimums.diskLimitMb)} of disk.`,
      );
    }
  }

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const server = await adminCreateServer({
        name: name.trim(),
        ownerId,
        blueprintKey,
        cpuLimit: Number(cpu),
        memoryLimitMb: Math.round(Number(memoryGb) * 1024),
        diskLimitMb: Math.round(Number(diskGb) * 1024),
        ...(nodeId ? { nodeId } : {}),
        // Start it as soon as it is built. Asked for at create time rather than
        // from this page, so it still happens when the operator takes the
        // wizard up on "you do not have to wait here".
        startWhenBuilt: true,
      });
      setCreated(server);
    } catch (err) {
      setCreateError(
        err instanceof ApiError
          ? err.message
          : "The server could not be created. Check the node has capacity and try again.",
      );
    } finally {
      setCreating(false);
    }
  };

  // --- Empty: there is nowhere to put a server -------------------------------

  if (!nodeId) {
    return (
      <>
        <CardHeader>
          <CardTitle>Create your first server</CardTitle>
          <CardDescription>
            This is the step that proves the whole install works.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Empty className="min-h-[16rem]">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerCog />
              </EmptyMedia>
              <EmptyTitle>No node to run it on</EmptyTitle>
              <EmptyDescription>
                Game servers are containers on a node. Register one and it can
                host a server straight away.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <p className="text-xs text-muted-foreground">
                You can finish setup now and add both from the admin area later.
              </p>
            </EmptyContent>
          </Empty>
          <StepNav
            onBack={onBack}
            onNext={() => onFinish(null)}
            nextLabel="Finish setup"
            onSkip={onBack}
            skipLabel="Add a node"
          />
        </CardContent>
      </>
    );
  }

  if (created) {
    // `onFinish` takes whatever the install step ended up with rather than the
    // create-time summary: ports are allocated during the build, so the row we
    // got back from create has none.
    return <InstallProgress server={created} onFinish={onFinish} />;
  }

  return (
    <>
      <CardHeader>
        <CardTitle>Create your first server</CardTitle>
        <CardDescription>
          It will belong to your account. Provisioning it now is the quickest
          way to confirm the node, its Docker socket and its ports all work.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!nodeReady && (
          <ErrorNote title="The node is not ready yet">
            Its agent has to be reachable and it needs a reserved port range
            before a server can be placed on it. Go back a step to finish that,
            or finish setup and do it from the admin area.
          </ErrorNote>
        )}

        {blueprints === null ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        ) : loadError ? (
          <ErrorNote title="Could not load the game templates" onRetry={load}>
            {loadError}
          </ErrorNote>
        ) : blueprints.length === 0 ? (
          <Empty className="min-h-[12rem]">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Castle />
              </EmptyMedia>
              <EmptyTitle>No game templates</EmptyTitle>
              <EmptyDescription>
                Blueprints describe how a game is installed and run. The
                built-in ones are seeded on startup, so an empty list means the
                panel could not read them. Finish setup and check
                Admin &rarr; Blueprints.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="setup-server-name">Server name</FieldLabel>
              <Input
                id="setup-server-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Survival"
                maxLength={64}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="setup-server-blueprint">Game</FieldLabel>
              <Select value={blueprintKey} onValueChange={(v) => chooseBlueprint(v ?? "")}>
                <SelectTrigger id="setup-server-blueprint" className="w-full">
                  <SelectValue placeholder="Choose a game" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {blueprints.map((b) => (
                    <SelectItem key={b.key} value={b.key}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {blueprint && (
                <FieldDescription>
                  {blueprint.description ??
                    `Minimum ${blueprint.minimums.cpuLimit} CPU, ${formatMb(blueprint.minimums.memoryLimitMb)} memory.`}
                </FieldDescription>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="setup-server-cpu">CPU cores</FieldLabel>
                <Input
                  id="setup-server-cpu"
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={cpu}
                  onChange={(e) => setCpu(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="setup-server-memory">Memory (GB)</FieldLabel>
                <Input
                  id="setup-server-memory"
                  type="number"
                  min={1}
                  value={memoryGb}
                  onChange={(e) => setMemoryGb(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="setup-server-disk">Disk (GB)</FieldLabel>
                <Input
                  id="setup-server-disk"
                  type="number"
                  min={1}
                  value={diskGb}
                  onChange={(e) => setDiskGb(e.target.value)}
                />
              </Field>
            </div>
          </FieldGroup>
        )}

        {createError && (
          <ErrorNote title="Could not create the server" onRetry={create} retrying={creating}>
            {createError}
          </ErrorNote>
        )}
        <BlockingIssues issues={issues} />

        <StepNav
          onBack={onBack}
          onNext={create}
          loading={creating}
          nextDisabled={issues.length > 0 || !nodeReady || blueprints?.length === 0}
          nextLabel="Create server"
          onSkip={() => onFinish(null)}
          skipLabel="Finish without a server"
        />
      </CardContent>
    </>
  );
}
