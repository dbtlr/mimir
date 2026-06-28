import type { NodeType } from '@mimir/contract';

import type { Node } from '../../db/schema';
import type { Db, Tx } from '../context';
import { validation } from '../errors';
import { renderNodeId } from '../lookup';
import { logTransition, reloadNode, requireNode, stamp } from './common';

/**
 * Structural move (output contract / glossary). Re-parents a node, validating
 * the same parent-type rules as create (spec §3.4) plus cycle-freedom — a node
 * may not move under itself or its own descendant. Within-project only (a move
 * would otherwise change `project_id`/`seq`). Logs a `move` transition row.
 */

function assertParentType(child: NodeType, parent: NodeType): void {
  if (child === 'initiative') {
    throw validation('an initiative is top-level — move it with no parent');
  }
  if (child === 'phase' && parent !== 'initiative') {
    throw validation(`a phase's parent must be an initiative, not a ${parent}`);
  }
  if (child === 'task' && parent !== 'phase' && parent !== 'initiative') {
    throw validation(`a task's parent must be a phase or initiative, not a ${parent}`);
  }
}

/** Is `candidateId` within the subtree rooted at `ancestorId` (walking up parents)? */
async function isDescendantOf(tx: Tx, candidateId: number, ancestorId: number): Promise<boolean> {
  let current: number | null = candidateId;
  const seen = new Set<number>();
  while (current !== null) {
    if (current === ancestorId) {
      return true;
    }
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const row: { parent_id: number | null } | undefined = await tx
      .selectFrom('node')
      .select('parent_id')
      .where('id', '=', current)
      .executeTakeFirst();
    current = row?.parent_id ?? null;
  }
  return false;
}

export async function moveNode(db: Db, id: number, newParentId: number | null): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    const node = await requireNode(tx, id);

    if (newParentId === null) {
      if (node.type !== 'initiative') {
        throw validation(`only an initiative can be top-level, not a ${node.type}`);
      }
    } else {
      if (newParentId === id) {
        throw validation('cannot move it under itself');
      }
      const parent = await requireNode(tx, newParentId);
      if (parent.project_id !== node.project_id) {
        throw validation('cross-project move is not supported');
      }
      assertParentType(node.type, parent.type);
      if (await isDescendantOf(tx, newParentId, id)) {
        throw validation('cannot move it under its own descendant');
      }
    }

    const fromRef =
      node.parent_id === null ? 'root' : ((await renderNodeId(tx, node.parent_id)) ?? 'root');
    const toRef = newParentId === null ? 'root' : ((await renderNodeId(tx, newParentId)) ?? 'root');
    await tx.updateTable('node').set({ parent_id: newParentId }).where('id', '=', id).execute();
    await logTransition(tx, { node_id: id, kind: 'move', from_value: fromRef, to_value: toRef });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}
