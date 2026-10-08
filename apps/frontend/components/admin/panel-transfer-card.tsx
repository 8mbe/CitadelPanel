"use client";

import * as React from "react";
import { Check, Download, FileUp, TriangleAlert } from "lucide-react";

import {
  adminExportPanel,
  adminImportPanel,
  adminPreviewPanelImport,
  ApiError,
  type PanelExportCounts,
  type PanelImportPreview,
} from "@/lib/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const MIN_PASSPHRASE_LENGTH = 12;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const IMPORT_CONFIRMATION = "REPLACE PANEL";

const COUNT_LABELS: Record<keyof PanelExportCounts, string> = {
  users: "User accounts",
  nodes: "Nodes",
  servers: "Server records",
  blueprints: "Blueprints",
  settings: "Settings groups",
  databases: "Database records",
  schedules: "Schedules",
  apiKeys: "API keys",
};

export function PanelTransferCard({ className }: { className?: string }) {
  const [dialog, setDialog] = React.useState<"export" | "import" | null>(null);

  return (
    <>
      <Card data-slot="panel-transfer-card" className={cn(className)}>
        <CardHeader>
          <CardTitle>Export and import panel</CardTitle>
          <CardDescription>
            Download an encrypted copy of the panel&apos;s metadata and configuration
            to restore on a fresh panel.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Includes users, settings, server records and stored credentials. Server
            files stay on their nodes, and backup snapshots stay in S3. Import is
            available on a panel with no servers and replaces its existing metadata.
          </p>
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => setDialog("export")}>
            <Download data-icon="inline-start" className="size-4" />
            Export panel
          </Button>
          <Button variant="outline" onClick={() => setDialog("import")}>
            <FileUp data-icon="inline-start" className="size-4" />
            Import panel
          </Button>
        </CardFooter>
      </Card>
      {dialog === "export" && <ExportPanelDialog onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportPanelDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function ExportPanelDialog({ onClose }: { onClose: () => void }) {
  const [passphrase, setPassphrase] = React.useState("");
  const [repeat, setRepeat] = React.useState("");
  const [exporting, setExporting] = React.useState(false);
  const [downloaded, setDownloaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const mismatched = repeat.length > 0 && repeat !== passphrase;

  const download = async (event: React.FormEvent) => {
    event.preventDefault();
    setExporting(true);
    setError(null);
    try {
      const { blob, filename } = await adminExportPanel(passphrase);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setPassphrase("");
      setRepeat("");
      setDownloaded(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not export the panel.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !exporting) onClose(); }}>
      <DialogContent className="sm:max-w-md" showCloseButton={!exporting}>
        <DialogHeader>
          <DialogTitle>Export panel</DialogTitle>
          <DialogDescription>
            Protect the archive with a passphrase. You will need it to import the
            panel, even on an installation with a different encryption key.
          </DialogDescription>
        </DialogHeader>
        {downloaded ? (
          <>
            <Alert>
              <Check className="size-4" />
              <AlertTitle>Export downloaded</AlertTitle>
              <AlertDescription>
                Keep the archive and its passphrase in a safe place. The archive
                contains account information and credentials for your nodes.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={download} className="flex flex-col gap-4">
            <FieldGroup>
              <Field data-disabled={exporting}>
                <FieldLabel htmlFor="panel-export-passphrase">Archive passphrase</FieldLabel>
                <Input
                  id="panel-export-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  minLength={MIN_PASSPHRASE_LENGTH}
                  maxLength={1024}
                  disabled={exporting}
                  required
                />
                <FieldDescription>
                  At least 12 characters. The panel does not save this passphrase.
                </FieldDescription>
              </Field>
              <Field data-invalid={mismatched} data-disabled={exporting}>
                <FieldLabel htmlFor="panel-export-repeat">Repeat passphrase</FieldLabel>
                <Input
                  id="panel-export-repeat"
                  type="password"
                  autoComplete="new-password"
                  value={repeat}
                  onChange={(event) => setRepeat(event.target.value)}
                  aria-invalid={mismatched}
                  maxLength={1024}
                  disabled={exporting}
                  required
                />
                {mismatched && <FieldError>The passphrases do not match.</FieldError>}
              </Field>
            </FieldGroup>
            {error && <TransferError message={error} />}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={exporting}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={exporting || passphrase.length < MIN_PASSPHRASE_LENGTH || repeat !== passphrase}
              >
                {exporting ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" className="size-4" />}
                {exporting ? "Exporting…" : "Download export"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImportPanelDialog({ onClose }: { onClose: () => void }) {
  const [archive, setArchive] = React.useState<Record<string, unknown> | null>(null);
  const [filename, setFilename] = React.useState("");
  const [passphrase, setPassphrase] = React.useState("");
  const [reading, setReading] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [restored, setRestored] = React.useState(false);
  const [preview, setPreview] = React.useState<PanelImportPreview | null>(null);
  const [confirmation, setConfirmation] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const busy = reading || previewing || restoring;

  const readFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setArchive(null);
    setPreview(null);
    setConfirmation("");
    setFilename(file.name);
    setError(null);
    setReading(true);
    try {
      if (file.size > MAX_ARCHIVE_BYTES) throw new Error("Choose an archive no larger than 64 MB.");
      const parsed: unknown = JSON.parse(await file.text());
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("This file is not a panel export archive.");
      }
      setArchive(parsed as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof SyntaxError
        ? "This file is not valid JSON. Choose a panel export archive."
        : err instanceof Error ? err.message : "Could not read the archive.");
    } finally {
      setReading(false);
      event.target.value = "";
    }
  };

  const review = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!archive) return;
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await adminPreviewPanelImport(archive, passphrase));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not preview the archive.");
    } finally {
      setPreviewing(false);
    }
  };

  const restore = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!archive || !preview || confirmation !== IMPORT_CONFIRMATION) return;
    setRestoring(true);
    setError(null);
    try {
      await adminImportPanel(archive, passphrase, confirmation);
      setArchive(null);
      setPassphrase("");
      setRestored(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not import the panel.");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy && !restored) onClose(); }}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy && !restored}>
        <DialogHeader>
          <DialogTitle>{restored ? "Panel imported" : "Import panel"}</DialogTitle>
          <DialogDescription>
            {restored
              ? "The panel has been restored. Your previous session has ended."
              : "Import into a fresh panel with no servers. Review the archive before replacing this panel's users, settings and node records."}
          </DialogDescription>
        </DialogHeader>
        {restored ? (
          <>
            <Alert>
              <Check className="size-4" />
              <AlertTitle>Sign in with a restored administrator account</AlertTitle>
              <AlertDescription>
                Use the password and two-factor authentication from the exported panel.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={() => window.location.assign("/login")}>Continue to sign in</Button>
            </DialogFooter>
          </>
        ) : preview ? (
          <form onSubmit={restore} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1 text-sm">
              <span className="break-all font-medium">{filename}</span>
              <span className="text-muted-foreground">
                Exported {new Date(preview.createdAt).toLocaleString()}
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Included metadata</TableHead>
                  <TableHead className="text-right">Records</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(Object.keys(COUNT_LABELS) as (keyof PanelExportCounts)[]).map((key) => (
                  <TableRow key={key}>
                    <TableCell>{COUNT_LABELS[key]}</TableCell>
                    <TableCell className="text-right tabular-nums">{preview.counts[key]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertTitle>This replaces the panel&apos;s existing metadata</AlertTitle>
              <AlertDescription>
                <p>
                  All current sessions end. Sign in afterward with an administrator
                  account from this archive:
                </p>
                <ul className="flex flex-col gap-1">
                  {preview.administratorEmails.map((email) => <li key={email} className="break-all">{email}</li>)}
                </ul>
                <p className="mt-2">
                  Server files stay on their nodes. Import does not start, stop or move containers.
                </p>
              </AlertDescription>
            </Alert>
            <FieldGroup>
              <Field data-disabled={restoring}>
                <FieldLabel htmlFor="panel-import-confirmation">Type REPLACE PANEL to confirm</FieldLabel>
                <Input
                  id="panel-import-confirmation"
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={restoring}
                  required
                />
              </Field>
            </FieldGroup>
            {error && <TransferError message={error} />}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={restoring}
                onClick={() => { setPreview(null); setConfirmation(""); setError(null); }}
              >
                Back
              </Button>
              <Button type="submit" variant="destructive" disabled={restoring || confirmation !== IMPORT_CONFIRMATION}>
                {restoring && <Spinner data-icon="inline-start" />}
                {restoring ? "Importing…" : "Replace panel"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={review} className="flex flex-col gap-4">
            <FieldGroup>
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="panel-import-file">Panel export archive</FieldLabel>
                <Input id="panel-import-file" type="file" accept="application/json,.json" onChange={readFile} disabled={busy} />
                <FieldDescription>
                  {reading ? "Reading archive…" : filename || "Choose an encrypted JSON export, up to 64 MB."}
                </FieldDescription>
              </Field>
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="panel-import-passphrase">Archive passphrase</FieldLabel>
                <Input
                  id="panel-import-passphrase"
                  type="password"
                  autoComplete="off"
                  value={passphrase}
                  onChange={(event) => { setPassphrase(event.target.value); setError(null); }}
                  minLength={MIN_PASSPHRASE_LENGTH}
                  maxLength={1024}
                  disabled={busy}
                  required
                />
                <FieldDescription>The passphrase used when this archive was exported.</FieldDescription>
              </Field>
            </FieldGroup>
            {error && <TransferError message={error} />}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || !archive || passphrase.length < MIN_PASSPHRASE_LENGTH}>
                {previewing && <Spinner data-icon="inline-start" />}
                {previewing ? "Reading export…" : "Preview import"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TransferError({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Could not complete the transfer</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
