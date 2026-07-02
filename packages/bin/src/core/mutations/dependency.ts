import type { Db, Tx } from '../context';
import { deriveSet, lineageIds } from '../derive';
import { validation } from '../errors';
import { renderNodeId } from '../lookup';
import type { Node } from '../model';
import { loadWorkingSet } from '../store-sqlite';
import { logTransition, reloadNode, requireNode, stamp } from './common';

/**
 * Dependency-edge verbs (output contract). Edges produce the derived
 * `awaiting`/`blocking` — they are **not** the `block` hold. `depend` keeps the
 * graph acyclic; `undepend` removes edges. Both append `dependency`
 * transition-log rows.
 */

/** Can `startId` reach `targetId` by following `depends_on` edges? */
async function reaches(tx: Tx, startId: number, targetId: number): Promise<boolean> {
  const seen = new Set<number>();
  const stack: number[] = [startId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const edges = await tx
      .selectFrom('dependency')
      .select('depends_on_node_id')
      .where('node_id', '=', current)
      .execute();
    for (const edge of edges) {
      if (edge.depends_on_node_id === targetId) {
        return true;
      }
      stack.push(edge.depends_on_node_id);
    }
  }
  return false;
}

export async function depend(db: Db, id: number, onIds: number[]): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    await requireNode(tx, id);
    // One snapshot serves every lineage guard — depend never rewires parents.
    const set = deriveSet(await loadWorkingSet(tx));
    for (const onId of onIds) {
      if (onId === id) {
        throw validation('a task cannot depend on itself');
      }
      await requireNode(tx, onId);
      // same-lineage guard: a dependency may not cross the parent/child line —
      // an inherited dep would make the descendant await its own ancestor (or a
      // container await a task it contains), a deadlock the raw-cycle check below
      // can't see (ADR 0001 Refinement — inherited dependencies).
      const depLineage = lineageIds(set, id);
      const prereqLineage = lineageIds(set, onId);
      if (depLineage.includes(onId) || prereqLineage.includes(id)) {
        const from = (await renderNodeId(tx, id)) ?? 'it';
        const to = (await renderNodeId(tx, onId)) ?? 'it';
        throw validation(
          `${from} and ${to} are in the same lineage — a dependency can't cross the parent/child line (it would deadlock)`,
        );
      }
      // adding id → onId closes a cycle iff onId already reaches id
      if (await reaches(tx, onId, id)) {
        const from = (await renderNodeId(tx, id)) ?? 'it';
        const to = (await renderNodeId(tx, onId)) ?? 'it';
        throw validation(`dependency would create a cycle (${from} → ${to})`);
      }
      const existing = await tx
        .selectFrom('dependency')
        .select('node_id')
        .where('node_id', '=', id)
        .where('depends_on_node_id', '=', onId)
        .executeTakeFirst();
      if (existing === undefined) {
        await tx
          .insertInto('dependency')
          .values({ depends_on_node_id: onId, node_id: id })
          .execute();
        await logTransition(tx, {
          from_value: null,
          kind: 'dependency',
          node_id: id,
          to_value: await renderNodeId(tx, onId),
        });
      }
    }
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}

export async function undepend(db: Db, id: number, onIds: number[]): Promise<Node> {
  return db.transaction().execute(async (tx) => {
    await requireNode(tx, id);
    for (const onId of onIds) {
      const deleted = await tx
        .deleteFrom('dependency')
        .where('node_id', '=', id)
        .where('depends_on_node_id', '=', onId)
        .executeTakeFirst();
      if (deleted.numDeletedRows > 0n) {
        await logTransition(tx, {
          from_value: await renderNodeId(tx, onId),
          kind: 'dependency',
          node_id: id,
          to_value: null,
        });
      }
    }
    await stamp(tx, id);
    return reloadNode(tx, id);
  });
}
