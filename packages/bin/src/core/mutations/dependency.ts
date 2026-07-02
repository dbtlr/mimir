import { deriveSet, lineageIds } from '../derive';
import { validation } from '../errors';
import type { Node } from '../model';
import type { Store, StoreWriter } from '../store';
import { logTransition, reloadNode, renderNodeRef, requireNode, stamp } from './common';

/**
 * Dependency-edge verbs (output contract). Edges produce the derived
 * `awaiting`/`blocking` — they are **not** the `block` hold. `depend` keeps the
 * graph acyclic; `undepend` removes edges. Both append `dependency`
 * transition-log rows.
 */

/** Can `startId` reach `targetId` by following `depends_on` edges? */
async function reaches(w: StoreWriter, startId: number, targetId: number): Promise<boolean> {
  const seen = new Set<number>();
  const stack: number[] = [startId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const prereqId of await w.listPrereqsOf(current)) {
      if (prereqId === targetId) {
        return true;
      }
      stack.push(prereqId);
    }
  }
  return false;
}

export async function depend(store: Store, id: number, onIds: number[]): Promise<Node> {
  return store.transact(async (w) => {
    await requireNode(w, id);
    // One snapshot serves every lineage guard — depend never rewires parents.
    const set = deriveSet(await w.loadWorkingSet());
    for (const onId of onIds) {
      if (onId === id) {
        throw validation('a task cannot depend on itself');
      }
      await requireNode(w, onId);
      // same-lineage guard: a dependency may not cross the parent/child line —
      // an inherited dep would make the descendant await its own ancestor (or a
      // container await a task it contains), a deadlock the raw-cycle check below
      // can't see (ADR 0001 Refinement — inherited dependencies).
      const depLineage = lineageIds(set, id);
      const prereqLineage = lineageIds(set, onId);
      if (depLineage.includes(onId) || prereqLineage.includes(id)) {
        const from = (await renderNodeRef(w, id)) ?? 'it';
        const to = (await renderNodeRef(w, onId)) ?? 'it';
        throw validation(
          `${from} and ${to} are in the same lineage — a dependency can't cross the parent/child line (it would deadlock)`,
        );
      }
      // adding id → onId closes a cycle iff onId already reaches id
      if (await reaches(w, onId, id)) {
        const from = (await renderNodeRef(w, id)) ?? 'it';
        const to = (await renderNodeRef(w, onId)) ?? 'it';
        throw validation(`dependency would create a cycle (${from} → ${to})`);
      }
      const exists = (await w.listPrereqsOf(id)).includes(onId);
      if (!exists) {
        await w.insertDependency({ depends_on_node_id: onId, node_id: id });
        await logTransition(w, {
          from_value: null,
          kind: 'dependency',
          node_id: id,
          to_value: await renderNodeRef(w, onId),
        });
      }
    }
    await stamp(w, id);
    return reloadNode(w, id);
  });
}

export async function undepend(store: Store, id: number, onIds: number[]): Promise<Node> {
  return store.transact(async (w) => {
    await requireNode(w, id);
    for (const onId of onIds) {
      const deleted = await w.deleteDependency({ depends_on_node_id: onId, node_id: id });
      if (deleted) {
        await logTransition(w, {
          from_value: await renderNodeRef(w, onId),
          kind: 'dependency',
          node_id: id,
          to_value: null,
        });
      }
    }
    await stamp(w, id);
    return reloadNode(w, id);
  });
}
