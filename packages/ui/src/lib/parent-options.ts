import type { WireTreeNode } from '../api/types';

export type ParentOption = {
  id: string;
  label: string;
  depth: number;
  type: 'initiative' | 'phase';
};

/** Valid task parents in tree order: initiatives (depth 0) and their phases (depth 1). */
export function parentOptions(root: WireTreeNode): ParentOption[] {
  const out: ParentOption[] = [];
  for (const initiative of root.children) {
    if (initiative.type !== 'initiative') {
      continue;
    }
    out.push({ depth: 0, id: initiative.id, label: initiative.title, type: 'initiative' });
    for (const phase of initiative.children) {
      if (phase.type !== 'phase') {
        continue;
      }
      out.push({ depth: 1, id: phase.id, label: phase.title, type: 'phase' });
    }
  }
  return out;
}
