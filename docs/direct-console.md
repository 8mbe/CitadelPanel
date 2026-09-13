# Direct console (browser → agent WebSocket)

The live server console opens a **WebSocket straight from the browser to the
node agent**. The panel is not in the data path. This keeps the panel from
holding an open connection per viewer and gives the console true bidirectional
I/O (output + command input over one socket).

## How it works (capability-token flow)

A browser cannot set headers on a WebSocket handshake, so it can't present the
agent's long-lived bearer token. Instead the panel mints a **short-lived,
single-use capability token** and gets out of the way:

1. The browser requests a console session: `POST /api/servers/:id/console/session`.
   The panel checks the caller's `console` permission, mints a random UUID
   token, stores a `console_sessions` row (server, user, node, 60s expiry), and
   returns `{ token, url }`, a `wss://` URL pointing at the agent.
2. The browser opens `new WebSocket(url)`. The URL path carries the token
   (`/v1/sessions/:token/console`); browsers can't set handshake headers, so the
   token rides the path (it's single-use and short-lived, unlike the agent
   bearer which is never put in a URL).
3. The agent validates the token by calling the panel back
   (`POST /api/internal/console/sessions/validate`). The panel authenticates the
   agent by its long-lived bearer (reverse-looked-up to a node), atomically marks
   the token consumed (so a replayed token can't open a second console), and
   returns the `serverId`/`userId`. The agent then attaches to the container,
   replays the last 100 log lines, and signals `ready`.
4. Each command the user types is sent over the socket as `{type:"input"}`. The
   agent writes it to the container's stdin **and** fire-and-forgets an audit
   callback (`POST /api/internal/console/audit`). The panel resolves the user
   from the session token (never trusting an agent-supplied userId) and writes
   the `server.console.command` audit row, so the audit trail is preserved even
   though input no longer transits the panel.

The agent stays **stateless**: it pulls validation per-connection rather than
holding a session map. Postgres (`console_sessions`) is the source of truth,
which gives instant revocation and survives agent restarts.

## When the attach fails

An attach that never gets off the ground is reported to the browser as
`{type:"error", message, code?}` and then the socket closes. A console that
silently shows nothing is worse than one that says why. The optional `code` is
the machine-readable half of the agent's `HttpError`: the message is written
for a human, the code is what the browser branches on, so its handling does not
depend on matching an English sentence (and an older agent that sends no code
just falls back to printing the message).

The one code so far is **`no_container`**: the node has no container for this
server. The console renders that as *"Please wait, rebuilding container…"*
rather than the agent's Docker fact, because it is a state the panel repairs.
The next power action rebuilds the container from the stored spec (see
[server-lifecycle.md](server-lifecycle.md)), and the console's own reconnect
loop attaches to the new container when it comes up, with no page reload.

## Requirements

- **The agent must be browser-reachable** at a `wss://` (or `ws://`) URL. In the
  bundled `docker-compose.yml` the agent publishes port 8081; on a remote node
  use `docker-compose.agent.yml`.
- **TLS when the panel is HTTPS.** Browsers block `ws://` from an `https://` page
  as mixed content. Set `AGENT_TLS_CERT` + `AGENT_TLS_KEY` on the agent, or put
  it behind a TLS-terminating reverse proxy (Caddy/Nginx) and point the node's
  Console URL at the proxy.
- **`PANEL_URL`** must be set on the agent. It is the base URL the agent calls
  back to for validate/audit. Without it the agent refuses direct-console
  connections (503).

## Node configuration

Each node has two relevant URL fields:

- **Agent URL** (`api_url`): the panel→agent address. Keep this on a private
  network; the panel uses it for all lifecycle calls.
- **Console URL** (`console_url`, optional): the browser→agent address for the
  direct console. When blank, the panel derives `wss://`/`ws://` from the Agent
  URL's scheme (the zero-config homelab case, where the agent is already on the
  LAN). Set it to the public `wss://` address when the agent is behind a reverse
  proxy on a different host/port than the Agent URL.

If the panel is HTTPS and the derived/supplied console URL is `ws://` (no TLS),
the session-mint endpoint returns a clear error instead of handing the browser a
URL that would fail silently.

## The panel-proxied fallback

Everything above needs one thing the panel cannot provide for the node: an
address the **browser** can open a socket to. Two ordinary deployments have no
such address at all.

- The agent is published only on the panel's own Docker network
  (`api_url: http://backend:8081`, which is what the bundled compose produces).
  The hostname does not resolve outside the network, so there is nothing to
  point a browser at.
- The agent has no TLS certificate and the panel is HTTPS, which is the
  mixed-content refusal above.

In both the direct console is not "misconfigured", it is *unavailable*, and the
console falls back to streaming through the panel:

- **Output**: `GET /api/servers/:id/console/stream`, a Server-Sent Events route
  that proxies the agent's own `GET /v1/servers/:id/logs/stream`. Chunks are
  forwarded as they arrive, never accumulated, so a log line reaches the browser
  when the container writes it. It is push, like the socket — not polling.
- **Input**: the pre-existing `POST /api/servers/:id/command`. SSE is
  one-directional, so a typed command is its own request. It checks the same
  `console` permission and writes the same `server.console.command` audit row.

This *inverts* the trade the direct socket exists to make: the panel is back in
the data path and holds one upstream connection per viewer. That cost is
accepted only where the alternative is no console at all, which is why it is a
fallback rather than the default. Attribution, on the other hand, gets simpler:
the command transits the panel, so nothing has to be resolved from a capability
token handed to an agent.

### How the console chooses

The browser never has to be told which transport to use, because the panel
cannot always know either — whether a `wss://` URL actually works is a fact only
the browser can discover. So the client tries the socket and demotes itself:

- A **4xx from the mint** is a verdict, not a hiccup (the panel has already
  concluded there is no usable address), so it switches immediately. A 5xx or a
  network failure is transient and just backs off.
- A socket that **opens and dies without ever reaching `ready`**, twice in a
  row, means the URL does not work from this browser. The mint succeeded, so the
  panel believes the node is reachable; the browser is told nothing beyond the
  close, so counting silent failures is the only signal available. One failure
  proves nothing (an agent restarting does that), which is why it takes two.

The decision is sticky for the life of the console view: a reconnect does not
re-probe a node already known to be unreachable.

### One protocol, two wire formats

The two transports carry the same logical frames, but not the same bytes, and
the client bridges the difference:

- Over the WebSocket, *everything* is JSON (`ready`, `output`, `closed`,
  `error`).
- Over SSE, a log line is a **nameless** event whose data is the raw line, with
  no JSON wrapper (that is what `sseWrap` emits). Only the out-of-band frames
  are **named** events carrying JSON: the agent's `console` error frame, and the
  `ready` frame the panel prepends to hand over the blueprint's `tty` flag —
  the one piece of state the socket path gets from the session mint. A nameless
  ready frame would be appended to the console as literal JSON text, which is
  why it is named.

### Keeping it instant

A proxied stream passes through more hops than a socket, and every one of them
would rather buffer. The stream route sets `cache-control: no-transform` (a
proxy that gzips would hold bytes until its window fills),
`x-accel-buffering: no` (nginx buffers proxied responses by default; Caddy and
Traefik honour the same header) and `connection: keep-alive`. The agent sets the
same headers on its own response — they are repeated because panel→browser is a
different connection through different proxies than agent→panel. The agent's
`: ping` comment every few seconds of silence keeps both hops from idling out.

Cancellation propagates the whole way: closing the console tab aborts the
EventSource, which aborts the panel's route handler, whose `request.signal` is
forwarded to the agent, which forwards it to dockerode. No leaked attach at any
hop.

## Security notes

- The long-lived `AGENT_TOKEN` still guards **every** agent lifecycle route. The
  *only* path whose auth changes is `/v1/sessions/:token/console`, gated by the
  single-use, 60s-TTL capability token.
- A token is bound to the node it was minted for: node Y cannot validate or audit
  a token minted for node X.
- Revoking a session (`console_sessions.revoked_at`) blocks new upgrades and new
  audit writes, but does **not** sever an already-open socket (fully killing a
  live session would require a panel→agent push, which the stateless agent
  design avoids). A future enhancement could add that push. The browser revokes
  proactively on a genuine page-leave (`pagehide` or component unmount) via
  `POST /api/servers/:id/console/revoke`, so a token left in a closed tab can't
  be replayed; a transient WebSocket drop (lag) reconnects without revoking,
  since the user is still on the page.
- A dropped audit callback (network partition between agent and panel) leaves a
  command unaudited. Fire-and-forget matches the panel's own "audit must never
  break the operation" posture. Monitor panel reachability from agents.
