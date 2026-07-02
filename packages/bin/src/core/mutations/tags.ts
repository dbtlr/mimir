import type { TagEntityType } from '@mimir/contract';

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

/** A tag target — any of the three entity kinds the identity grammar reaches. */
export type EntityRef = {
  entityType: TagEntityType;
  entityId: number;
};

/**
 * The archive write-lock for a tag target (ADR 0015): reject when the target's
 * owning project is archived. Resolves the project of a node/artifact, or the
 * project itself. A missing entity is left to the insert/delete below (tags
 * don't validate existence).
 */
async function assertTargetActive(w: StoreWriter, ref: EntityRef): Promise<void> {
  let projectId: number | undefined;
  if (ref.entityType === 'project') {
    projectId = ref.entityId;
  } else if (ref.entityType === 'node') {
    projectId = (await w.loadNode(ref.entityId))?.project_id;
  } else {
    projectId = (await w.loadArtifact(ref.entityId))?.project_id;
  }
  if (projectId !== undefined) {
    await assertProjectActive(w, projectId);
  }
}

/**
 * Apply every tag to every target, idempotently: an existing (entity, tag)
 * row is kept (re-tagging never errors); a provided `note` overwrites the
 * stored one (the note rides the application, not the vocabulary).
 */
export async function tagEntities(
  store: Store,
  targets: EntityRef[],
  tags: string[],
  note?: string,
): Promise<void> {
  await store.transact(async (w) => {
    for (const target of targets) {
      await assertTargetActive(w, target);
      for (const tag of tags) {
        const row = { entity_id: target.entityId, entity_type: target.entityType, tag };
        await (note === undefined
          ? w.insertTag({ ...row, note: null })
          : w.upsertTagNote({ ...row, note }));
      }
    }
  });
}

/** Remove every tag from every target — a plain row delete, deliberately unlogged. */
export async function untagEntities(
  store: Store,
  targets: EntityRef[],
  tags: string[],
): Promise<number> {
  return store.transact(async (w) => {
    let removed = 0;
    for (const target of targets) {
      await assertTargetActive(w, target);
      removed += await w.deleteTags(target.entityType, target.entityId, tags);
    }
    return removed;
  });
}
