/** Count pool numbers that are not already claimed on the node. */
export function countFreePorts(
  candidates: readonly number[],
  taken: ReadonlySet<number>,
): number {
  return candidates.filter((port) => !taken.has(port)).length;
}
