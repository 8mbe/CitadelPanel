const activeWrites = new Set<string>();

/** One panel process must not download over a file another install just claimed. */
export function beginPluginWrite(serverId: string): (() => void) | null {
  if (activeWrites.has(serverId)) return null;
  activeWrites.add(serverId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWrites.delete(serverId);
  };
}
