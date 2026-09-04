-- CitadelPanel: per-server task schedules (see docs/scheduler.md).
--
-- A schedule is a cron expression plus an ORDERED LIST of tasks, not a single
-- action. That shape is the whole point: the thing operators actually want at
-- 04:00 is "tell the players, wait a minute, back up, then restart", and four
-- separate one-action schedules cannot express it. Their relative order would be
-- whatever the tick's sort happened to be, the wait between them would have to be
-- faked by putting them on different minutes, and a failed backup could not stop
-- the restart that was supposed to follow it.
--
-- The three task kinds are deliberately the three the panel already has a
-- privileged path for -- power actions, file backups, console commands -- so a
-- schedule can never do something its author could not do by hand. There is no
-- "run a shell command on the node" task and there must never be one: that would
-- turn a schedule into remote code execution on the node, gated by a per-server
-- permission.

-- ---------------------------------------------------------------------------
-- The schedule itself.
-- ---------------------------------------------------------------------------

-- `cron` is a five-field expression evaluated by lib/cron.ts in the panel's
-- configured timezone, the same parser the backup schedule uses. Stored as the
-- text the author typed rather than a parsed form so the field round-trips
-- exactly, and so one implementation decides what an expression means for both
-- the preview in the browser and the runner on the server.
--
-- `created_by` is who a run is attributed to in the audit log. A schedule fires
-- with nobody watching, but it is not an anonymous act: somebody configured it,
-- and that is the person whose name belongs on the `server.start` row it
-- produces. ON DELETE SET NULL rather than CASCADE, because deleting an account
-- must not silently delete the schedules that keep other people's servers
-- running; the runs simply become unattributed from then on.
--
-- `only_when_running` is the guard for the case that motivated it: a schedule
-- whose job is to announce something to players, or to take a hot backup, is
-- pointless against a stopped server and mildly harmful if it starts one that
-- the owner deliberately stopped. Off by default, because a schedule whose first
-- task is `power.start` obviously must run against a stopped server.
--
-- `last_status` is a cache of the newest run's outcome, denormalised so the list
-- view does not need a correlated subquery per row. It is written by the runner
-- in the same transaction-less sequence as the run row; if the two ever
-- disagree, the run rows are the truth.
CREATE TABLE IF NOT EXISTS server_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  only_when_running BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  last_run_at TIMESTAMPTZ,
  last_status TEXT CHECK (last_status IN ('running', 'succeeded', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS server_schedules_server_idx
  ON server_schedules(server_id, created_at ASC);

-- The runner's hot query: "which schedules could fire?". Partial, because a
-- disabled schedule is never a candidate and there is no query that wants it in
-- an index.
CREATE INDEX IF NOT EXISTS server_schedules_enabled_idx
  ON server_schedules(server_id)
  WHERE enabled = TRUE;

-- ---------------------------------------------------------------------------
-- One task within a schedule.
-- ---------------------------------------------------------------------------

-- `position` orders the tasks; the runner executes them ascending and stops at
-- the first failure unless that task says otherwise. Not called "order" or
-- "sequence" because both are reserved words in Postgres and would need quoting
-- in every query that touches them.
--
-- `action` is a closed set, checked in the schema as well as in the service. The
-- runner switches on it exhaustively, so an unknown value would be a row nothing
-- can execute; better rejected at INSERT than discovered at 04:00.
--
-- `payload` carries only what its action needs -- `{ "command": "say ..." }` for
-- `command`, `{}` for everything else. JSONB rather than a nullable `command`
-- column so a fourth task kind does not mean a fifth migration adding a fifth
-- mostly-null column.
--
-- `delay_seconds` is a wait BEFORE this task runs, which is what makes "warn,
-- then restart a minute later" one schedule instead of two. Capped at 900 in the
-- service, not here, because the reason for the cap is how long a run may hold
-- the runner's attention rather than anything the schema knows.
--
-- `continue_on_failure` exists because the right answer differs per task and
-- neither default is safe for both. A failed "warn the players" must not cancel
-- the restart it precedes; a failed backup must absolutely cancel the restart
-- that would overwrite what was not backed up. So the author says which, per
-- task, and the default is the cautious one: stop.
CREATE TABLE IF NOT EXISTS server_schedule_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES server_schedules(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'power.start', 'power.stop', 'power.restart', 'power.kill',
    'backup',
    'command'
  )),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (delay_seconds BETWEEN 0 AND 900),
  continue_on_failure BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, position)
);

-- ---------------------------------------------------------------------------
-- One execution of a schedule.
-- ---------------------------------------------------------------------------

-- Why keep rows at all, when every task already writes its own audit entry: the
-- audit log records what *happened*, and the single most useful thing to tell
-- somebody about a schedule is what *did not* happen and why. A backup that was
-- skipped because the node was unreachable produces no `server.backup.create`
-- row, so without this table the schedule looks like it never ran.
--
-- `steps` is the per-task outcome, as a JSONB array in `position` order, each
-- entry `{ position, action, status, error?, startedAt, finishedAt }`. A JSONB
-- column rather than a fourth table (following `backup_runs.databases`): the
-- array is bounded by the schedule's task count, it is only ever read whole
-- alongside its run, and nothing queries across steps.
--
-- `status` is `running` while the runner is working through the tasks. A run is
-- `failed` if any task failed, even one marked `continue_on_failure` -- that flag
-- decides whether the run *proceeds*, not whether it counts as clean.
--
-- The run is written BEFORE the first task, so a panel that dies mid-run leaves a
-- durable `running` row. `failInterruptedScheduleRuns` closes those out at boot,
-- the same way `failInterruptedProvisions` does for provisioning: nobody is
-- working on them any more, and a row stuck at `running` would block the
-- schedule's next fire through the already-running check.
CREATE TABLE IF NOT EXISTS server_schedule_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The schedule may be deleted while its history is still interesting, so this
  -- is SET NULL and `server_id` below is what keeps the run reachable.
  schedule_id UUID REFERENCES server_schedules(id) ON DELETE CASCADE,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL DEFAULT 'scheduled' CHECK (trigger IN ('manual', 'scheduled')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed')),
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  -- NULL for a scheduled run whose author's account has since been deleted.
  actor_id TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS server_schedule_runs_schedule_idx
  ON server_schedule_runs(schedule_id, started_at DESC);

-- The double-fire guard and the boot sweep both ask "which runs are in flight?".
CREATE INDEX IF NOT EXISTS server_schedule_runs_active_idx
  ON server_schedule_runs(schedule_id)
  WHERE status = 'running';
