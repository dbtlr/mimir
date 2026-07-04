import type { AnnotationView } from '@mimir/contract';

import type { NornClient } from '../../norn/client';
import {
  ANNOTATIONS_HEADING,
  HISTORY_HEADING,
  parseAnnotationsSection,
  parseHistorySection,
  sliceBodySection,
} from '../history-codec';
import type { BodySectionStore } from './store';

/** The `.body` string of a `vault.get` record; missing/absent bodies read empty. */
function bodyOf(record: unknown): string {
  if (typeof record === 'object' && record !== null && 'body' in record) {
    const { body } = record;
    return typeof body === 'string' ? body : '';
  }
  return '';
}

async function readBody(client: NornClient, stem: string): Promise<string> {
  const records = await client.get([stem], '.body');
  return records.length > 0 ? bodyOf(records[0]) : '';
}

/** Ascending compare on the created-at ISO — annotations sort chronologically to
 * match the SQLite backend's `order by created_at`, ties keep document order. */
function byCreatedAt(a: AnnotationView, b: AnnotationView): number {
  if (a.createdAt < b.createdAt) {
    return -1;
  }
  return a.createdAt > b.createdAt ? 1 : 0;
}

/**
 * The Norn body-section backend — a node's `## History` / `## Annotations`
 * sections read out of its document `.body` and parsed through the shared codec.
 * Section isolation is client-side ({@link sliceBodySection}), the NRN-102
 * `.headings` workaround: Norn has no section-scoped body read yet, so the whole
 * body is fetched and the named section sliced from it. A missing document or
 * absent section yields no records. Annotations are re-sorted by created-at so
 * both backends agree even under non-monotonic timestamps; History keeps
 * document order (its SQLite sibling orders by insertion, which is the same).
 */
export function createNornBodySectionStore(client: NornClient): BodySectionStore {
  return {
    readAnnotations: async (_nodeId, stem) =>
      parseAnnotationsSection(
        sliceBodySection(await readBody(client, stem), ANNOTATIONS_HEADING),
      ).toSorted(byCreatedAt),
    readHistory: async (_nodeId, stem) =>
      parseHistorySection(sliceBodySection(await readBody(client, stem), HISTORY_HEADING)),
  };
}
