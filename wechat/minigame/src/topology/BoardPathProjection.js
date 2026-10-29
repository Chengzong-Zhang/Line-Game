// Expand only explicitly glued edge occurrences. Canonical endpoint equality
// alone is insufficient: distinct edges can join the same quotient vertices.
// This function is display-only; it never changes a logical path or state.
export function expandPathEdgeOccurrences(viewBoard, occurrenceIds) {
  const mates = new Map();
  for (const pair of viewBoard?.seamPairs ?? []) {
    if (typeof pair.edgeOccurrenceA !== "string" || typeof pair.edgeOccurrenceB !== "string") continue;
    mates.set(pair.edgeOccurrenceA, pair.edgeOccurrenceB);
    mates.set(pair.edgeOccurrenceB, pair.edgeOccurrenceA);
  }
  const expanded = new Set();
  for (const id of occurrenceIds ?? []) {
    expanded.add(id);
    const mate = mates.get(id);
    if (mate) expanded.add(mate);
  }
  return [...expanded];
}
