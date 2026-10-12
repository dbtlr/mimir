import type { Grooming } from '@mimir/contract';

import { validation } from '../errors';
import type { Node } from '../model';
import type { Store } from '../store';
import { now } from '../time';
import { reloadNode, requireTask } from './common';

/**
 * The `groom` verb (ADR 0033): set the stored grooming judgment on one or more
 * tasks in a single transaction. Every id is validated before anything is
 * written, so a bad id in the batch changes nothing.
 *
 * The state may be set at any lifecycle, and re-setting the current state is
 * allowed. `needs_answers` requires a note; any state may carry one. A note is
 * written as an ordinary annotation on every task, so the reasoning lives in
 * the task's notes beside every other note. The change writes no transition-log
 * row — grooming is a stored judgment like `priority`, not a status transition.
 */
export async function groomTasks(
  store: Store,
  ids: string[],
  state: Grooming,
  note?: string,
): Promise<Node[]> {
  const content = note?.trim() ?? '';
  if (state === 'needs_answers' && content === '') {
    throw validation('needs_answers requires a note naming the open questions');
  }
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    throw validation('groom needs at least one task');
  }
  return store.transact(async (w) => {
    for (const id of unique) {
      await requireTask(w, id);
    }
    const nodes: Node[] = [];
    for (const id of unique) {
      const timestamp = now();
      if (content !== '') {
        await w.insertAnnotation({ content, created_at: timestamp, node_id: id });
      }
      // The same stamp `annotate` applies: the grooming call is activity on the task.
      await w.updateNode(id, { grooming: state, updated_at: timestamp });
      nodes.push(await reloadNode(w, id));
    }
    return nodes;
  });
}
