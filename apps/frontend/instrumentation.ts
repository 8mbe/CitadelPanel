export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === "phase-production-build"
  ) return;

  const [{ syncBlueprintsToDatabase }, { startWatcher }, { startBackupScheduler }] =
    await Promise.all([
      import("./lib/server/control-plane/blueprints/registry"),
      import("./lib/server/control-plane/security/watcher"),
      import("./lib/server/control-plane/nodes/backupScheduler"),
    ]);

  await syncBlueprintsToDatabase();
  startWatcher();
  // The backup scheduler both fires the cron schedule and reconciles in-flight
  // runs against their nodes, so it has to run even on a panel with no schedule
  // configured — otherwise a manual backup would never leave "running".
  startBackupScheduler();
}
