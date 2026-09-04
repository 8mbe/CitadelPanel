# Scheduler (per-server task schedules)

A **schedule** is a cron expression plus an **ordered list of tasks** that the
panel performs against one server, unattended. Owners configure them per server
under `Servers → <server> → Schedules`; a subuser can too, with the flags
described below.

A task is one of three things, and only these three:

| Task | Does | Needs |
| --- | --- | --- |
| `power.start` / `power.stop` / `power.restart` / `power.kill` | The power action | `start_stop` |
| `backup` | Starts a server *file* backup | `backups` |
| `command` | Sends one console command | `console` |

Related: `server-lifecycle.md` (the power actions a task calls), `backups.md`
(the backup a task starts, and the admin backup *schedule* this is not),
`subusers.md` (the `schedules` flag), `performance.md` (why the runner's tick is
shaped the way it is).

## Why a list of tasks, not one action

This is the decision the whole feature is built around. What operators actually
want at 04:00 is not "restart"; it is

> warn the players, wait a minute, take a backup, and *only if that worked*,
> restart.

Four one-action schedules cannot express that. Their relative order would be
whatever a tick's sort happened to produce, the minute of waiting would have to
be faked by putting them on different minutes, and — the part that matters — a
failed backup could not stop the restart that was supposed to follow it.

So the schedule owns the sequence:

- **`position`** orders the tasks; the runner executes them ascending.
- **`delay_seconds`** is a wait *before* a task (capped at 900), which is what
  makes "warn, then restart a minute later" one schedule.
- **`continue_on_failure`** is per task, because neither default is safe for
  both ends of the example. A failed "warn the players" must not cancel the
  restart it precedes; a failed backup must absolutely cancel the restart that
  would overwrite what was not backed up. The default is the cautious one: stop.

Tasks that never ran because an earlier one failed are recorded as `skipped`
rather than omitted, so a run explains itself without the reader diffing it
against the schedule.

## Why only these three task kinds

Each of the three is something the panel **already has a privileged path for**,
reachable by the same person through a button. That is the containment rule: a
schedule can never do something its author could not do by hand.

In particular there is **no "run a shell command on the node" task, and there
must never be one.** That would turn a per-server permission flag into remote
code execution on a node shared with other tenants.

## Why a task calls the service function, not the agent

Every branch of `runTask` delegates to the function the interactive path uses —
`restartServer`, `startServerBackup`, `sendServerCommand` — never a
reimplementation and never a direct agent call.

That is what guarantees a scheduled action is indistinguishable from a clicked
one: the same suspension check, the same status transitions, the same plugin
auto-update before a start, the same audit row. It also means adding a task kind
is a matter of *finding* the existing service function, not writing a new
privileged path.

The one signature change this forced is that the power actions now take
`actorId: string | null`. A schedule fires with nobody watching, but it is not an
anonymous act: it is attributed to `created_by`, the person who configured it.
`null` appears only once that account has been deleted, because `created_by` is
`ON DELETE SET NULL` — deleting an account must not silently delete the schedules
keeping other people's servers alive.

## The permission model, and the escalation it closes

Two gates, both required.

**1. `schedules`** — reaching the tab and the CRUD at all. Reads gate with
writes, per the project rule (`subusers.md`): a console-only subuser must not be
able to enumerate what a server does unattended at 04:00.

**2. The permission each task would need by hand.** Writing a schedule that
contains a console command *additionally* requires `console`; one that restarts
requires `start_stop`; one that backs up requires `backups`. The map lives in
one place, `TASK_PERMISSIONS`.

Without gate 2, `schedules` would quietly be the most powerful flag in the set,
because "run this command every minute" is strictly more than "run this
command". So `schedules` alone manages schedules and can create nothing that
does anything.

Gate 2 is enforced on **create, update and "Run now"**, but deliberately *not*
on read or delete: removing a schedule can only ever reduce what happens to the
server, and requiring the tasks' own permissions to delete one would mean a
subuser could be unable to stop something they can see.

The tab mirrors the map client-side (`viewerAllows`) and disables the task kinds
it knows would be refused, so a subuser meets the rule in the form rather than
in a failed save. The server-side check is the real one; the UI is a courtesy.

## The runner

One timer in the panel process (`nodes/scheduleRunner.ts`), started from
`instrumentation.ts`, ticking every **30 s** — well under a minute, so an
expression naming a specific minute is never missed, and matching
`backupScheduler.ts` so the two never drift into different definitions of "due".

The deliberate difference from the backup scheduler: **runs are started
detached, not awaited.** A schedule may hold 15 minutes of delays, and awaiting
one inside the tick would block every *other* server's schedule behind one
server's "warn the players, then restart in a minute".

That trade is what the `running` run row pays for. Because the run is not on the
tick's stack, the row is the only thing that knows it exists:

- `listCandidateSchedules` excludes a schedule with a run in flight, which stops
  a later tick starting a second copy of a slow run;
- `failInterruptedScheduleRuns` closes out rows whose owner is gone or overdue,
  which stops one lost run silencing a schedule forever.

So each tick **sweeps before it fires**, the same ordering and for the same
reason as the backup scheduler's reconcile-then-fire.

### Double firing

The guard is a **time window**, not a stored "last fired at" marker: because the
tick is shorter than a minute, the same due minute is evaluated more than once,
and a marker would have to be written transactionally with the run to be
trustworthy. Asking *"did a scheduled run start since the top of this minute?"*
needs no extra state and survives a restart mid-minute.

Manual runs are excluded from that question, so pressing **Run now** at 03:59:58
does not cancel the 04:00 fire.

### Abandoned runs

A run row is written **before** the first task, so a panel that dies mid-run
leaves a durable `running` row that nothing owns.

`failInterruptedScheduleRuns(bootedAt)` closes those out, at boot (before the
first request is served, like `failInterruptedProvisions`) and on every tick.
`bootedAt` separates the two cases it has to tell apart:

- **abandoned** — started before this process existed, so failed immediately;
- **expired** — started by this process but past its own budget
  (`sum(delay_seconds)` + 5 min per task), so its owner is not coming back.

Without that split, the boot sweep would kill a legitimate in-flight run on
every tick. `BOOTED_AT` is captured at module load rather than in `start()`, so a
hot reload does not look like a fresh boot.

The two cases get different error text, because they mean different things to an
operator: a restart mid-run means any task that had already reached a node
completed *there*, and the next scheduled run is unaffected.

## Runs, and why they are stored at all

Every task already writes its own audit entry, so why a `server_schedule_runs`
table: the audit log records what **happened**, and the most useful thing to
tell somebody about a schedule is what **did not** happen, and why. A backup
skipped because the node was unreachable produces no `server.backup.create` row,
so without the run table the schedule looks like it never ran.

`steps` is a JSONB array in `position` order (`{ position, action, status,
error?, startedAt, finishedAt }`) rather than a fourth table, following
`backup_runs.databases`: it is bounded by the task count, only ever read whole
alongside its run, and nothing queries across steps.

A run is `failed` if **any** task failed, including one marked
`continue_on_failure` — that flag decides whether the run *proceeds*, not
whether it counts as clean.

`server_schedules.last_status` is a denormalised cache of the newest run's
outcome so the list view needs no correlated subquery per row. If the two ever
disagree, the run rows are the truth.

## Cron, previews and the timezone

Expressions are five-field and parsed by `lib/cron.ts` — the same parser the
admin backup schedule uses — in the **panel's configured timezone**. The
expression is stored as the text the author typed, so the field round-trips
exactly and one implementation decides what it means for both the browser
preview and the runner.

`POST /schedules/preview` validates an expression and returns its description
plus the next five runs, server-side. The browser must never be the thing that
decides what a schedule means, or a schedule could preview one thing and do
another. It is gated on `schedules` like everything else: an ungated cron parser
is still an ungated endpoint. The list endpoint bundles the timezone and the
preset list with the schedules, because the tab cannot draw anything correct
without them — a next-run time means nothing without its zone.

An expression that no longer parses is **logged** by the runner rather than
silently skipped forever. The API validates on write, so reaching that branch
means the row came from somewhere else, and a schedule that quietly stops firing
is the worst possible way to find that out.

## `only_when_running`, and the one rule "Run now" ignores

`only_when_running` exists for the schedule whose job is to announce something to
players or take a hot backup: pointless against a stopped server, and mildly
harmful if it starts one the owner deliberately stopped. It is **off by
default**, because a schedule whose first task is `power.start` obviously must
run against a stopped server.

The guard is read from the row the candidate query already returned rather than
reconciled against the node: it is a "should I bother?" check, not a safety
check, and a node round trip per schedule per minute is not worth it for a guard
whose whole purpose is to skip work. The tasks themselves still go through
`serverManager`, which does reconcile.

**Run now** reuses the entire scheduled path, including the candidate query's
state filter, so it cannot do something the schedule itself would have refused —
a suspended server is not startable through that button either. The single
exception is `only_when_running`: it exists to stop an *unattended* schedule
acting on a stopped server, and somebody pressing a button is not unattended.

Unlike a scheduled fire, a manual run **is** awaited, so the response carries the
outcome and the person who pressed the button learns whether it worked without
polling. A schedule holding long delays therefore holds that request open; that
is the honest behaviour for a button labelled "Run now", and the run row is there
either way if the request is abandoned.

## Limits

| Limit | Value | Why |
| --- | --- | --- |
| Tasks per schedule | 10 | Bounds a run's budget and the `steps` array |
| Schedules per server | 20 | Bounds the runner's per-tick candidate work |
| Delay per task | 900 s | How long one run may hold the runner's attention |
| Per-task budget | 5 min + its delay | Past a graceful stop's timeout and past an unreachable node's failure, so anything longer is abandoned rather than slow |

The delay cap is enforced in the service rather than only in the schema, because
the reason for it is runner behaviour rather than anything the schema knows.
