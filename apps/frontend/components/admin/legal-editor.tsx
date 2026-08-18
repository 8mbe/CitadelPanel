"use client";

import * as React from "react";
import Link from "next/link";
import nextDynamic from "next/dynamic";
import {
  Eye,
  ExternalLink,
  FileText,
  PenLine,
  Save,
  ShieldQuestion,
} from "lucide-react";

import {
  ApiError,
  getLegalDocuments,
  saveLegalDocument,
  type LegalDocumentKey,
  type LegalSettings,
} from "@/lib/api";
import { useBranding } from "@/components/branding-provider";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  privacyPolicyTemplate,
  termsOfServiceTemplate,
} from "@/lib/legal-templates";
import { cn } from "@/lib/utils";

// `ssr: false` keeps CodeMirror's DOM-dependent module out of the server bundle,
// matching how the file manager loads it.
const CodeEditor = nextDynamic(() => import("@/components/code-editor"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Spinner className="size-5" />
    </div>
  ),
});

const DOCUMENTS = [
  {
    key: "terms" as const,
    label: "Terms of Service",
    path: "/terms",
    icon: FileText,
  },
  {
    key: "privacy" as const,
    label: "Privacy Policy",
    path: "/privacy",
    icon: ShieldQuestion,
  },
];

/**
 * The legal document editor.
 *
 * A real editor — CodeMirror with a side-by-side preview — rather than a textarea
 * in the settings form, because these are documents, not settings: they are
 * thousands of words long, they are written over multiple sittings, and they are
 * the one thing on the panel a lawyer might read. A four-row textarea buried
 * under the SMTP fields would guarantee nobody writes them properly.
 *
 * The panel supplies drafts, not defaults (see `lib/legal-templates.ts`). Nothing
 * is published until an admin saves, so a fresh install has no policy rather than
 * a wrong one, and the "Insert draft" button is only offered on an empty
 * document — it must never be able to overwrite text an admin has written.
 */
export function AdminLegalEditor() {
  const [documents, setDocuments] = React.useState<LegalSettings | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getLegalDocuments();
        if (!cancelled) setDocuments(data);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : "Could not load the legal documents.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!documents) return <Skeleton className="h-[32rem] w-full" />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          Legal documents
        </h1>
        <p className="text-sm text-muted-foreground">
          Your terms of service and privacy policy, written in Markdown and
          published at <code>/terms</code> and <code>/privacy</code>. Both are
          empty until you write them — the panel ships no default text, because a
          policy that describes someone else&apos;s service is worse than none.
        </p>
      </div>

      <Tabs defaultValue="privacy">
        <TabsList>
          {DOCUMENTS.map((doc) => (
            <TabsTrigger key={doc.key} value={doc.key}>
              <doc.icon className="size-4" />
              <span className="hidden sm:inline">{doc.label}</span>
              <span className="sm:hidden">
                {doc.key === "terms" ? "Terms" : "Privacy"}
              </span>
              {documents[doc.key].content ? null : (
                <Badge variant="secondary" className="ml-1 text-[10px]">
                  Empty
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {DOCUMENTS.map((doc) => (
          <TabsContent key={doc.key} value={doc.key}>
            <DocumentEditor
              documentKey={doc.key}
              label={doc.label}
              path={doc.path}
              initial={documents[doc.key]}
              onSaved={setDocuments}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function DocumentEditor({
  documentKey,
  label,
  path,
  initial,
  onSaved,
}: {
  documentKey: LegalDocumentKey;
  label: string;
  path: string;
  initial: LegalSettings[LegalDocumentKey];
  onSaved: (settings: LegalSettings) => void;
}) {
  const { siteName } = useBranding();
  const [content, setContent] = React.useState(initial.content);
  // The last saved text, so "dirty" is a comparison rather than a flag that has
  // to be cleared in every branch.
  const [saved, setSaved] = React.useState(initial.content);
  const [updatedAt, setUpdatedAt] = React.useState(initial.updatedAt);
  const [preview, setPreview] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const dirty = content !== saved;
  const published = saved.length > 0;

  const save = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await saveLegalDocument(documentKey, content);
      onSaved(next);
      setSaved(next[documentKey].content);
      setUpdatedAt(next[documentKey].updatedAt);
      setNotice(
        next[documentKey].content
          ? "Saved and published."
          : "Saved. The document is empty, so the page is no longer published.",
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not save the document.",
      );
    } finally {
      setBusy(false);
    }
  }, [content, documentKey, onSaved]);

  // Only offered while the buffer is empty, so it can never clobber real text.
  const insertDraft = () => {
    setContent(
      documentKey === "privacy"
        ? privacyPolicyTemplate(siteName)
        : termsOfServiceTemplate(siteName),
    );
    setNotice(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {published ? (
            <Badge variant="secondary">Published</Badge>
          ) : (
            <Badge variant="outline">Not published</Badge>
          )}
          {dirty && <Badge variant="destructive">Unsaved changes</Badge>}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {content.trim() === "" && (
            <Button type="button" variant="outline" size="sm" onClick={insertDraft}>
              <PenLine />
              Insert draft
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPreview((p) => !p)}
            aria-pressed={preview}
          >
            <Eye />
            {preview ? "Hide preview" : "Preview"}
          </Button>
          {published && (
            <Button
              variant="outline"
              size="sm"
              render={<Link href={path} target="_blank" />}
              nativeButton={false}
            >
              <ExternalLink />
              View page
            </Button>
          )}
          <Button type="button" size="sm" onClick={save} disabled={busy || !dirty}>
            {busy ? <Spinner /> : <Save />}
            Save
          </Button>
        </div>
      </div>

      {documentKey === "privacy" && (
        <p className="rounded-lg border bg-muted/40 p-3 text-xs/relaxed text-muted-foreground">
          The privacy draft is generated from what this panel&apos;s code actually
          stores — accounts, sessions, API keys, the audit log and the IP
          addresses in it, server files, and the third parties your configuration
          reaches (email, captcha, AI, analytics). It cannot know about your
          hosting provider, your backups, your server logs, or your jurisdiction.
          Replace every <code>[TODO]</code> marker before you publish.
        </p>
      )}

      <div
        className={cn(
          "grid gap-3",
          preview && "lg:grid-cols-2",
        )}
      >
        <div className="h-[60vh] min-h-[24rem] overflow-hidden rounded-xl border bg-card ring-1 ring-foreground/5">
          <CodeEditor
            value={content}
            filename={`${documentKey}.md`}
            wrap
            onChange={setContent}
            onSave={() => void save()}
          />
        </div>
        {preview && (
          <div className="h-[60vh] min-h-[24rem] overflow-y-auto rounded-xl border bg-card p-4 ring-1 ring-foreground/5 md:p-6">
            {content.trim() ? (
              <Markdown content={content} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing to preview yet.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{content.length.toLocaleString("en-US")} characters</span>
        {updatedAt && (
          <span>Last saved {new Date(updatedAt).toLocaleString()}</span>
        )}
        <span>
          Markdown: headings, lists, <code>**bold**</code>,{" "}
          <code>_italic_</code>, and <code>[links](/path)</code>. Ctrl/Cmd+S
          saves.
        </span>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && !error && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>
      )}
    </div>
  );
}
