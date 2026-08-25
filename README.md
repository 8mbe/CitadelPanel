# CitadelPanel

A web panel for running game servers. You install it on your own machine, add
the machines that will host the games, and then you and your users get a browser
UI for the whole thing: a live console, a file manager, databases, backups,
ports, and per-server access for other people.

> **Beta.** This is the first public release. It works end to end and it has
> tests, but it has not been through a long production shakedown. Read
> [Beta status](#beta-status) before you put paying users on it.

## Navigation

- [What it is](#what-it-is)
- [Why this panel](#why-this-panel)
- [What runs on it today](#what-runs-on-it-today)
- [Features](#features)
  - [For the person who owns a server](#for-the-person-who-owns-a-server)
  - [For the operator (admin)](#for-the-operator-admin)
  - [Security](#security)
- [How it is built](#how-it-is-built)
- [Requirements](#requirements)
- [Install with Docker](#install-with-docker)
- [Add more machines](#add-more-machines)
- [Install locally with Bun](#install-locally-with-bun)
- [Turn on databases for a machine](#turn-on-databases-for-a-machine)
- [First run](#first-run)
- [Configuration](#configuration)
- [Commands](#commands)
- [Documentation](#documentation)
- [Beta status](#beta-status)
- [Locked out?](#locked-out)
- [Contributing](#contributing)

## What it is

CitadelPanel has two parts.

The **panel** is the website. It holds the accounts, the database, the audit log,
and every screen you click. It is the only part the internet talks to.

The **agent** is a small service you install on each machine that runs games. It
talks to Docker on that machine and does the actual work: build the container,
start it, read the files, take the backup. It has no accounts and no database of
its own. The panel is its only caller.

You can run both on one machine to start with, then add more machines later
without changing anything about the panel.

## Why this panel

**Every game server is a container, and the container is described by a file you
can edit.** A "blueprint" is one JSON document: the image, the ports, the
environment fields the user gets to fill in, the install step, the resource
floor. Three blueprints ship with the panel. You can write a fourth in the admin
UI, or paste a JSON file, without touching the code or rebuilding anything.

**Nobody picks a port number.** Each machine gets a pool of ports. When a server
is created the panel picks a free one at random and maps host port N to
container port N, on TCP and UDP together, so the number the player types is the
number the game listens on. If the owner wants a second port for a mod, they
press a button.

**The console is a real terminal, not a log tail.** The browser opens a
WebSocket straight to the agent, so the panel is not sitting in the middle
holding a connection open for every viewer. Commands go up the same socket.
Every command is still written to the audit log, because the agent calls the
panel back to check the token and record it.

**Sharing a server does not mean handing over the password.** You invite another
panel account to your server and tick the boxes you want them to have: console,
start and stop, files, database, settings, backups. Deleting the server and
managing the other guests stay with the owner, always, whatever boxes are
ticked.

**A hacked game server should not become a hacked machine.** Containers run with
dropped capabilities, no new privileges, a read-only root where the image allows
it, and memory and CPU caps. On top of that you can turn on user-namespace
remapping, swap the container runtime for gVisor or Kata, and install a firewall
rule that stops a container reaching the host. The panel also watches for
cryptominers and puts suspicious servers in a review queue instead of silently
killing them.

**Secrets are encrypted where they sit.** Agent tokens, database passwords, and
any environment value marked secret are encrypted in PostgreSQL with a key
derived from one panel secret. Nothing privileged happens without a row in the
audit log.

## What runs on it today

| Blueprint | What it is |
| --- | --- |
| Minecraft: Java Edition | Vanilla, Paper, Fabric and friends, with plugin or mod support where the flavour has it |
| Minecraft: Bedrock Edition | The console and mobile edition |
| Velocity | The Minecraft proxy, wired to your other servers |

Anything else is a blueprint away. If the game runs in a Docker image and talks
on a port, the panel can run it. See [docs/plugins.md](docs/plugins.md) for how
a blueprint declares plugin support and [the admin blueprint
screen](docs/first-time-setup.md) for import and export.

## Features

### For the person who owns a server

- **Console.** Live output and a command line, straight from the browser to the
  machine. Start, stop, restart, kill. ([docs](docs/direct-console.md))
- **AI help.** If the operator has set up an AI provider, a button reads your
  recent console output and tells you what broke. Hidden when it is not set up.
  ([docs](docs/ai-helper.md))
- **Files.** Browse, upload, download, rename, copy, delete, make folders, pull
  a file from a URL, and download a whole folder as a zip. Everything is locked
  to your server's own folder.
- **Code editor.** Click a file and it opens in Monaco, the editor from VS Code,
  with syntax colours that match the panel theme. ([docs](docs/file-editor.md))
- **SFTP.** Make a login from the Files tab and use FileZilla, WinSCP, or plain
  `sftp`. Each login is tied to one person and one server, and the session
  cannot leave that server's folder. ([docs](docs/sftp.md))
- **Plugins and mods.** For blueprints that support it, search a provider such
  as Modrinth, install with one click, and have the panel update everything
  right before the server starts. ([docs](docs/plugins.md))
- **Databases.** Create a MySQL database for your server. You get the host, the
  user, and the password once. ([docs](docs/database-explorer.md))
- **Database browser.** Look at tables and rows, edit them, add columns, without
  installing a SQL client. ([docs](docs/database-explorer.md))
- **Backups.** Take a snapshot of your files, list what you have, restore one.
  Old snapshots roll off on their own. ([docs](docs/backups.md))
- **Ports.** See what you have, add another one, remove it.
  ([docs](docs/ports.md))
- **Connect servers.** Point one of your servers at another by name, on the same
  machine or across machines. This is how a proxy finds its backends.
  ([docs](docs/server-links.md))
- **Subusers.** Invite someone and pick what they can touch.
  ([docs](docs/subusers.md))
- **Activity.** A feed of what happened on this server and who did it.
- **Settings.** Environment variables, resource use, and a reinstall button.
  ([docs](docs/server-lifecycle.md))

### For the operator (admin)

- **Setup wizard.** Six screens on first boot: admin account, panel name and
  timezone, who may register, email, the first machine, and the first server.
  It ends with a server that is actually running, not an empty panel.
  ([docs](docs/first-time-setup.md))
- **Machines.** Register a machine with its address and token, test the
  connection before you save, see CPU and memory in use, hand it a port range,
  and hold back a slice of the hardware for the operating system.
- **Servers.** Create a server for any user, change its resource limits,
  suspend it, delete it.
- **Users.** Change a role, ban an account, look at what someone owns.
- **Blueprints.** Write a new one in a form, import one from JSON, export any of
  them. The three built-ins are defined in code and stay read-only, so to change
  one you export it, edit the file, and import it back as your own.
- **Backups.** One S3 bucket, two kinds of snapshot: a server's files, taken by
  its owner, and a dump of every database on a machine, taken by you. Schedules,
  a cap on how many snapshots to keep, and a storage budget.
  ([docs](docs/backups.md))
- **Security queue.** Servers the abuse watcher thinks are mining crypto, with
  the numbers behind the score, so you decide instead of a script.
- **Audit log.** Every privileged action, filterable, including actions taken
  with an API key.
- **API keys.** Mint a key and drive the same `/api/*` endpoints the browser
  uses. A key can do exactly what its owner can do, no more. Admins can see and
  revoke every key in the panel. ([docs](docs/api-keys.md))
- **Branding.** The panel's name, its tagline, its colour. The site theme is
  yours; users can still pick plain light or plain dark.
  ([docs](docs/theming.md))
- **Signups, captcha, email.** Turn registration off, put a captcha in front of
  the credential forms, point the panel at your SMTP server for verification and
  password resets. ([docs](docs/site-settings.md))
- **SEO and analytics.** `robots.txt`, `sitemap.xml`, and an optional Plausible
  or Google Analytics tag. Indexing is off until you turn it on.
  ([docs](docs/site-settings.md))
- **Legal pages.** Write your terms and privacy policy in Markdown. The panel
  ships drafts, including a list of what this codebase actually stores, and
  publishes nothing until you save. ([docs](docs/legal-pages.md))
- **Limits.** Cap how many extra ports and how many databases a server owner can
  give themselves.

### Security

- Two roles only, `user` and `admin`. Subuser flags are the only way to
  delegate, and no flag can reach past one server.
- The API is the boundary, not the UI. A user with no claim on a server gets a
  404, because telling them the server exists is already a leak.
- Passwords, sessions, two-factor codes and email verification come from Better
  Auth. Two-factor is TOTP with an authenticator app, plus one-time codes by
  email when mail is set up, plus backup codes.
- Agent tokens, node database passwords and secret environment values are
  encrypted at rest with AES-256-GCM.
- The browser never learns a machine's address or token. The console is the one
  exception, and it uses a short-lived single-use token instead.
- File paths resolve through one function that catches `..` and symlink escapes,
  and it has its own tests.
- Machine hardening is documented down to the residual risks that are still
  there on purpose. ([docs](docs/node-hardening.md))

## How it is built

| Part | Stack |
| --- | --- |
| Panel | Next.js 16, React 19, Tailwind v4, shadcn on Base UI, Better Auth, PostgreSQL 17 |
| Agent | Bun, dockerode, ssh2 |
| Runtime | Bun everywhere, one workspace, TypeScript throughout |

The panel has one API route that dispatches to modules in
`apps/frontend/lib/server/control-plane/`. It is not a proxy in front of a
second backend. The agent is the second service, and only the panel calls it.

## Requirements

For the machine that runs the panel:

- Docker and the compose plugin, or Bun 1.2+ and a PostgreSQL 17 you already
  have
- A hostname or IP the browser can reach

For every machine that runs games:

- Docker, with the agent allowed to use its socket
- A private path to the panel. The agent's port must never face the internet
  without TLS and a firewall in front of it.

## Install with Docker

This brings up PostgreSQL, the panel, and one agent on the same machine.

```bash
git clone git@github.com:8mbe/CitadelPanel.git
cd CitadelPanel

# Write .env with generated secrets. Needs Bun on the host.
bun run env:init
# No Bun? cp .env.example .env and fill in the three secrets by hand:
#   openssl rand -base64 48

docker compose up -d --build
```

Then open <http://localhost:3000> and the setup wizard takes over.

Two things worth knowing. Secrets are generated on the host because compose
needs them before any container exists, so a container cannot make them for
itself. Database migrations run inside the panel container on every boot and
they are safe to repeat, so a fresh install and an upgrade are the same command.
The reasoning is in [docs/docker.md](docs/docker.md).

**Put a firewall in front of the panel until you have claimed the admin
account.** Whoever loads it first becomes admin.

## Add more machines

`docker-compose.agent.yml` is the agent on its own. Copy it and the repo to the
new machine:

```bash
# on the new machine
cd CitadelPanel
printf 'AGENT_TOKEN=%s\nPANEL_URL=https://panel.example.com\n' \
  "$(openssl rand -base64 48)" > .env

docker compose -f docker-compose.agent.yml up -d --build
```

Then register it in the panel under **Admin, Nodes**. Paste the same token, test
the connection, and give it a port range.

Use a different `AGENT_TOKEN` for every machine. The token is root on that
machine, so one leak should not cost you the fleet. If browsers will reach the
console directly over HTTPS, the agent needs TLS too, because a browser will not
open a plain `ws://` socket from an `https://` page.

## Install locally with Bun

For development, or if you would rather run PostgreSQL yourself.

```bash
git clone git@github.com:8mbe/CitadelPanel.git
cd CitadelPanel
bun install

# Interactive. Writes .env, generates missing secrets, runs the migrations.
bun run setup
# Unattended: bun run setup -- --yes
```

You need a PostgreSQL 17 reachable at the `DATABASE_URL` the setup step asks
about, and Docker on the same machine if you want the local agent to actually
build anything.

Two terminals:

```bash
bun run dev:backend    # the agent, on :8081
bun run dev:frontend   # the panel, on :3000
```

Open <http://localhost:3000>.

If the agent complains that it cannot reach the Docker socket, your login
session is probably older than your membership in the `docker` group. Start it
from `newgrp docker`, or log out and back in.

## Turn on databases for a machine

Databases are opt-in per machine. On the machine that will host them:

```bash
bun run setup-db
```

That creates a private Docker network and a MariaDB container on it, with no
ports published to the host, and prints the four values you paste into the
machine's registration form in the panel. It is safe to run twice. Details in
[docs/database-explorer.md](docs/database-explorer.md).

## First run

The wizard is six screens and it remembers where you stopped.

1. **Admin account.** The first account. There is no default password anywhere
   in this codebase.
2. **Panel identity.** Name and timezone, both pre-filled.
3. **Access.** Who may register, and whether a captcha guards the forms.
4. **Email.** SMTP, so password resets and verification work.
5. **First machine.** Address, token, port range. You cannot leave this screen
   without reserving a range, because a machine with no ports cannot host
   anything.
6. **First server.** Pick a blueprint, and the wizard builds it and starts it
   while you watch.

Steps 3 through 6 are skippable. The last screen lists every setting the wizard
did not ask about, with a link to each, so nothing is hidden from you.

Full reasoning, including why only four settings groups are worth interrupting
an operator for, is in
[docs/first-time-setup.md](docs/first-time-setup.md).

## Configuration

`.env.example` documents every variable with a comment on what it is for.
`.env` is gitignored and must stay that way.

The three that matter most:

| Variable | What it is |
| --- | --- |
| `PANEL_ENCRYPTION_KEY` | Encrypts agent tokens, database passwords and secret env values. Rotating it makes everything already encrypted unreadable. |
| `BETTER_AUTH_SECRET` | Signs sessions and cookies. |
| `AGENT_TOKEN` | What the panel shows an agent. Root on that machine. One per machine. |

All three need 32 characters or more. Generate them with
`openssl rand -base64 48`.

Most day-to-day settings are not in `.env` at all. Branding, registration,
captcha, mail, backups, the AI provider, the theme, the limits and the legal
pages live in the database and change without a restart.

## Commands

Run these from the repo root.

| Command | What it does |
| --- | --- |
| `bun run setup` | Write or repair `.env`, then migrate |
| `bun run env:init` | Only write `.env` |
| `bun run migrate` | Only run the migrations |
| `bun run dev:frontend` | The panel, on :3000 |
| `bun run dev:backend` | The agent, on :8081 |
| `bun run setup-db` | Set up the shared database on this machine |
| `bun run test` | Agent unit tests |
| `bun run test:e2e` | End-to-end tests against a running panel, using two API keys from `.env.e2e` |
| `bun run typecheck` | TypeScript across both apps |
| `bun run rescue` | Out-of-band recovery, see below |
| `bun run compose:up` | `docker compose up -d --build` |
| `bun run compose:down` | `docker compose down` |

## Documentation

`docs/` is the real answer to "how does this work". Each file covers one feature
from end to end: the flow, the security model, the configuration, and the
decisions that would otherwise look strange.

| Doc | Subject |
| --- | --- |
| [first-time-setup.md](docs/first-time-setup.md) | The wizard and the latch that closes it |
| [docker.md](docs/docker.md) | Two images, two compose files, where setup happens |
| [server-lifecycle.md](docs/server-lifecycle.md) | Building, power actions, status, recovery |
| [direct-console.md](docs/direct-console.md) | Browser to agent WebSocket, capability tokens |
| [sftp.md](docs/sftp.md) | Per-person, per-server SFTP logins |
| [file-editor.md](docs/file-editor.md) | Monaco in the panel |
| [ports.md](docs/ports.md) | Port pools, identity mapping, TCP and UDP |
| [server-links.md](docs/server-links.md) | Connecting one server to another |
| [velocity-proxy.md](docs/velocity-proxy.md) | The proxy blueprint |
| [plugins.md](docs/plugins.md) | Plugin and mod support, the fetch engine |
| [database-explorer.md](docs/database-explorer.md) | Provisioned databases and the browser |
| [backups.md](docs/backups.md) | restic to S3, the two scopes, the quota |
| [subusers.md](docs/subusers.md) | The permission flags and what they gate |
| [api-keys.md](docs/api-keys.md) | Programmatic access and admin oversight |
| [ai-helper.md](docs/ai-helper.md) | The console assistant |
| [site-settings.md](docs/site-settings.md) | Branding, registration, SEO, analytics |
| [theming.md](docs/theming.md) | Three themes, one of them yours |
| [legal-pages.md](docs/legal-pages.md) | Terms and privacy |
| [node-hardening.md](docs/node-hardening.md) | Keeping a bad server off the machine |
| [performance.md](docs/performance.md) | The two costs that dominate a request |

## Beta status

What this means in practice.

**Tested, but not weathered.** There are 35 unit test files next to the code
they cover, plus an end-to-end suite that drives the real API for setup,
servers, files, console, plugins, databases, subusers, API keys, blueprints,
machines and site settings. What none of that gives you is a year of somebody
else's traffic. Expect rough edges in the places tests do not reach: odd
browsers, slow networks, a machine that dies halfway through a build.

**Three blueprints ship.** Minecraft Java, Minecraft Bedrock, and Velocity. The
blueprint format is the extension point and it is documented, but you are early,
so you will be writing your own for anything else.

**Things it does not do yet.** Moving a server between machines. A general task
scheduler, beyond backup schedules. Billing, and there are no plans for it. A
one-line installer script.

**Upgrades.** Migrations are versioned and idempotent, so pulling a new image
and restarting is the upgrade. Take a backup first anyway.

**Before you point real users at it:** put the panel behind TLS, keep every
agent port off the public internet, use a separate `AGENT_TOKEN` per machine,
store `PANEL_ENCRYPTION_KEY` somewhere you will still have it after a disk
failure, and read [docs/node-hardening.md](docs/node-hardening.md) start to
finish.

Bug reports and blueprints for other games are the two most useful things you
can send.

## Locked out?

`bun run rescue` works without the web server and without a session. Two things
it can do:

```bash
bun run rescue reset-password --email admin@example.com
bun run rescue disable-captcha
```

The first sets a password directly and kills every session that account holds.
The second turns a broken captcha off while keeping its keys, for when a
misconfigured widget is refusing every sign-in.

## Contributing

Read the doc for a feature before you change it, and update or add a doc when
you change one. Keep the visual language as it is: the components in
`components/ui/`, the colour tokens in `app/globals.css`, no raw hex anywhere.
Tests live next to the code they test. Run `bun run typecheck` and `bun run
test` before you open a pull request.

Repository: <https://github.com/8mbe/CitadelPanel>
