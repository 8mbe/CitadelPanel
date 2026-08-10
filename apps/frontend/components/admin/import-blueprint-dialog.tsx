"use client";

import * as React from "react";
import { FileUp, Link2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { adminImportBlueprintFromUrl, ApiError } from "@/lib/api";
import { fileToForm, parseBlueprintFile, type FormValues } from "@/lib/blueprint-io";

/**
 * Import a blueprint from JSON: paste it, upload a `.json` file, or fetch it
 * from a link. All three funnel into the same textarea; "Continue" parses and
 * hands the values to the create form for review before anything is saved.
 *
 * URL fetches go through the panel (`import-url`) rather than the browser, so a
 * link without permissive CORS still works.
 */
export function ImportBlueprintDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (values: FormValues) => void;
}) {
  const [text, setText] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [fetching, setFetching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setText("");
      setUrl("");
      setError(null);
      setFetching(false);
    }
  }, [open]);

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      setText(await file.text());
    } catch {
      setError("Couldn't read that file.");
    } finally {
      // Allow re-selecting the same file.
      event.target.value = "";
    }
  };

  const onFetch = async () => {
    if (!url.trim()) return;
    setFetching(true);
    setError(null);
    try {
      const obj = await adminImportBlueprintFromUrl(url.trim());
      setText(JSON.stringify(obj, null, 2));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to fetch that URL.");
    } finally {
      setFetching(false);
    }
  };

  const onContinue = () => {
    setError(null);
    try {
      const file = parseBlueprintFile(text);
      onImported(fileToForm(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that blueprint.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import blueprint</DialogTitle>
          <DialogDescription>
            Paste JSON, upload a file, or fetch from a link. You&apos;ll review it
            before it&apos;s created.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field orientation="horizontal">
            <Input
              type="url"
              placeholder="https://example.com/blueprint.json"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onFetch();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={onFetch}
              disabled={fetching || !url.trim()}
            >
              {fetching ? <Loader2 className="animate-spin" /> : <Link2 />}
              Fetch
            </Button>
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor="import-json">Blueprint JSON</FieldLabel>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp />
                Upload file
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={onFile}
              />
            </div>
            <Textarea
              id="import-json"
              rows={12}
              className="font-mono text-xs"
              placeholder={'{\n  "key": "valheim",\n  "name": "Valheim",\n  ...\n}'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <FieldDescription>
              Matches the exported format — see the built-in blueprints for a
              template.
            </FieldDescription>
          </Field>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={onContinue} disabled={!text.trim()}>
            Continue to review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
