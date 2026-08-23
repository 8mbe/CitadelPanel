# Legal pages: terms of service and privacy policy

Two operator-authored documents, written in Markdown at `/admin/legal` and served
publicly at `/terms` and `/privacy`. The panel supplies **drafts, not defaults**:
nothing is published until an admin saves.

## Why the panel ships no default text

A privacy policy is a legal statement about what a *specific* operator does with
a *specific* set of users' data. A plausible-looking default would be worse than
none: it would be wrong for most installs, and it would still look authoritative
enough that operators publish it unread.

What the software *can* honestly provide is an inventory of what its own code
stores. `lib/legal-templates.ts` holds that: `privacyPolicyTemplate(siteName)`
enumerates, section by section, the data this codebase actually persists:

- account fields (name, email, password hash, verified flag, role, encrypted 2FA
  secrets and backup codes, ban state)
- session records and their lifetime, API keys as hashes plus a display prefix,
  per-(user, server) SFTP credentials
- the audit log: which account, what action, what target, **the caller's IP**, the
  time, and bounded context such as the console command run
- suspicious-activity flags from the resource watcher
- per-server configuration and the files on the node, noting which values are
  encrypted at rest
- the third parties a given configuration reaches: mail provider, captcha
  provider, AI provider (which receives console output alongside the question),
  analytics provider

It also marks with `[TODO]` every place the software cannot know the answer:
hosting provider, backups, log shipping, retention periods, jurisdiction,
statutory rights, breach notification. The banner at the top of the draft says
plainly that it describes the application and not the deployment.

`termsOfServiceTemplate` is a much thinner skeleton by design. Terms are almost
entirely about the operator's own rules: acceptable use, pricing, uptime,
suspension, liability. The code knows nothing about those. Inventing clauses
would only produce something an operator might publish without reading.

**Keep the privacy draft in sync with the schema.** If a migration adds a table
holding personal data, that draft is where users are told about it.

## The editor

`components/admin/legal-editor.tsx` at `/admin/legal` is its own admin section,
not a card in general settings. These are thousand-word documents written over
several sittings and the one thing on the panel a lawyer might read; a four-row
textarea under the SMTP fields would guarantee nobody writes them properly.

It is the same CodeMirror editor the file manager uses
(`docs/file-editor.md`), lazy-loaded with `ssr: false`, with:

- a tab per document, badged **Empty** until written
- an optional side-by-side live preview using the same renderer the public page
  uses, so what the admin sees is what visitors get
- **Insert draft**, offered *only while the buffer is empty*, because it must
  never be able to overwrite text an admin has written
- dirty tracking (`content !== saved`, a comparison rather than a flag that has
  to be cleared in every branch), Ctrl/Cmd+S, and a character count
- **View page** once published

## Storage and routes

Both documents live under the single `legal` key in `panel_settings`:
`{ terms: { content, updatedAt }, privacy: { content, updatedAt } }`. Capped at
100,000 characters each so a paste cannot put an unbounded blob in the settings
table.

- `GET /api/admin/legal`: both documents' Markdown source (admin).
- `PUT /api/admin/legal/:document`: replaces one document (admin).

A whole-document replace rather than a patch, because the editor's buffer *is*
the document.

**An empty `content` means "not published".** The public route 404s, the footer
link disappears, the sitemap entry drops, and `updatedAt` is cleared rather than
left pointing at a revision nobody can read. Clearing the editor is the only way
to withdraw a document, and it is deliberately the same action as saving.

Writes are audited as `settings.legal.update`, recording the document key, its
length, and whether it is published, but **never the body**. An audit entry is a
different retention class from a published page; copying a full policy revision
into it would be a surprising place for that text to live.

## The public pages

`/terms` and `/privacy` (`components/legal-document-page.tsx`) are
**unauthenticated**. A privacy policy the reader must sign in to read is not a
privacy policy.

Each renders the Markdown, a "Last updated" line from the real save timestamp,
and the shared footer. `SiteFooter` takes the published state as a prop from a
server component rather than fetching it: a link that appears a beat after paint
is worse than no link, because it shifts the page just as the reader arrives at
the bottom of it.

## Markdown rendering

`components/markdown.tsx` is a small in-repo renderer, not a library, for two
reasons:

1. **No `dangerouslySetInnerHTML`.** It emits React nodes, so there is no HTML
   string for a `<script>` or an `onerror=` attribute to ride in on. The author is
   an admin, but "the admin is trusted" is a weak place to put the only barrier
   between a settings field and script execution, and these pages are served to
   anonymous visitors.
2. **The supported syntax is the point.** Legal documents need headings,
   paragraphs, blockquotes, flat lists, rules, emphasis, inline code, and links.
   They do not need tables, images, footnotes, or embedded HTML, and every
   construct left out is one fewer thing to get wrong.

Link targets are restricted to `http:`, `https:`, `mailto:`, and site-relative
paths and fragments. Protocol-relative `//host` is rejected too (it is an absolute
URL in disguise). An unsupported scheme degrades to the link's visible label
rather than rendering the raw URL as text.

The parser is line-oriented: a blank line ends a block, consecutive lines inside
a paragraph or list item join with a space so hard-wrapped source reflows rather
than breaking mid-sentence, and a change of list marker starts a new list rather
than mixing ordered and unordered items.

## Related

- `docs/site-settings.md`: branding, SEO, and the analytics toggle whose
  consent implications the privacy policy has to cover.
- `docs/file-editor.md`: the CodeMirror setup and CSS-variable theming this
  editor reuses.
