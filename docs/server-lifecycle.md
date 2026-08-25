# Server lifecycle

What happens between "the server exists as a row" and "the game is running":
how a server is built on its node after the create request has already answered,
the power actions, the status the panel stores, how the panel recovers when its
record of a container and the node's reality drift apart, and how an owner throws
the whole thing away and starts again.

## Status is a record, the node is the truth

`servers.status` is what the panel last observed or intended
(`creating`, `installing`, `stopped`, `starting`, `running`, `stopping`,
`suspended`, `error`, `deleting`). It is written before the node is asked to do
anything and corrected after. That is the ordering principle in
`services/serverManager.ts`: a DB row with no container is recoverable, a
container with no DB row is an orphan nobody can see.

Because the status is a record rather than an observation, it can be wrong: a
game that crashes on its own leaves `running` behind. `reconcileServerStatus`
is the correction. It asks the agent for the container's real state and maps
it back onto the stored status. Suspended servers are never reconciled away;
that state is an administrative decision, not an observation of the node.

## Provisioning happens after the response, not during it

Creating a server is two different jobs with two different failure modes, and
they used to share one HTTP request.

The first is deciding whether the server may exist: the blueprint is known, the
resources clear its minimums, the env validates, some node has the capacity and
can write its data root. All of that is fast, all of it is the caller's fault
when it fails, and all of it still happens inside `POST /api/admin/servers`.
A bad create is still a 400 or a 409 with nothing left behind.

The second is building it on the node: allocate ports, run the blueprint's
install script, create the container. Every step is a call to an agent whose
answers are slow for reasons that have nothing to do with whether the create was
valid. A node that has never run `itzg/mc-proxy` pulls a few hundred megabytes
before the install container can start; the install script then downloads a
server jar. Held inside the request, any timeout in the chain turned a working
provision into a 502 and a row parked in `error`. The chain includes the panel's
own per-call timeout, a reverse proxy's, and the browser's. The Velocity
blueprint is what made this unmissable: it is the first blueprint with both a
real install step and a large runtime image.

So `createServer` reserves the row and returns it in `creating`, and
`provisionServer` runs the second job detached from the request. The response is
a **202**: the record is real, the server is not there yet. The row is how the
task reports, through its status and its install log.

Two consequences worth stating:

- **The audit entry is written on reservation, not completion.** Creating the
  server is the admin's action and it happened. Whether the node then built it
  is the provision's story, told by the status.
- **The task is in-process and not durable.** A restart mid-install abandons it,
  so `failInterruptedProvisions` runs at boot and moves anything still
  `creating`/`installing` to `error` with a line in its log saying why. A row
  that claims to be installing with nobody working on it is worse than an honest
  failure. Nothing would ever move it again, since a server with no container
  is not reconciled.

The route also hands the task to Next's `after()`. The task is already running;
that call only stops the runtime from considering the request's work finished
when the response goes out.

### Starting it straight away: `startWhenBuilt`

A build normally ends with the server `stopped`, and somebody presses Start.
`POST /api/admin/servers` accepts `startWhenBuilt: true` to have the provision
carry on into a first start instead.

It is opt-in, and read with a strict `=== true`, because it is the wrong default
for ordinary provisioning: an admin building servers for other people should not
have them all boot and start consuming CPU the moment they exist. The setup
wizard is the only caller that sets it, because a wizard that ends on a
built-but-stopped container leaves the operator one manual step short of knowing
whether any of this works (see [first-time-setup.md](first-time-setup.md)).

Two things about how it is wired:

- **It runs on the server, not in the browser.** The wizard invites the operator
  to stop watching and finish setup, so a browser-side start would simply not
  happen for anyone who took the invitation. Because the start is inside the
  provision task, the `after()` handoff above keeps the runtime alive through it
  too.
- **It goes through `startServer`, not straight at the container.** The first
  start is therefore the same start as every other one: it runs the plugin
  auto-updater before the game process boots, and it records the `server.start`
  audit entry. Starting the container directly would skip both, and a privileged
  action missing from the audit log is exactly what must not happen.

A failed first start is reported as its own thing. It sits outside the block
that owns the build, writes `The server was built but did not start: …` to the
install log, and leaves the container on the node. That distinction is the point:
a build that failed left nothing to inspect and has to be reinstalled, while a
container that refused to boot is intact and retrying the start is the whole fix.

### A provision that loses its server

An admin can delete a server during the minutes a provision takes. Left alone,
the task would go on to create a container for a row that no longer exists.
That is the orphan the write-the-record-first ordering exists to avoid, and the
worst kind, because nothing in the panel can see it to clean it up.

So each step that creates something on the node re-checks that the row is still
there and still provisioning (`deleteServer` writes `deleting` before it touches
the node, so an in-flight delete is caught too). A provision that finds otherwise
stops without writing `error`. It did not fail, it was abandoned.

### Who the install container runs as

Not root. The agent pins it to the `uid:gid` that owns the server's data
directory, read off the directory itself rather than assumed.

An install container is hardened like every other one the agent creates, and
`CapDrop: ALL` takes `CAP_DAC_OVERRIDE` with it. That is the capability that
makes uid 0 the root which ignores permission bits, so without it a nominally
root install container gets plain "other" access to a data directory the agent
created as itself, and mode 0755 means its very first write fails with
`Permission denied`. It has no `CAP_CHOWN` either, so it cannot give away
what it does manage to write.

Both problems disappear if it simply starts as the owner. Blueprints then have
no ownership work to do at all: no `chown` they lack the capability for, and no
permissive `umask` widening the mode of every file to buy write access the
right uid already has.

The owner is read at install time rather than fixed at 1000 because it is a
per-node fact, whatever uid that node's agent runs as. This is the same
reasoning as a blueprint's `run_as` (`docs/` on blueprints, and migration
`007_blueprint_run_as.sql`), applied to the one container a blueprint does not
get to configure.

## The install log, and who reads it

The install container is removed the moment its script exits, so its output has
to be captured somewhere the next request can read it: `servers.install_log`,
appended to in SQL as the provision goes. It holds the script's output plus the
panel's own phase lines (`[panel] …`), which is what turns "a spinner for four
minutes" into "it is pulling the runtime image".

Reading it merges two sources, because neither is enough alone:

- the **row**, which has every line already recorded, and survives the process
  that wrote it;
- the **node**, which has the tail of a script running *right now*
  (`GET /v1/servers/:id/install/logs`, reading the still-live install container
  by its deterministic name).

The live tail is only requested while the row still says the server is being
provisioned. Once the install has finished its full output is in the row, and
asking the node again would either duplicate those lines or, more likely,
answer with nothing, the container having been cleaned up.

`GET /api/servers/:id/install-log` is **admin-only**. Not because the output is
secret in the usual sense, but because it is a script written by whoever
registered the blueprint: it can name an internal registry, echo an env value,
or print a node-side path. That is operator detail. The owner's question is
answered by the status.

### What the owner sees, and what an admin sees

While a server is provisioning it has no container, so every section of its page
is a page of errors waiting to happen. The console has nothing to attach to,
files has no game to write for, and ports and settings would be edited out from
under the provision still reading them.

So the shell locks it, the same way a suspended server is locked: the owner gets
one screen that says **"Server is installing…"** and nothing else. No progress
bar and no log, because neither would be honest. The panel cannot say how long
a pull will take.

An admin keeps the shell, with a banner, and their console shows the install log
in place of the live console. That is the whole point of the admin exemption:
when a provision goes wrong, reading that log is the job.

Both views update themselves. The page polls the server record while the status
is `creating` or `installing`, so a finished provision hands the owner their
server, and the admin their console back, without a reload.

## Env vars vs. the game's own config files

A blueprint's `envSchema` is the *whole* surface an owner may set: `resolveEnv`
drops unknown keys, and the env PATCH refuses any key the schema does not mark
`editable`. Which makes the schema a policy decision, not just a form: every
variable declared there is a setting the panel owns, and most game images write
their config file from those variables on every boot.

So a variable that maps onto a line in a config file the owner can also edit is
a trap. The file edit survives until the next restart and then silently
reverts, with nothing in the panel to explain it. The rule for new blueprints:
**if the owner edits it in the Files tab, do not declare it as env.** Declare
env for what the panel must control (the published port, see
[ports.md](ports.md)) or what the image only accepts as env (the EULA flag, the
server type, JVM flags).

`minecraft-java` is the worked example. `DIFFICULTY`, `MAX_PLAYERS` and
`ONLINE_MODE` used to be editable env, and the itzg image rewrote
`server.properties` from them on every boot; `ONLINE_MODE` also undid the
`online-mode=false` that Velocity's modern forwarding requires
([velocity-proxy.md](velocity-proxy.md)). They are gone from the schema, and
migration 022 drops the stored values from existing Java servers. The image
leaves a property alone when its variable is unset, so `server.properties` is
now the only place these three live, edited through the Files tab and the editor
([file-editor.md](file-editor.md)).

One caveat, because env is a *creation-time* fact for Docker: dropping the rows
does not touch containers that already exist. A container keeps the environment
it was created with until something recreates it: a port change, a link change,
a reinstall, or the heal above. `server_env` is the spec a recreate reads
(`loadEnvForContainer`), not something a restart re-applies, so an env edit on an
existing server lands whenever that server is next recreated. The PATCH
response's "takes effect the next time the server is restarted" is optimistic
about that.

## The power actions

`startServer`, `stopServer`, `killServer`, `restartServer` all follow the same
shape: load the row, refuse if suspended (start/restart only), refuse if the
row has no container at all, write the transitional status, call the agent,
write the settled status, audit. `server.kill` is audited distinctly from
`server.stop` so a destructive action is visible in the log.

Start and restart run the plugin auto-updater first, because plugins must be on
disk before the game process reads the directory. See
[plugins.md](plugins.md).

Restart writes `stopping` for the whole action even though it ends in `running`.
A restart *is* a stop with a start behind it, and the stop half is the half that
hangs; recording the transition is what makes it visible to a second tab or a
page loaded mid-restart, instead of only to the client that clicked the button.

### Kill, and why `stopping` outranks the node

Kill is the escape hatch for a shutdown that will not finish: SIGKILL, no grace
period, nothing saved. It takes the same `start_stop` permission as Stop, so
anyone who can stop a server can force-stop it, and it is audited as
`server.kill` rather than `server.stop` so the destructive path is legible in
the log.

The UI offers it by morphing Stop into a red Kill for exactly as long as the
status is `stopping`, whoever started that stop. Which makes the status the whole
mechanism, and the status had two ways of losing it:

- **Docker has no "shutting down" state.** From SIGTERM until the process
  actually exits, `docker inspect` reports `running`, so a reconcile that
  trusted the node turned every in-flight stop back into `running`, and the Kill
  button vanished mid-stop or never appeared on a page loaded during one. A
  `stopping` now outranks a node that says "still up". Its mirror image is
  `starting`, which the panel holds while the plugin auto-updater runs
  ([plugins.md](plugins.md)) and the container still sits there `exited`: each
  transition has exactly one observation it cannot be told apart from, and that
  observation is the one the reconcile ignores. Any *other* is real news and
  settles the status: exited means the stop finished, up means the start
  finished, gone is an error. The rule is a pure function in
  `statusReconcile.ts`, tested there.
- **Restart never recorded the transition at all**, so the client that clicked it
  saw Kill (from its own optimistic status) and nobody else did, including the
  same client after any refresh. Hence the `stopping` above.

Trust in a transition is bounded (`TRANSITION_TRUSTED_FOR_MS`): past it the node
wins again, so an action whose request died with the panel process cannot strand
a server in `stopping` for good. Sized off the longest power action, not off any
expected duration. Every one of them either settles its status or writes
`error` within its own timeouts, so the window is only a backstop.

The other half of making a transition visible is following it: the server page
re-reads the record every 2s while the status is `starting` or `stopping` (the
same poll that follows a provision, at a cadence that suits seconds rather than
minutes). Without it a page that opened during someone else's stop would keep
offering Kill for a server that had already gone down.

The button itself is live the moment it appears. It used to arm on a three-second
timer so the graceful path got "a fair chance", which reads well and works
badly: being *in* a stop already means the graceful path is underway, and a stop
that finishes in five seconds spends most of that window with its escape hatch
greyed out.

## When the container is gone from the node

The panel addresses containers by server id, but it also stores the container
id it created (`servers.container_id`), and that pointer can outlive the
container. A `docker rm` on the node, a prune, a rebuilt host, or a recreate
that removed the old container and then failed to build the new one all leave a
row that says "this server has a container" and a node that answers every
lifecycle call with the agent's

```
No container exists on this node for server <id>.
```

Nothing in the UI used to clear that: the only code path that creates a
container is provisioning, and provisioning already ran. The server was stuck
in `error` with no way back.

So every power action now runs through `withMissingContainerRecovery`. On a 404
from the node it asks the agent for the container's state, and if the answer is
`missing` it rebuilds the container from the stored spec
(`recreateServerContainer`) and retries the action once.

Two properties make this safe rather than clever:

- **Rebuilding is non-destructive.** The data directory belongs to the agent
  and outlives any container (`SERVER_DATA_ROOT`, see the backend's
  `paths.ts`), so the new container comes up on the world, config and logs the
  old one left behind. The recreate re-derives everything else from the
  database, the same thing that happens when an owner publishes a port
  ([ports.md](ports.md)): the image, env, resource limits, startup command,
  port bindings, and the DB and link networks.
- **The retry is idempotent.** Start on a freshly built container is the normal
  case; the agent's stop and kill both treat "not running" as success.

A 404 that is *not* a missing container (the state read says the container is
there) is re-thrown untouched, and a rebuild that fails replaces the 404 with
its own message, because that is the error worth reading. It says the node is
unreachable, or that the blueprint is no longer registered.

The stale pointer is also cleared at the source: `recreateServerContainer` sets
`container_id` to `NULL` as soon as the old container is removed, so a create
that fails halfway does not leave the row naming a container that no longer
exists.

## Deleting: the node has to confirm it

`deleteServer` writes `deleting`, detaches the server's links, asks the node to
remove the container (and, only when asked, the data directory), drops the
server's provisioned databases, and then deletes the row, cascading away its
ports, env, subusers and database records.

The step that used to be best-effort is the node's. An unreachable node was
logged and stepped over, and the row disappeared anyway. That is the orphan this
module's write-the-record-first ordering exists to prevent, arrived at from the
other end, and it is the worse half of the pair:

- the container **keeps running**, a deleted server that still serves players
  and still writes to a disk nobody is accounting for;
- it still holds its published host ports, which the panel has just returned to
  the node's pool and will hand to the next server that lands there
  ([ports.md](ports.md));
- and with the row gone, nothing in the panel can see any of it. Even the
  server id needed to ask the agent about it is gone.

So the node's confirmation is required. A failure aborts the delete: the status
goes back to what it was, the row stays, and the 502 says what is still on the
node and that a retry is the fix. Retrying costs nothing. The agent's delete
treats a missing container, a missing network and a missing directory as already
done, so a delete that failed halfway finishes on the second attempt.

Two things are deliberately still best-effort:

- **A row with no container** (`container_id IS NULL`, and no request to delete
  data). There is nothing on that node that can run or hold a port, so a dead
  node must not strand a failed provision as a row that cannot be deleted.
  Asking to delete the data is *not* exempt: the directory can exist even when
  the container never did.
- **The database drops.** They run after the container call has already
  succeeded, so a failure there is MariaDB's, not the node's, and what it leaves
  behind is data at rest rather than a running container.

### Forcing it, and the receipt

A node that is never coming back would otherwise leave rows that can never be
deleted, whether it is decommissioned hardware or a host that no longer exists.
`DELETE /api/servers/:id?force=true` is the way out, and it is **admin-only**:
an owner deleting their own server does not get to decide to leave a running
container on an operator's node. The UI does not offer it up front either; the
checkbox appears in the admin delete dialog only after a delete has actually
been refused.

A forced delete records what it abandoned in the `server.delete` audit entry,
and logs the same: the node id, the container id, and any databases it could not
drop. Once the row is gone that entry is the only thing that knows what is still
sitting on that node, and manual cleanup starts by reading it.

## Reinstalling: the rebuild that *is* destructive

`reinstallServer` is the deliberate opposite of the section above. The healing
rebuild keeps the data directory and replaces the container around it;
a reinstall deletes the directory and runs the blueprint's install step over the
empty space. Worlds, configs, plugin jars, logs and uploads are gone, with no
backup anywhere in the panel.

What it is *not* is delete-and-create-again, and the difference is the point. The
server keeps its row, so it keeps everything the row implies: its name, its
published ports and therefore its address, its env, its provisioned databases,
its subusers and SFTP credentials, its links to other servers. None of that lives
in the data directory. An owner reinstalling a broken modpack does not want their
players to have to change the address they connect to.

The order matters, and each step is what it is for a reason:

1. **Refuse early, synchronously.** Suspended, mid-delete, already building, no
   blueprint registered, no published ports. Every rejection happens before
   anything is destroyed, so a refused reinstall leaves the files intact. That
   includes `assertNodeReadyToProvision`: an agent that is down fails every step
   below, and finding that out *after* the wipe would leave the owner with
   neither their files nor a server.
2. **Stop the container**, best-effort, so the world is not half-written when it
   goes.
3. **Delete the container and the data directory** through
   `deleteServerContainer` with `deleteData: true`, the same agent call a
   delete-with-data uses. This is the one step here that is *not* best-effort:
   reinstalling on top of the old files is not what was asked for, so a failure
   has to stop the rebuild rather than quietly become a reinstall-in-place.
4. **Clear `container_id`, and the `server_plugins` rows.** The rows described
   jars that no longer exist; left behind they would read as "missing" in the
   plugins tab and be re-downloaded by the pre-start auto-updater, giving a
   fresh install that quietly restores the plugins it was asked to remove (see
   [plugins.md](plugins.md)).
5. **Run the install script**, with the server's *stored* env rather than the
   blueprint's defaults, so the script sees the published port and any key the
   owner has edited since creation.
6. **Recreate the container** through the same `recreateServerContainer` the
   healing path and the ports flow use, and leave it `stopped`. Nothing is
   auto-started: a freshly installed server is one the owner starts when they are
   ready for players on it.

Everything from step 2 on is detached from the request, for the same reason
provisioning is, and reports the same way, with `installing` status plus a
freshly emptied install log. It shares `inFlightProvisions` with the create
path, so a create and a reinstall can never run against the same server at once.
The owner therefore sees the exact screen a first install shows, and an admin
gets the install log in the console.

### Two confirmations, one of them in the API

`POST /api/servers/:id/reinstall` is owner-or-admin only, like delete and
unlike everything else in the settings tab. A subuser with `settings` can retune
the game and cannot erase it.

The body must carry `confirmName`, matching the server's name exactly, or the
request is a 400 that changes nothing. That is not decoration on top of the UI's
dialog; it is the rule the dialog implements. Every other destructive endpoint
here can be hit with an empty body, so a mis-routed retry, a stale tab replaying
a request, or a script iterating the wrong list can fire one. This one cannot be
reached without naming the server whose files are about to go.

The UI's two steps are deliberately different in kind, because two identical
"are you sure?" prompts are one reflex. The first is a page of consequences:
what is deleted, what is kept, and the suggestion to download anything wanted
from the file manager first. The second asks for a checkbox *and* the server's
name typed by hand.

The audit entry (`server.reinstall`) is written on acceptance, alongside the
blueprint key, and reads *"all files deleted · reinstalled from …"* in the
activity feed. It is the row someone reads when asking where a world went.

## What is not auto-healed

- **A row that never had a container** (`container_id IS NULL`) still gets a
  plain 409 telling the owner it may be provisioning or have failed to create.
  Provisioning failures deserve the operator's eyes, not an automatic retry
  loop.
- **The console and log streams.** Opening a console does not rebuild anything
  behind a viewer's back. The agent tags that failure `no_container`, so the
  console prints *"Please wait, rebuilding container…"* instead of the raw
  404 and keeps reconnecting until the container the operator's next start
  rebuilds comes up ([direct-console.md](direct-console.md)).
- **Status polling.** `reconcileServerStatus` maps a missing container to
  `error` and stops there. Reads never create infrastructure. The rebuild
  happens on the power action the operator deliberately took.

## A note on the read path

The detail endpoint runs this reconcile on every page load and every poll behind
one, so it shares a single read of the server row with everything else the view
needs (`getServerReconciled`). The live resource sample the same page polls does
*not* go through Docker's blocking stats call. Both are load-bearing, see
[performance.md](performance.md).
