import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A small Markdown renderer for the operator-authored legal documents.
 *
 * Hand-rolled rather than pulling in a Markdown library, for two reasons:
 *
 *   1. **No `dangerouslySetInnerHTML`.** This renders React nodes directly, so
 *      there is no HTML string for a `<script>` or an `onerror=` attribute to
 *      ride in on. The author is an admin, but "the admin is trusted" is a weak
 *      place to put the only barrier between a settings field and script
 *      execution on the sign-in page — and these documents are served to
 *      unauthenticated visitors.
 *   2. **The supported syntax is the point.** Legal documents need headings,
 *      paragraphs, lists, emphasis, links, and rules. They do not need tables,
 *      images, footnotes, or embedded HTML, and every construct left out is one
 *      fewer thing to get wrong.
 *
 * Supported: ATX headings (`#`–`######`), paragraphs, blockquotes, `-`/`*` and
 * `1.` lists (flat), `---` rules, and inline `**bold**`, `_italic_`, `` `code` ``,
 * and `[text](url)`.
 *
 * Link targets are restricted to http, https, mailto, and site-relative paths;
 * anything else (notably `javascript:`) renders as plain text.
 */
export function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {renderBlocks(content)}
    </div>
  );
}

/** A parsed block, before it becomes an element. */
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "rule" };

/**
 * Split the source into blocks.
 *
 * Line-oriented rather than a real parser: a blank line ends a paragraph, a
 * marker line starts a list, and consecutive lines inside a paragraph or list
 * item are joined with a space (so hard-wrapped source reflows rather than
 * breaking mid-sentence).
 */
function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];

  // The paragraph or list currently being accumulated.
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
    if (quote.length > 0) {
      blocks.push({ kind: "quote", text: quote.join(" ") });
      quote = [];
    }
    if (list) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === "") {
      flush();
      continue;
    }

    // Horizontal rule: --- / *** / ___ on its own line.
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2].trim(),
      });
      continue;
    }

    const blockquote = /^>\s?(.*)$/.exec(line);
    if (blockquote) {
      if (paragraph.length > 0 || list) flush();
      quote.push(blockquote[1].trim());
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = bullet === null;
      const text = (bullet ?? numbered)![1].trim();
      if (paragraph.length > 0 || quote.length > 0) flush();
      // A change of marker type starts a new list rather than mixing them.
      if (list && list.ordered !== ordered) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push(text);
      continue;
    }

    // A plain line while a list is open is a continuation of the last item.
    if (list && list.items.length > 0) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (quote.length > 0) {
      quote[quote.length - 1] += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-2 font-heading text-2xl font-semibold tracking-tight",
  2: "mt-6 font-heading text-lg font-semibold tracking-tight",
  3: "mt-4 font-heading text-base font-semibold tracking-tight",
  4: "mt-4 font-heading text-sm font-semibold tracking-tight",
  5: "mt-4 font-heading text-sm font-medium tracking-tight",
  6: "mt-4 font-heading text-sm font-medium tracking-tight text-muted-foreground",
};

function renderBlocks(source: string): React.ReactNode[] {
  return parseBlocks(source).map((block, index) => {
    const key = `block-${index}`;

    switch (block.kind) {
      case "rule":
        return <hr key={key} className="border-border" />;

      case "heading": {
        // `as` on a computed tag name: the level is clamped to 1–6 by the regex
        // that produced it, so this is always a real heading element.
        const Tag = `h${block.level}` as "h1";
        return (
          <Tag key={key} className={HEADING_CLASS[block.level]}>
            {renderInline(block.text)}
          </Tag>
        );
      }

      case "quote":
        return (
          <blockquote
            key={key}
            className="border-l-2 border-border pl-4 text-sm text-muted-foreground"
          >
            {renderInline(block.text)}
          </blockquote>
        );

      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return (
          <Tag
            key={key}
            className={cn(
              "flex flex-col gap-1.5 pl-5 text-sm/relaxed",
              block.ordered ? "list-decimal" : "list-disc",
            )}
          >
            {block.items.map((item, i) => (
              <li key={`${key}-${i}`}>{renderInline(item)}</li>
            ))}
          </Tag>
        );
      }

      case "paragraph":
        return (
          <p key={key} className="text-sm/relaxed">
            {renderInline(block.text)}
          </p>
        );
    }
  });
}

/**
 * One pass over a line, splitting on the inline constructs.
 *
 * Alternation order matters: `**bold**` is tried before `_italic_` so `**` is
 * not consumed as two emphasis markers, and code spans are matched first so
 * markup inside backticks stays literal.
 *
 * The link target allows one level of balanced parentheses, so a URL like
 * `https://en.wikipedia.org/wiki/GDPR_(EU)` is captured whole. Without that, the
 * target would stop at the first `)` and the remainder would be left dangling as
 * stray text after the link.
 */
const LINK_TARGET = String.raw`(?:[^()\s]|\([^()\s]*\))+`;

const INLINE_PATTERN = new RegExp(
  [
    "(`[^`]+`)",
    String.raw`(\*\*[^*]+\*\*)`,
    "(__[^_]+__)",
    String.raw`(\*[^*\s][^*]*\*)`,
    "(_[^_\\s][^_]*_)",
    String.raw`(\[[^\]]+\]\(${LINK_TARGET}\))`,
  ].join("|"),
  "g",
);

const LINK_PATTERN = new RegExp(String.raw`^\[([^\]]+)\]\((${LINK_TARGET})\)$`);

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const token = match[0];
    const start = match.index;

    if (start > cursor) nodes.push(text.slice(cursor, start));
    cursor = start + token.length;

    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key++}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
      continue;
    }

    if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={key++} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
      continue;
    }

    if (token.startsWith("[")) {
      const link = LINK_PATTERN.exec(token)!;
      const [, label, href] = link;
      if (isSafeHref(href)) {
        const external = /^https?:/i.test(href);
        nodes.push(
          <a
            key={key++}
            href={href}
            className="underline underline-offset-4 hover:text-primary"
            {...(external
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
          >
            {label}
          </a>,
        );
      } else {
        // An unsupported scheme degrades to the visible label. Rendering the
        // raw URL would put a `javascript:` string on the page as text, which is
        // harmless but confusing; the label is what the author meant to show.
        nodes.push(label);
      }
      continue;
    }

    // Remaining alternatives are single-marker emphasis.
    nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/**
 * Allow only schemes that cannot execute script: absolute http(s), mailto, and
 * site-relative paths and fragments. Protocol-relative `//host` is rejected too,
 * since it is an absolute URL in disguise.
 */
function isSafeHref(href: string): boolean {
  if (href.startsWith("//")) return false;
  if (href.startsWith("/") || href.startsWith("#")) return true;
  return /^(https?:|mailto:)/i.test(href);
}
