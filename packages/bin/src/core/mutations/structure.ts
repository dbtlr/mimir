import type { NodeType } from '@mimir/contract';

import type { Db, Tx } from '../context';
import { lineageIds } from '../derive';
import { validation } from '../errors';
import { renderNodeId } from '../lookup';
import type { Node } from '../model';
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

/** Every node in the subtree rooted at `rootId` (inclusive), walking children down. */
async function subtreeIds(tx: Tx, rootId: number): Promise<number[]> {
  const ids: number[] = [];
  const seen = new Set<number>();
  const stack: number[] = [rootId];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || seen.has(cur)) {
      continue;
    }
    seen.add(cur);
    ids.push(cur);
    const children = await tx
      .selectFrom('node')
      .select('id')
      .where('parent_id', '=', cur)
      .execute();
    for (const child of children) {
      stack.push(child.id);
    }
  }
  return ids;
}

/**
 * A dependency edge must never cross the parent/child line (ADR 0001
 * Refinement — inherited dependencies): the move would create such an edge if
 * any node in the moved subtree depends on (or is depended on by) one of its
 * *new* ancestors. Left unguarded, the inherited gate would make a descendant
 * await its own ancestor — a deadlock that also recurses status evaluation
 * unbounded. Mirrors the same-lineage guard in `depend`.
 */
async function assertMoveKeepsDepsCrossLineage(
  tx: Tx,
  id: number,
  newParentId: number,
): Promise<void> {
  const subtree = new Set(await subtreeIds(tx, id));
  const newAncestors = new Set(await lineageIds(tx, newParentId)); // includes newParentId
  const edges = await tx
    .selectFrom('dependency')
    .select(['node_id', 'depends_on_node_id'])
    .where((eb) =>
      eb.or([eb('node_id', 'in', [...subtree]), eb('depends_on_node_id', 'in', [...subtree])]),
    )
    .execute();
  for (const edge of edges) {
    const crosses =
      (subtree.has(edge.node_id) && newAncestors.has(edge.depends_on_node_id)) ||
      (subtree.has(edge.depends_on_node_id) && newAncestors.has(edge.node_id));
    if (crosses) {
      const from = (await renderNodeId(tx, edge.node_id)) ?? 'it';
      const to = (await renderNodeId(tx, edge.depends_on_node_id)) ?? 'it';
      throw validation(
        `move would put a dependency in the same lineage (${from} depends on ${to}) — a dependency can't cross the parent/child line (it would deadlock)`,
      );
    }
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
      await assertMoveKeepsDepsCrossLineage(tx, id, newParentId);
    }

    const fromRef =
      node.parent_id === null ? 'root' : ((await renderNodeId(tx, node.parent_id)) ?? 'root');
    const toRef = newParentId === null ? 'root' : ((await renderNodeId(tx, newParentId)) ?? 'root');
    await tx.updateTable('node').set({ parent_id: newParentId }).where('id', '=', id).execute();
    await logTransition(tx, { from_value: fromRef, kind: 'move', node_id: id, to_value: toRef });
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}
