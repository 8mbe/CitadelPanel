"use client";

import * as React from "react";
import {
  Copy,
  Download,
  Pencil,
  Plus,
  Terminal,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";

import { BlueprintFormDialog } from "@/components/admin/blueprint-form-dialog";
import { ImportBlueprintDialog } from "@/components/admin/import-blueprint-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
  adminDeleteBlueprint,
  adminGetBlueprint,
  adminListBlueprints,
  ApiError,
  type AdminBlueprintSummary,
} from "@/lib/api";
import { detailToFile, type FormValues } from "@/lib/blueprint-io";

/**
 * Admin blueprint library: the setup templates a server can be provisioned
 * from (Docker image, ports, env schema, optional first-launch install script).
 *
 * Built-in blueprints are defined in code and re-seeded on boot, so they are
 * read-only here — an admin can Duplicate one to customise it, but not edit or
 * delete it. Custom blueprints support the full edit/delete lifecycle; delete
 * is blocked while any server still references the blueprint.
 */
type FormState =
  | { mode: "create"; initial?: FormValues }
  | { mode: "edit"; id: string }
  | { mode: "duplicate"; id: string }
  | null;

/** Download an existing blueprint as a canonical JSON file. */
async function exportBlueprint(bp: AdminBlueprintSummary): Promise<void> {
  const detail = await adminGetBlueprint(bp.id);
  const blob = new Blob([JSON.stringify(detailToFile(detail), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${bp.key}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function AdminBlueprintsPage() {
  const [blueprints, setBlueprints] = React.useState<AdminBlueprintSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [form, setForm] = React.useState<FormState>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<AdminBlueprintSummary | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await adminListBlueprints();
        if (cancelled) return;
        setBlueprints(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to load blueprints.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);
  const customCount = blueprints.filter((b) => !b.isBuiltin).length;

  return (
    <>
      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            Blueprints
          </h1>
          <p className="text-sm text-muted-foreground">
            {loading
              ? "Loading blueprints…"
              : `${blueprints.length} blueprint${blueprints.length === 1 ? "" : "s"} · ${customCount} custom. These are the setup templates servers are provisioned from.`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload />
            Import
          </Button>
          <Button onClick={() => setForm({ mode: "create" })}>
            <Plus />
            New blueprint
          </Button>
        </div>
      </div>

      {error ? (
        <Empty className="min-h-[16rem]">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlert />
            </EmptyMedia>
            <EmptyTitle>Couldn&apos;t load blueprints</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Blueprint</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead className="text-right">Servers</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <Skeleton className="h-9 w-48" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-5 w-40" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="ml-auto h-5 w-10" />
                      </TableCell>
                      <TableCell className="w-10" />
                    </TableRow>
                  ))
                ) : blueprints.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="h-32 text-center text-sm text-muted-foreground"
                    >
                      No blueprints yet. Create the first one with the button
                      above.
                    </TableCell>
                  </TableRow>
                ) : (
                  blueprints.map((bp) => (
                    <TableRow key={bp.id} className="group">
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{bp.name}</span>
                            {bp.isBuiltin ? (
                              <Badge variant="secondary">Built-in</Badge>
                            ) : null}
                            {bp.hasInstall ? (
                              <Badge variant="outline" className="gap-1">
                                <Terminal className="size-3" />
                                Install
                              </Badge>
                            ) : null}
                          </div>
                          <span className="font-mono text-xs text-muted-foreground">
                            {bp.key}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {bp.dockerImage}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {bp.serverCount}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Manage ${bp.name}`}
                              />
                            }
                          >
                            •••
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={bp.isBuiltin}
                              onClick={() => setForm({ mode: "edit", id: bp.id })}
                            >
                              <Pencil />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                setForm({ mode: "duplicate", id: bp.id })
                              }
                            >
                              <Copy />
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => void exportBlueprint(bp)}>
                              <Download />
                              Export JSON
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={bp.isBuiltin || bp.serverCount > 0}
                              onClick={() => setDeleteTarget(bp)}
                            >
                              <Trash2 />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {form && (
        <BlueprintFormDialog
          mode={form.mode}
          blueprintId={form.mode === "create" ? undefined : form.id}
          initialValues={form.mode === "create" ? form.initial : undefined}
          open
          onOpenChange={(open) => {
            if (!open) setForm(null);
          }}
          onSaved={() => {
            setForm(null);
            refresh();
          }}
        />
      )}

      <ImportBlueprintDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={(values) => {
          setImportOpen(false);
          // Hand the parsed values to the create form for review before saving.
          setForm({ mode: "create", initial: values });
        }}
      />

      <DeleteBlueprintDialog
        target={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleted={() => {
          setDeleteTarget(null);
          refresh();
        }}
      />
    </>
  );
}

/** Confirm-and-delete dialog for a custom blueprint. */
function DeleteBlueprintDialog({
  target,
  onOpenChange,
  onDeleted,
}: {
  target: AdminBlueprintSummary | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (target) setError(null);
  }, [target]);

  const confirm = async () => {
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      await adminDeleteBlueprint(target.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete blueprint.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete blueprint</DialogTitle>
          <DialogDescription>
            {target
              ? `Permanently delete "${target.name}"? This cannot be undone.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting && <Spinner />}
            Delete blueprint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
