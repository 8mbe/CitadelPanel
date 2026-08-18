# AI console helper

A server-side AI assistant that reads a server's recent console output and
helps the user diagnose what went wrong. The admin configures an
OpenAI-compatible endpoint once; every server console then gets a helper
button. When AI is not configured, the button is hidden — users never see a
feature the operator has not turned on.

## Admin configuration

Stored in `panel_settings` under the `ai` key (migration `019_ai_settings.sql`),
mirroring the captcha/mail pattern: a runtime knob, with the API key
AES-256-GCM encrypted at rest before it is written (`lib/crypto`). The admin
settings page (`components/admin/general-settings.tsx`, `AiCard`) exposes:

- **API URL** — the OpenAI-compatible base URL (e.g. `https://api.openai.com/v1`).
  The panel appends `/models` and `/chat/completions`.
- **API key** — write-only, like every secret in the settings table: the form
  never round-trips it, and "leave blank to keep unchanged" is the only way to
  keep an already-stored key.
- **Fetch models** button — calls the provider's `/models` endpoint with the
  form's current URL+key (or the stored config when a field is blank) and
  populates a select. Lets an operator probe a provider *before* saving it.
- **Test** button — sends a trivial ping and waits for the reply, so the
  operator can confirm the round trip works (URL reachable, key valid, model
  answering) before relying on it.
- **Enable** switch — gates whether the console helper button is shown at all.
  `enabled` is reported false unless the config is actually usable (URL + key +
  model all present), so a half-entered provider is never treated as "AI is on".

The fetch-models and test routes (`POST /api/admin/settings/ai/models`,
`POST /api/admin/settings/ai/test`) accept the form's current values and fall
back to stored config when a field is omitted — the natural flow is type →
fetch → pick → test → save. The decrypted API key lives only inside the
request; it is never returned to the browser.

## The console helper flow

`POST /api/servers/:id/ai-helper` is the user-facing endpoint. It gates on the
`console` permission (a subuser with console access can use it). The browser
sends only `{ message: string }` — the free-text question. **Everything else is
gathered server-side**:

1. The route loads the server row (name, blueprint, node, container).
2. It resolves the blueprint (human name + key) for the game.
3. It loads the non-secret environment (`server_env` where `is_secret = false`),
   which includes the game version (`VERSION`) when it is a non-secret var.
4. It pulls the last ~200 console lines from the node agent's logs endpoint
   (`getServerLogs`), best-effort: a node being unreachable yields an empty tail
   rather than a failed call, because the user is often asking about exactly
   that — a server that won't start — and the env/blueprint context is still
   useful.
5. The panel composes a system prompt from that context and the user's message,
   and calls the provider's `/chat/completions` endpoint (`services/aiClient.ts`).
6. The reply is returned to the browser as `{ reply: string }`.

The call is audited as `server.ai.helper` with metadata recording only the
**lengths** of the question and the gathered logs (never their contents, which
may include server output the operator would rather not persist in the audit
trail) plus the model used.

## Security model

- **The prompt is panel-composed, never browser-supplied.** This is the same
  posture the database explorer takes with SQL (`docs/database-explorer.md`):
  the browser only supplies the free-text question, and the panel assembles the
  full context. A hostile client cannot redirect the model with injected
  context (prompt injection is bounded — the user's message is the *only*
  client-controlled input, appended as a single user turn after a system prompt
  the client never shaped).
- **The API key never reaches the browser.** It is stored encrypted, decrypted
  only inside the server-side request, and the public view reports only
  `hasApiKey: boolean`. Even the admin settings form never reads it back.
- **The provider URL is admin-trusted.** Like the node API URL and the SMTP
  host, the AI endpoint is configured by an admin (root-equivalent); there is no
  SSRF guardrail on it, because the operator is the trust boundary.
- **Inputs are bounded.** The user's message is capped at 2000 characters; the
  log tail at 200 lines; the provider calls have 15s (models) / 60s (chat)
  timeouts. A slow provider yields a readable error, not a hung request.

## Where things live

| Concern | File |
|---|---|
| Admin settings card | `components/admin/general-settings.tsx` (`AiCard`) |
| Settings service (stored/public/set) | `lib/server/control-plane/services/settings.ts` (AI section) |
| OpenAI-compatible client | `lib/server/control-plane/services/aiClient.ts` |
| Admin routes (models/test) | `lib/server/control-plane/routes/setup.ts` (`handleFetchAiModels`, `handleTestAi`) |
| User-facing route | `lib/server/control-plane/routes/aiHelper.ts` (`handleServerAiHelper`) |
| Console dialog | `components/server/console-helper-dialog.tsx` |
| Console button | `components/server/console-panel.tsx` (reads `ai.enabled` from public settings) |
| Client API | `lib/api.ts` (`fetchAiModels`, `testAi`, `requestConsoleAiHelper`) |
| Migration | `lib/server/control-plane/db/migrations/019_ai_settings.sql` |

## Why the public-settings flag

The console panel fetches `/api/settings/public` once on mount and reads
`ai.enabled`. That endpoint is already cached server-side (10s TTL) and used by
the login page for the captcha site key, so it is a cheap, single round-trip
that does not need a dedicated AI-status route. Only the boolean is exposed —
no URL, key, or model — so an unauthenticated page can decide whether to show
the button without leaking configuration.
