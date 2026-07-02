import type { Store, StoreWriter } from '../store';
import { assertProjectActive } from './common';

/**
 * The tag write surface (MMR-31). Tags are a general-purpose primitive
 * (ADR 0002): free-text vocabulary, no namespace enforcement — naming
 * conventions live in consumers. Tag membership is a **fact-about-now**
 * (the same class as priority/rank), so neither verb writes the transition
 * log; the tag row's own `created_at` is the only record, and `untag` is a
 * plain row delete.
 */

/**
 * A tag target. Node/project targets carry the surrogate id and use the
 * SQLite tag table; an **artifact** target carries its external identity
 * (`key`, `seq`) and routes through the artifact seam (MMR-143), so a
 * vault-backed artifact — which has no SQLite row — can still be tagged.
 */
export type EntityRef =
  | { entityType: 'project' | 'node'; entityId: number }
  | { entityType: 'artifact'; key: string; seq: number };

/** The node/project projects, for the archive write-lock check. */
async function projectOfTarget(w: StoreWriter, ref: EntityRef): Promise<number | undefined> {
  if (ref.entityType === 'artifact') {
    return (await w.loadProjectByKey(ref.key))?.id;
  }
  if (ref.entityType === 'project') {
    return ref.entityId;
  }
  return (await w.loadNode(ref.entityId))?.project_id;
}

/**
 * Apply every tag to every target, idempotently: an existing (entity, tag)
 * row is kept (re-tagging never errors); a provided `note` overwrites the
 * stored one (the note rides the application, not the vocabulary).
 *
 * Node/project tags write the SQLite tag table under one transaction; an
 * artifact's tags route through the seam (the backend owns where they live).
 * The archive write-lock (ADR 0015) is asserted for every target either way.
 */
export async function tagEntities(
  store: Store,
  targets: EntityRef[],
  tags: string[],
  note?: string,
): Promise<void> {
  await store.transact(async (w) => {
    for (const target of targets) {
      const projectId = await projectOfTarget(w, target);
      if (projectId !== undefined) {
        await assertProjectActive(w, projectId);
      }
      if (target.entityType === 'artifact') {
        continue; // written through the seam below, outside the SQLite tx
      }
      for (const tag of tags) {
        const row = { entity_id: target.entityId, entity_type: target.entityType, tag };
        await (note === undefined
          ? w.insertTag({ ...row, note: null })
          : w.upsertTagNote({ ...row, note }));
      }
    }
  });
  for (const target of targets) {
    if (target.entityType === 'artifact') {
      for (const tag of tags) {
        await store.artifacts.applyTag(target.key, target.seq, tag, note ?? null);
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
