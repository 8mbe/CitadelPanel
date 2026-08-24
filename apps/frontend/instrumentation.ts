export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === "phase-production-build"
  ) return;

  const [
    { syncBlueprintsToDatabase },
    { startWatcher },
    { startBackupScheduler },
    { failInterruptedProvisions },
    { startStatusSweeper },
  ] = await Promise.all([
    import("./lib/server/control-plane/blueprints/registry"),
    import("./lib/server/control-plane/security/watcher"),
    import("./lib/server/control-plane/nodes/backupScheduler"),
    import("./lib/server/control-plane/services/serverManager"),
    import("./lib/server/control-plane/services/statusSweeper"),
  ]);

  await syncBlueprintsToDatabase();

  // Provisioning runs in this process, so anything that was still installing
  // when the previous one stopped has nobody working on it now. Fail those rows
  // before serving a request, or they claim to be installing forever.
  await failInterruptedProvisions();

  // Containers are created with no restart policy, so a node that rebooted
  // brings none of them back and every row on it still claims to be running.
  // The sweeper's first pass runs now (it is not awaited: a down node must not
  // hold up the panel's boot) and then on its own timer.
  startStatusSweeper();

  startWatcher();
  // The backup scheduler both fires the cron schedule and reconciles in-flight
  // runs against their nodes, so it has to run even on a panel with no schedule
  // configured. Otherwise a manual backup would never leave "running".
  startBackupScheduler();
}
