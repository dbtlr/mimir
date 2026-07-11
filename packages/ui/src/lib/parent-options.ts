import type { WireTreeNode } from '../api/types';

export type ParentOption = {
  id: string;
  label: string;
  depth: number;
  type: 'initiative' | 'phase';
};

/** What the authoring sheet can create (projects have their own sheet, MMR-230). */
export type AuthoringType = 'task' | 'phase' | 'initiative';

/** A legal home for the type being authored; `openEnded` feeds the ∞ marker. */
export type HomeOption = {
  openEnded: boolean;
} & ParentOption;

/**
 * Type governs legal homes (MMR-227): task → any initiative or phase,
 * phase → any initiative, initiative → the project itself — an empty list
 * here; the caller offers the project level instead.
 */
export function homeOptions(type: AuthoringType, root: WireTreeNode): HomeOption[] {
  if (type === 'initiative') {
    return [];
  }
  const out: HomeOption[] = [];
  for (const initiative of root.children) {
    if (initiative.type !== 'initiative') {
      continue;
    }
    out.push({
      depth: 0,
      id: initiative.id,
      label: initiative.title,
      openEnded: initiative.open_ended === true,
      type: 'initiative',
    });
    if (type !== 'task') {
      continue;
    }
    for (const phase of initiative.children) {
      if (phase.type !== 'phase') {
        continue;
      }
      out.push({
        depth: 1,
        id: phase.id,
        label: phase.title,
        openEnded: phase.open_ended === true,
        type: 'phase',
      });
    }
  }
  return out;
}

/** Valid task parents in tree order: initiatives (depth 0) and their phases (depth 1). */
export function parentOptions(root: WireTreeNode): ParentOption[] {
  return homeOptions('task', root).map(({ depth, id, label, type }) => ({
    depth,
    id,
    label,
    type,
  }));
}
