export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === "phase-production-build"
  ) return;

  const [{ syncBlueprintsToDatabase }, { startWatcher }] = await Promise.all([
    import("./lib/server/control-plane/blueprints/registry"),
    import("./lib/server/control-plane/security/watcher"),
  ]);

  await syncBlueprintsToDatabase();
  startWatcher();
}
