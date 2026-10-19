import { GROOMING_VALUES } from '@mimir/contract';
import type { Grooming } from '@mimir/contract';

import type { WireNode } from '../api/types';

/** How the console names each grooming state, and what it says about the task. */
export const GROOMING_META: Record<Grooming, { label: string; hint: string }> = {
  groomed: { hint: 'Understood well enough to run', label: 'groomed' },
  needs_answers: {
    hint: 'Open questions must be answered before it can run',
    label: 'needs answers',
  },
  not_groomed: { hint: 'Nobody has judged whether it is ready to run', label: 'not groomed' },
};

/** The states in the order the setter offers them. */
export const GROOMING_ORDER: readonly Grooming[] = ['not_groomed', 'needs_answers', 'groomed'];

/**
 * The grooming state a view shows for a node, or undefined when it shows none.
 * Grooming is a pre-start judgment (ADR 0033): only a todo task reads it, and
 * containers store none.
 */
export function visibleGrooming(
  node: Pick<WireNode, 'type' | 'lifecycle' | 'grooming'>,
): Grooming | undefined {
  if (node.type !== 'task' || node.lifecycle !== 'todo') {
    return undefined;
  }
  return GROOMING_VALUES.find((state) => state === node.grooming);
}
