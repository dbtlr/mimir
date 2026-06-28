import type { TagEntityType } from '@mimir/contract';

import type { Db } from '../context';

/**
 * The tag write surface (MMR-31). Tags are a general-purpose primitive
 * (ADR 0002): free-text vocabulary, no namespace enforcement — naming
 * conventions live in consumers. Tag membership is a **fact-about-now**
 * (the same class as priority/rank), so neither verb writes the transition
 * log; the tag row's own `created_at` is the only record, and `untag` is a
 * plain row delete.
 */

/** A tag target — any of the three entity kinds the identity grammar reaches. */
export interface EntityRef {
  entityType: TagEntityType;
  entityId: number;
}

/**
 * Apply every tag to every target, idempotently: an existing (entity, tag)
 * row is kept (re-tagging never errors); a provided `note` overwrites the
 * stored one (the note rides the application, not the vocabulary).
 */
export async function tagEntities(
  db: Db,
  targets: EntityRef[],
  tags: string[],
  note?: string,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    for (const target of targets) {
      for (const tag of tags) {
        await tx
          .insertInto('tag')
          .values({
            entity_type: target.entityType,
            entity_id: target.entityId,
            tag,
            note: note ?? null,
          })
          .onConflict((oc) =>
            note === undefined
              ? oc.columns(['entity_type', 'entity_id', 'tag']).doNothing()
              : oc.columns(['entity_type', 'entity_id', 'tag']).doUpdateSet({ note }),
          )
          .execute();
      }
    }
  });
}

/** Remove every tag from every target — a plain row delete, deliberately unlogged. */
export async function untagEntities(db: Db, targets: EntityRef[], tags: string[]): Promise<number> {
  return db.transaction().execute(async (tx) => {
    let removed = 0;
    for (const target of targets) {
      const result = await tx
        .deleteFrom('tag')
        .where('entity_type', '=', target.entityType)
        .where('entity_id', '=', target.entityId)
        .where('tag', 'in', tags)
        .executeTakeFirst();
      removed += Number(result.numDeletedRows);
    }
    return removed;
  });
}
