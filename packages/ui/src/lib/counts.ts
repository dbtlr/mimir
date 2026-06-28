import { projectKeyOf } from '../api/types';
import type { WireNode } from '../api/types';

/** Tally a flat portfolio-wide node list into per-project-key counts. */
export function countByProject(nodes: WireNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const key = projectKeyOf(node.id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
