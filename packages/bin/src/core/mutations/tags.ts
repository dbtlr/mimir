import type { Store, StoreWriter } from '../store';
import { now } from '../time';
import { assertProjectActive, stamp } from './common';

/**
 * The tag write surface (MMR-31). Tags are a general-purpose primitive
 * (ADR 0002): free-text vocabulary, no namespace enforcement — naming
 * conventions live in consumers. Tag membership is a **fact-about-now**
 * (the same class as priority/rank), so neither verb writes the transition
 * log; the tag row's own `created_at` is the only record, and `untag` is a
 * plain row delete.
 */

/**
 * A tag target. Node/project targets carry their canonical stem/key and use the tag
 * table directly; an **artifact** target carries its external identity
 * (`key`, `seq`) and routes through the artifact seam (MMR-143), so a
 * vault-backed artifact — which has no tag-table row — can still be tagged.
 */
export type EntityRef =
  | { entityType: 'project' | 'node'; entityId: string }
  | { entityType: 'artifact'; key: string; seq: number };

/** The node/project projects, for the archive write-lock check. */
async function projectOfTarget(w: StoreWriter, ref: EntityRef): Promise<string | undefined> {
  if (ref.entityType === 'artifact') {
    return (await w.loadProject(ref.key))?.key;
  }
  if (ref.entityType === 'project') {
    return ref.entityId;
  }
  return (await w.loadNode(ref.entityId))?.project_id;
}

/**
 * Apply every tag to every target, idempotently: an existing (entity, tag)
 * row is kept (re-tagging never errors). A tag application carries no note on
 * any entity (ADR 0005 Refinement) — vault `tags` frontmatter is a plain string
 * set, so note-intent routes to `annotate` or a tagged artifact instead.
 *
 * Node/project tags write the tag table under one transaction; an
 * artifact's tags route through the seam (the backend owns where they live).
 * The archive write-lock (ADR 0015) is asserted for every target either way.
 *
 * A node/project target whose tag set actually changes is stamped `updated_at`
 * (MMR-303): a first tag on an untagged entity writes a previously-absent
 * `tags` field, which alone carries no CAS precondition — the stamp is the
 * co-written guard the write path's co-write invariant requires. An idempotent
 * re-tag adds nothing and writes nothing, so it never moves `updated_at` (the
 * stale clock and attention recency read it). `untag` needs no stamp: removing
 * from a present `tags` field is always value-CAS-guarded by the field itself.
 */
export async function tagEntities(
  store: Store,
  targets: EntityRef[],
  tags: string[],
): Promise<void> {
  await store.transact(async (w) => {
    for (const target of targets) {
      const projectId = await projectOfTarget(w, target);
      if (projectId !== undefined) {
        await assertProjectActive(w, projectId);
      }
      if (target.entityType === 'artifact') {
        continue; // written through the seam below, outside this tx
      }
      let added = false;
      for (const tag of tags) {
        const applied = await w.insertTag({
          entity_id: target.entityId,
          entity_type: target.entityType,
          tag,
        });
        added ||= applied;
      }
      if (added) {
        if (target.entityType === 'node') {
          await stamp(w, target.entityId);
        } else {
          await w.updateProject(target.entityId, { updated_at: now() });
        }
      }
    }
  });
  for (const target of targets) {
    if (target.entityType === 'artifact') {
      for (const tag of tags) {
        await store.artifacts.applyTag(target.key, target.seq, tag);
      }
    }
  }
}

/** Remove every tag from every target — a plain row delete, deliberately unlogged. */
export async function untagEntities(
  store: Store,
  targets: EntityRef[],
  tags: string[],
): Promise<number> {
  let removed = await store.transact(async (w) => {
    let count = 0;
    for (const target of targets) {
      const projectId = await projectOfTarget(w, target);
      if (projectId !== undefined) {
        await assertProjectActive(w, projectId);
      }
      if (target.entityType !== 'artifact') {
        count += await w.deleteTags(target.entityType, target.entityId, tags);
      }
    }
    return count;
  });
  for (const target of targets) {
    if (target.entityType === 'artifact') {
      removed += await store.artifacts.removeTags(target.key, target.seq, tags);
    }
  }
  return removed;
}
