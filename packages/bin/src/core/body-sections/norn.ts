import type { AnnotationView } from '@mimir/contract';

import type { NornClient } from '../../norn/client';
import { pathAndBody, pathAndSections, stemOf } from '../../norn/decode';
import {
  ANNOTATIONS_HEADING,
  DESCRIPTION_HEADING,
  HISTORY_HEADING,
  parseAnnotationsSection,
  parseDescriptionSection,
  parseHistorySection,
  sectionBody,
} from '../history-codec';
import { parseIdentity } from '../ids';
import type { BodySections, BodySectionStore } from './store';

/** Read one node's named `## <heading>` sections natively (`vault.get { section }`),
 * returning the heading → raw-section-markdown map (heading line still included —
 * strip with {@link sectionBody}). A heading absent from the document is simply
 * missing from the map; an absent document (no record) yields an empty map. */
async function readNodeSections(
  client: NornClient,
  stem: string,
  headings: string[],
): Promise<Record<string, string>> {
  const records = await client.getSections([stem], headings);
  const record = records.length > 0 ? pathAndSections(records[0]) : null;
  return record?.sections ?? {};
}

/**
 * Every work-state document in the vault as `{ stem, body }` — the raw input for
 * `mimir doctor`'s body-section check (MMR-166). Enumerates the node/project/seed
 * docs (`vault.find`; seeds carry `## History`/`## Annotations` too, MMR-244), then
 * batch-reads their bodies (`vault.get … .body`) and keys each back by path. A
 * vault diagnostic reads the disk directly, so it is independent of the node read
 * path (still SQLite until the Phase 4 cutover).
 *
 * A `scope` (a project KEY) pushes into the find as `project:KEY`, so a scoped
 * doctor fetches only its project's docs instead of the whole vault (MMR-170) —
 * matching the artifact seam's `project:KEY` selector. This relies on the
 * `project` frontmatter field every work-state doc now carries (nodes point at
 * their project; the project doc is self-referential). The field is a query
 * projection of the authoritative `KEY-seq` stem; a doc whose `project` is
 * missing or hand-corrupted falls out of the scoped read, but norn's
 * `required_frontmatter` surfaces a missing one as a validate finding (MMR-191),
 * and the caller re-applies an authoritative stem filter as a backstop.
 */
export async function readAllNodeDocs(
  client: NornClient,
  scope?: string,
): Promise<{ stem: string; body: string }[]> {
  const docs = await client.find({
    in: ['type:project,task,phase,initiative,seed'],
    ...(scope === undefined ? {} : { eq: [`project:${scope}`] }),
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

/**
 * Every work-state document whose `## History` or `## Annotations` heading norn
 * cannot resolve — a hand-edited duplicate (ambiguous) or a missing heading — so
 * the native section read degrades to EMPTY (ADR 0017): the transitions feed and
 * the history/annotations facets read nothing, silently. `mimir doctor` surfaces
 * these so the loss is diagnosable (MMR-239). Each heading is queried on its OWN,
 * so a failure isolates to it — norn reports a doc in `section_failures` only when
 * NONE of a call's headings resolve. `## History` is on every work-state doc;
 * `## Annotations` only on nodes and seeds (MMR-244; a project has none), so it is
 * queried over those stems alone — requesting it on a project would false-positive
 * as "missing". A `scope` pushes into the find exactly like {@link readAllNodeDocs}.
 */
export async function readSectionFailures(
  client: NornClient,
  scope?: string,
): Promise<{ stem: string; section: string }[]> {
  const docs = await client.find({
    in: ['type:project,task,phase,initiative,seed'],
    ...(scope === undefined ? {} : { eq: [`project:${scope}`] }),
    no_limit: true,
  });
  const allPaths = docs.map((doc) => doc.path);
  // Nodes and seeds carry `## Annotations`; a project does not (MMR-244).
  const annotatablePaths = allPaths.filter((p) => {
    const kind = parseIdentity(stemOf(p))?.kind;
    return kind === 'node' || kind === 'seed';
  });
  const out: { stem: string; section: string }[] = [];
  const collect = async (paths: string[], heading: string): Promise<void> => {
    // An empty target list to vault.get is unverified behavior (readAllNodeDocs
    // makes the same guard) — skip the query for an empty/all-foreign set.
    if (paths.length === 0) {
      return;
    }
    for (const path of await client.sectionFailures(paths, [heading])) {
      out.push({ section: heading, stem: stemOf(path) });
    }
  };
  // The two reads are independent round-trips — run them concurrently.
  await Promise.all([
    collect(allPaths, HISTORY_HEADING),
    collect(annotatablePaths, ANNOTATIONS_HEADING),
  ]);
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
 * `## Annotations` sections read natively via `vault.get { section }` (NRN-102/
 * NRN-173) and parsed through the shared codec. norn slices each section with
 * `edit`'s exact boundary semantics, so a read mirrors a write; a heading absent
 * from the document is warn-and-omitted (an empty section). Annotations are
 * re-sorted by created-at so both backends agree even under non-monotonic
 * timestamps; History keeps document order (its SQLite sibling orders by
 * insertion, which is the same).
 */
export function createNornBodySectionStore(client: NornClient): BodySectionStore {
  // One `vault.get { section }` per read, requesting exactly the wanted headings
  // (MMR-164, F6 / MMR-187). The single-facet methods are `want`-of-one wrappers,
  // so a multi-facet detail `get` costs one Norn round-trip instead of three.
  const readSections: BodySectionStore['readSections'] = async (_nodeId, stem, want) => {
    const headings: string[] = [];
    if (want.description === true) {
      headings.push(DESCRIPTION_HEADING);
    }
    if (want.annotations === true) {
      headings.push(ANNOTATIONS_HEADING);
    }
    if (want.history === true) {
      headings.push(HISTORY_HEADING);
    }
    const raw = await readNodeSections(client, stem, headings);
    const sections: BodySections = {};
    if (want.description === true) {
      sections.description = parseDescriptionSection(sectionBody(raw[DESCRIPTION_HEADING] ?? ''));
    }
    if (want.annotations === true) {
      sections.annotations = parseAnnotationsSection(
        sectionBody(raw[ANNOTATIONS_HEADING] ?? ''),
      ).toSorted(byCreatedAt);
    }
    if (want.history === true) {
      sections.history = parseHistorySection(sectionBody(raw[HISTORY_HEADING] ?? ''));
    }
    return sections;
  };
  return {
    annotationSectionFailures: async (stems) => {
      // One MMR-239 `section_failures` probe over the given stems (norn resolves a
      // `KEY-seq` stem as a target directly, as `getSections` does); an empty set
      // short-circuits (an empty target list to vault.get is unverified behavior).
      if (stems.length === 0) {
        return new Set();
      }
      const paths = await client.sectionFailures(stems, [ANNOTATIONS_HEADING]);
      return new Set(paths.map(stemOf));
    },
    readAnnotations: async (nodeId, stem) =>
      (await readSections(nodeId, stem, { annotations: true })).annotations ?? [],
    readDescription: async (nodeId, stem) =>
      (await readSections(nodeId, stem, { description: true })).description ?? null,
    readHistory: async (nodeId, stem) =>
      (await readSections(nodeId, stem, { history: true })).history ?? [],
    readSections,
  };
}
