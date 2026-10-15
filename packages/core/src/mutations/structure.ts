import type { NodeType } from '@mimir/contract';

import { deriveSet, lineageIds, writeIntroducesDerivationCycle } from '../derive';
import type { DerivationSet } from '../derive';
import { validation } from '../errors';
import type { Node } from '../model';
import type { Store, StoreWriter } from '../store';
import { logTransition, reloadNode, renderNodeRef, requireNode, stamp } from './common';

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

/** Every node in the subtree rooted at `rootId` (inclusive), walked in-memory over the set. */
function subtreeIds(set: DerivationSet, rootId: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || seen.has(cur)) {
      continue;
    }
    seen.add(cur);
    ids.push(cur);
    for (const child of set.childrenByParent.get(cur) ?? []) {
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
  w: StoreWriter,
  id: string,
  newParentId: string,
  set: DerivationSet,
): Promise<void> {
  const subtree = new Set(subtreeIds(set, id));
  const newAncestors = new Set(lineageIds(set, newParentId)); // includes newParentId
  const edges = set.ws.edges.filter(
    (edge) => subtree.has(edge.node_id) || subtree.has(edge.depends_on_node_id),
  );
  for (const edge of edges) {
    const crosses =
      (subtree.has(edge.node_id) && newAncestors.has(edge.depends_on_node_id)) ||
      (subtree.has(edge.depends_on_node_id) && newAncestors.has(edge.node_id));
    if (crosses) {
      const from = (await renderNodeRef(w, edge.node_id)) ?? 'it';
      const to = (await renderNodeRef(w, edge.depends_on_node_id)) ?? 'it';
      throw validation(
        `move would put a dependency in the same lineage (${from} depends on ${to}) — a dependency can't cross the parent/child line (it would deadlock)`,
      );
    }
  }
}

/** Is `candidateId` within the subtree rooted at `ancestorId` (walking up parents)? */
async function isDescendantOf(
  w: StoreWriter,
  candidateId: string,
  ancestorId: string,
): Promise<boolean> {
  let current: string | null = candidateId;
  const seen = new Set<string>();
  while (current !== null) {
    if (current === ancestorId) {
      return true;
    }
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const row: Node | undefined = await w.loadNode(current);
    current = row?.parent_id ?? null;
  }
  return false;
}

export async function moveNode(
  store: Store,
  id: string,
  newParentId: string | null,
): Promise<Node> {
  return store.transact(async (w) => {
    const node = await requireNode(w, id);

    if (newParentId === null) {
      if (node.type !== 'initiative') {
        throw validation(`only an initiative can be top-level, not a ${node.type}`);
      }
    } else {
      if (newParentId === id) {
        throw validation('cannot move it under itself');
      }
      const parent = await requireNode(w, newParentId);
      if (parent.project_id !== node.project_id) {
        throw validation('cross-project move is not supported');
      }
      assertParentType(node.type, parent.type);
      if (await isDescendantOf(w, newParentId, id)) {
        throw validation('cannot move it under its own descendant');
      }
      const ws = await w.loadWorkingSet();
      await assertMoveKeepsDepsCrossLineage(w, id, newParentId, deriveSet(ws));
      // Re-parenting rewires inherited container dependencies, which can close
      // a rollup loop between containers that were acyclic apart (MMR-140).
      // Simulate the move over the snapshot and reuse the runtime detection.
      const moved = ws.nodes.map((n) => (n.id === id ? { ...n, parent_id: newParentId } : n));
      if (writeIntroducesDerivationCycle(ws, { ...ws, nodes: moved }, id)) {
        const from = (await renderNodeRef(w, id)) ?? 'it';
        const to = (await renderNodeRef(w, newParentId)) ?? 'it';
        throw validation(
          `move would close a derivation cycle through container rollups (${from} under ${to})`,
        );
      }
    }

    const fromRef =
      node.parent_id === null ? 'root' : ((await renderNodeRef(w, node.parent_id)) ?? 'root');
    const toRef = newParentId === null ? 'root' : ((await renderNodeRef(w, newParentId)) ?? 'root');
    await w.updateNode(id, { parent_id: newParentId });
    await logTransition(w, { from_value: fromRef, kind: 'move', node_id: id, to_value: toRef });
    await stamp(w, id);
    return reloadNode(w, id);
  });
}
