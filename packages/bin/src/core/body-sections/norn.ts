import type { AnnotationView } from '@mimir/contract';

import type { NornClient } from '../../norn/client';
import { pathAndBody, stemOf } from '../../norn/decode';
import {
  ANNOTATIONS_HEADING,
  DESCRIPTION_HEADING,
  HISTORY_HEADING,
  parseAnnotationsSection,
  parseDescriptionSection,
  parseHistorySection,
  sliceBodySection,
} from '../history-codec';
import type { BodySections, BodySectionStore } from './store';

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

/**
 * Every work-state document in the vault as `{ stem, body }` — the raw input for
 * `mimir doctor`'s body-section check (MMR-166). Enumerates the node/project
 * docs (`vault.find`), then batch-reads their bodies (`vault.get … .body`) and
 * keys each back by path. A vault diagnostic reads the disk directly, so it is
 * independent of the node read path (still SQLite until the Phase 4 cutover).
 */
export async function readAllNodeDocs(
  client: NornClient,
): Promise<{ stem: string; body: string }[]> {
  const docs = await client.find({
    in: ['type:project,task,phase,initiative'],
    no_limit: true,
  });
  const paths = docs.map((doc) => doc.path);
  // `vault.get` with an empty target list is unverified behavior (transitions
  // feed makes the same guard) — short-circuit an empty/all-foreign vault.
  if (paths.length === 0) {
    return [];
  }
  const records = await client.get(paths, '.body');
  const out: { stem: string; body: string }[] = [];
  for (const record of records) {
    const pb = pathAndBody(record);
    if (pb !== null) {
      out.push({ body: pb.body, stem: stemOf(pb.path) });
    }
  }
  return out;
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
 * The Norn body-section backend — a node's `## Task Description` / `## History` /
 * `## Annotations` sections read out of its document `.body` and parsed through
 * the shared codec.
 * Section isolation is client-side ({@link sliceBodySection}), the NRN-102
 * `.headings` workaround: Norn has no section-scoped body read yet, so the whole
 * body is fetched and the named section sliced from it. A missing document or
 * absent section yields no records. Annotations are re-sorted by created-at so
 * both backends agree even under non-monotonic timestamps; History keeps
 * document order (its SQLite sibling orders by insertion, which is the same).
 */
export function createNornBodySectionStore(client: NornClient): BodySectionStore {
  // The single body fetch every read routes through: one `.body` per node
  // document, sliced into each requested section (MMR-164, F6). The single-facet
  // methods are `want`-of-one wrappers, so a multi-facet detail `get` costs one
  // Norn round-trip instead of three.
  const readSections: BodySectionStore['readSections'] = async (_nodeId, stem, want) => {
    const body = await readBody(client, stem);
    const sections: BodySections = {};
    if (want.description === true) {
      sections.description = parseDescriptionSection(sliceBodySection(body, DESCRIPTION_HEADING));
    }
    if (want.annotations === true) {
      sections.annotations = parseAnnotationsSection(
        sliceBodySection(body, ANNOTATIONS_HEADING),
      ).toSorted(byCreatedAt);
    }
    if (want.history === true) {
      sections.history = parseHistorySection(sliceBodySection(body, HISTORY_HEADING));
    }
    return sections;
  };
  return {
    readAnnotations: async (nodeId, stem) =>
      (await readSections(nodeId, stem, { annotations: true })).annotations ?? [],
    readDescription: async (nodeId, stem) =>
      (await readSections(nodeId, stem, { description: true })).description ?? null,
    readHistory: async (nodeId, stem) =>
      (await readSections(nodeId, stem, { history: true })).history ?? [],
    readSections,
  };
}
