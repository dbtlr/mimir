import type { NornClient } from '../../norn/client';
import {
  ANNOTATIONS_HEADING,
  HISTORY_HEADING,
  parseAnnotationsSection,
  parseHistorySection,
  sliceBodySection,
} from '../history-codec';
import type { BodySectionStore } from './store';

/**
 * The Norn body-section backend — a node's `## History` / `## Annotations`
 * sections read out of its document `.body` and parsed through the shared codec.
 * Section isolation is client-side ({@link sliceBodySection}), the NRN-102
 * `.headings` workaround: Norn has no section-scoped body read yet, so the whole
 * body is fetched and the named section sliced from it. A missing document or
 * absent section yields no records.
 */
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

export function createNornBodySectionStore(client: NornClient): BodySectionStore {
  return {
    readAnnotations: async (_nodeId, stem) =>
      parseAnnotationsSection(sliceBodySection(await readBody(client, stem), ANNOTATIONS_HEADING)),
    readHistory: async (_nodeId, stem) =>
      parseHistorySection(sliceBodySection(await readBody(client, stem), HISTORY_HEADING)),
  };
}
