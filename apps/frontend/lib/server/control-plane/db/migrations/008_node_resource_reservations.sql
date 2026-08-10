-- CitadelPanel: per-node resource reservations.
--
-- A node's full nominal capacity is not necessarily safe to hand to the
-- scheduler: the host OS, the agent itself, and co-located services need
-- headroom. These columns let an admin reserve a percentage of each resource
-- (CPU, memory, disk) that must stay FREE — the scheduler treats only
-- total × (1 − reserve%) as allocable (see nodes/scheduler.ts withFreeCapacity).
--
-- `allow_overcommit` is an opt-out: when true the scheduler ignores the
-- reservation and allocates against the full total, for nodes that intentionally
-- oversubscribe (e.g. memory-oversubscribed game servers where limits are
-- ceilings, not reservations).
--
-- Capped at 95 so a node cannot be configured to refuse every placement by
-- reserving 100%. Defaults (0 / false) preserve the previous behaviour for
-- existing rows, so this migration is non-disruptive.

ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS cpu_reserve_pct     SMALLINT NOT NULL DEFAULT 0
    CHECK (cpu_reserve_pct BETWEEN 0 AND 95),
  ADD COLUMN IF NOT EXISTS memory_reserve_pct  SMALLINT NOT NULL DEFAULT 0
    CHECK (memory_reserve_pct BETWEEN 0 AND 95),
  ADD COLUMN IF NOT EXISTS disk_reserve_pct    SMALLINT NOT NULL DEFAULT 0
    CHECK (disk_reserve_pct BETWEEN 0 AND 95),
  ADD COLUMN IF NOT EXISTS allow_overcommit    BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN nodes.cpu_reserve_pct IS
  'Share of cpu_total (0-95) the scheduler must leave free unless allow_overcommit is true.';
COMMENT ON COLUMN nodes.memory_reserve_pct IS
  'Share of memory_total_mb (0-95) the scheduler must leave free unless allow_overcommit is true.';
COMMENT ON COLUMN nodes.disk_reserve_pct IS
  'Share of disk_total_mb (0-95) the scheduler must leave free unless allow_overcommit is true.';
COMMENT ON COLUMN nodes.allow_overcommit IS
  'When true, the scheduler ignores the reserve percentages and allocates against the full totals.';
