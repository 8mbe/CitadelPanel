/**
 * Tests for the legal-document Markdown renderer.
 *
 * Rendered to a static HTML string because that is the thing worth asserting:
 * the renderer's job is to turn admin-authored text into markup that is safe to
 * serve to anonymous visitors, so the tests check the *output*, not the parse
 * tree. The link-scheme cases are the security-relevant ones. See the note in
 * `markdown.tsx` on why this renderer exists instead of a library.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "./markdown";

const render = (source: string): string =>
  renderToStaticMarkup(<Markdown content={source} />);

describe("blocks", () => {
  test("ATX headings become the matching heading level", () => {
    const html = render("# One\n\n### Three");
    expect(html).toContain("<h1");
    expect(html).toContain("One");
    expect(html).toContain("<h3");
    expect(html).toContain("Three");
  });

  test("a blank line separates paragraphs, and wrapped lines rejoin", () => {
    // Hard-wrapped source must reflow rather than break mid-sentence, so the two
    // lines of the first paragraph are joined with a space.
    const html = render("first line\nsecond line\n\nnext paragraph");
    expect(html).toContain("first line second line");
    expect(html).toContain("next paragraph");
    expect(html.match(/<p /g)?.length).toBe(2);
  });

  test("unordered and ordered lists render as ul/ol", () => {
    expect(render("- a\n- b")).toContain("<ul");
    expect(render("1. a\n2. b")).toContain("<ol");
  });

  test("a change of marker type starts a new list rather than mixing", () => {
    const html = render("- bullet\n1. numbered");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
  });

  test("a plain line after a list item continues that item", () => {
    const html = render("- first item\n  continued here\n- second");
    expect(html).toContain("first item continued here");
  });

  test("blockquotes and horizontal rules are recognised", () => {
    expect(render("> quoted")).toContain("<blockquote");
    expect(render("---")).toContain("<hr");
  });
});

describe("inline", () => {
  test("bold, italic, and code spans", () => {
    expect(render("**strong**")).toContain("<strong");
    expect(render("_emphasis_")).toContain("<em");
    expect(render("`code`")).toContain("<code");
  });

  test("markup inside a code span stays literal", () => {
    // Code spans are matched first, so the asterisks are content, not markers.
    const html = render("`**not bold**`");
    expect(html).toContain("<code");
    expect(html).not.toContain("<strong");
  });

  test("double asterisks are not consumed as two italic markers", () => {
    const html = render("**bold**");
    expect(html).toContain("<strong");
    expect(html).not.toContain("<em");
  });
});

describe("links", () => {
  test("http(s) links open in a new tab with a safe rel", () => {
    const html = render("[site](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
  });

  test("relative links and fragments stay in-tab", () => {
    const html = render("[privacy](/privacy) and [top](#top)");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="#top"');
    expect(html).not.toContain('target="_blank"');
  });

  test("mailto is allowed", () => {
    expect(render("[mail](mailto:ops@example.com)")).toContain(
      'href="mailto:ops@example.com"',
    );
  });

  test("javascript: URLs are dropped, leaving only the label", () => {
    const html = render("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
    expect(html).toContain("click me");
    // The whole token is consumed, so no stray ")" is left dangling after it.
    expect(html).not.toContain("click me)");
  });

  test("a URL containing balanced parentheses is captured whole", () => {
    // Legal documents cite pages like this; stopping the target at the first ")"
    // would both break the link and leave "(EU)" as visible junk.
    const html = render("[GDPR](https://en.wikipedia.org/wiki/GDPR_(EU))");
    expect(html).toContain('href="https://en.wikipedia.org/wiki/GDPR_(EU)"');
    expect(html).not.toContain("GDPR</a>)");
  });

  test("data: URLs are dropped", () => {
    const html = render("[x](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("<a ");
  });

  test("protocol-relative URLs are dropped since they are absolute in disguise", () => {
    const html = render("[x](//evil.example.com)");
    expect(html).not.toContain("evil.example.com");
    expect(html).not.toContain("<a ");
  });
});

describe("raw HTML is never emitted", () => {
  test("a script tag in the source is escaped, not executed", () => {
    const html = render("<script>alert(1)</script>");
    // React escapes text content, so the angle brackets arrive as entities and
    // there is no live element in the document.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("an img with an onerror handler is escaped", () => {
    const html = render('Look: <img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("an event handler survives only as escaped text, never as an attribute", () => {
    const html = render('<div onclick="alert(1)">**bold**</div>');
    // The handler text is still present, as escaped content inside a <p>, which
    // is inert. What matters is that no live element carries it: the quotes are
    // entities, so there is no attribute boundary for the browser to parse.
    expect(html).toContain("&lt;div onclick=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain('onclick="');
    // The surrounding markdown is still processed normally.
    expect(html).toContain("<strong");
  });
});

describe("edge cases", () => {
  test("empty content renders without throwing", () => {
    expect(() => render("")).not.toThrow();
  });

  test("only whitespace produces no blocks", () => {
    const html = render("\n\n   \n");
    expect(html).not.toContain("<p ");
  });

  test("an unterminated marker is left as literal text", () => {
    const html = render("**not closed");
    expect(html).not.toContain("<strong");
    expect(html).toContain("**not closed");
  });
});
