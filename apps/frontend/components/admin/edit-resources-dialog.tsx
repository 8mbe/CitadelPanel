"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { adminUpdateServerResources, ApiError } from "@/lib/api";
import type { ServerView } from "@/lib/types";

/**
 * Admin-only resource-limit editor. Opens from the admin servers table row
 * menu and calls PATCH /api/admin/servers/:id with the new cpu/memory/disk
 * ceilings.
 *
 * The backend enforces two things: the server must be stopped, and the new
 * triple must meet the preset minimums. Limits are intentionally measured in
 * concrete units (vCPU, MB) rather than GB/percentages so the admin sees the
 * exact container cap.
 *
 * Controlled: the parent mounts this only while a server is being edited, so
 * the field state initialises fresh from each target server.
 */
export function EditResourcesDialog({
  server,
  open,
  onOpenChange,
  onUpdated,
}: {
  server: ServerView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}) {
  const [cpu, setCpu] = React.useState(String(server.cpuLimit));
  const [memoryMb, setMemoryMb] = React.useState(String(server.memoryLimitMb));
  const [diskMb, setDiskMb] = React.useState(String(server.diskLimitMb));
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isStopped = server.status === "stopped";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isStopped) {
      setError("Stop the server before changing resource limits.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await adminUpdateServerResources(server.id, {
        cpuLimit: Number(cpu),
        memoryLimitMb: Number(memoryMb),
        diskLimitMb: Number(diskMb),
      });
      onOpenChange(false);
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update resources.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit resource limits</DialogTitle>
          <DialogDescription>
            {server.name} · {isStopped ? "Ready to edit" : "Must be stopped first"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="er-cpu">CPU (vCPU)</FieldLabel>
              <Input
                id="er-cpu"
                type="number"
                step="0.1"
                min={0.1}
                max={64}
                required
                value={cpu}
                onChange={(e) => setCpu(e.target.value)}
                disabled={!isStopped}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="er-memory">Memory (MB)</FieldLabel>
              <Input
                id="er-memory"
                type="number"
                min={256}
                max={262_144}
                required
                value={memoryMb}
                onChange={(e) => setMemoryMb(e.target.value)}
                disabled={!isStopped}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="er-disk">Disk (MB)</FieldLabel>
              <Input
                id="er-disk"
                type="number"
                min={512}
                max={2_000_000}
                required
                value={diskMb}
                onChange={(e) => setDiskMb(e.target.value)}
                disabled={!isStopped}
              />
              <FieldDescription>
                Docker applies CPU and memory caps when the container is created.
              </FieldDescription>
            </Field>
          </FieldGroup>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!isStopped || submitting}>
              {submitting && <Spinner />}
              Save limits
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
