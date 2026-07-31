import type { AnnotationView } from '@mimir/contract';

import type { BodySectionFacets, BodySections, BodySectionStore } from '../body-sections/store';
import {
  ANNOTATIONS_HEADING,
  countSectionHeadings,
  DESCRIPTION_HEADING,
  HISTORY_HEADING,
  NEXT_HEADING,
  parseAnnotationsSection,
  parseDescriptionSection,
  parseHistorySection,
  parseNextSection,
  sectionBody,
} from '../history-codec';
import { parseIdentity } from '../ids';
import type { NornClient, NornDocument } from './client';
import { pathAndBody, pathAndSections, stemOf } from './decode';

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
 * path.
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
): Promise<{ path: string; stem: string; section: string }[]> {
  const docs = await client.find({
    in: ['type:project,task,phase,initiative,seed'],
    ...(scope === undefined ? {} : { eq: [`project:${scope}`] }),
    no_limit: true,
  });
  return readSectionFailuresFromDocuments(client, docs);
}

/**
 * The section-failure probe over an already-enumerated work-state document set.
 * Doctor's shared diagnostic snapshot uses this core so its body, graph, and
 * section diagnostics all name the exact same paths without another `vault.find`
 * (MMR-241). Other callers may keep using {@link readSectionFailures} when they do
 * not already own a whole-vault enumeration.
 */
export async function readSectionFailuresFromDocuments(
  client: NornClient,
  docs: readonly NornDocument[],
): Promise<{ path: string; stem: string; section: string }[]> {
  const allPaths = docs.map((doc) => doc.path);
  // Nodes and seeds carry `## Annotations`; a project does not (MMR-244).
  const annotatablePaths = allPaths.filter((p) => {
    const kind = parseIdentity(stemOf(p))?.kind;
    return kind === 'node' || kind === 'seed';
  });
  const out: { path: string; stem: string; section: string }[] = [];
  const collect = async (paths: string[], heading: string): Promise<void> => {
    // An empty target list to vault.get is unverified behavior (readAllNodeDocs
    // makes the same guard) — skip the query for an empty/all-foreign set.
    if (paths.length === 0) {
      return;
    }
    for (const path of await client.sectionFailures(paths, [heading])) {
      out.push({ path, section: heading, stem: stemOf(path) });
    }
  };
  // The two reads are independent round-trips — run them concurrently.
  await Promise.all([
    collect(allPaths, HISTORY_HEADING),
    collect(annotatablePaths, ANNOTATIONS_HEADING),
  ]);
  return out;
}

/** Ascending compare on the created-at ISO — annotations sort chronologically
 * by `created_at`, ties keep document order. */
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
 * re-sorted by created-at for a deterministic order even under non-monotonic
 * timestamps; History keeps document order (insertion order, which is the
 * same).
 */
/** The headings a {@link BodySectionFacets} request resolves to, in the order the
 * parse below reads them back. One list, so the single-stem and batched readers
 * can never ask for different sections. */
function headingsFor(want: BodySectionFacets): string[] {
  const headings: string[] = [];
  if (want.description === true) {
    headings.push(DESCRIPTION_HEADING);
  }
  if (want.next === true) {
    headings.push(NEXT_HEADING);
  }
  if (want.annotations === true) {
    headings.push(ANNOTATIONS_HEADING);
  }
  if (want.history === true) {
    headings.push(HISTORY_HEADING);
  }
  return headings;
}

/** Parse one document's raw heading → section-markdown map into the requested facets. */
function parseFacets(raw: Record<string, string>, want: BodySectionFacets): BodySections {
  const sections: BodySections = {};
  if (want.description === true) {
    sections.description = parseDescriptionSection(sectionBody(raw[DESCRIPTION_HEADING] ?? ''));
  }
  if (want.next === true) {
    // A duplicated `## Next` reads as EMPTY here, exactly as an ambiguous
    // `## History`/`## Task Description` does — the deliberate graceful
    // degradation of ADR 0017. `mimir doctor` names the duplicate so the drop
    // isn't silent, and the WRITE path refuses outright (MMR-321).
    sections.next = parseNextSection(sectionBody(raw[NEXT_HEADING] ?? ''));
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
}

export function createNornBodySectionStore(client: NornClient): BodySectionStore {
  // One `vault.get { section }` per read, requesting exactly the wanted headings
  // (MMR-164, F6 / MMR-187). The single-facet methods are `want`-of-one wrappers,
  // so a multi-facet detail `get` costs one Norn round-trip instead of three.
  const readSections: BodySectionStore['readSections'] = async (stem, want) =>
    parseFacets(await readNodeSections(client, stem, headingsFor(want)), want);
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
    readAnnotations: async (stem) =>
      (await readSections(stem, { annotations: true })).annotations ?? [],
    readDescription: async (stem) =>
      (await readSections(stem, { description: true })).description ?? null,
    readHistory: async (stem) => (await readSections(stem, { history: true })).history ?? [],
    readNext: async (stem) => {
      // Presence comes from the RAW section map, not the parsed prose: a
      // resolved heading is exactly "norn can target this section", which is
      // what a `replace_section`/`delete_section` op needs (MMR-321).
      const raw = await readNodeSections(client, stem, [NEXT_HEADING]);
      const section = raw[NEXT_HEADING];
      if (section !== undefined) {
        // Resolved: the write replaces or deletes THIS heading, so no insert
        // anchor is consulted.
        return {
          ambiguous: false,
          insertAnchors: 1,
          present: true,
          text: parseNextSection(sectionBody(section)),
        };
      }
      // Not resolved — and norn reports a MISSING heading and a hand-duplicated
      // (AMBIGUOUS) one identically: both are warn-omitted from `sections`, both
      // land in `section_failures`, and only the human-readable note tells them
      // apart. Absence is therefore not provable from the section read, so
      // confirm it against the document body. Costs one extra read on the write
      // that FIRST sets the section (and on a clear against an absent one); the
      // alternative is a write that inserts a further duplicate every run.
      const records = await client.get([stem], '.body');
      const body = pathAndBody(records[0])?.body ?? '';
      return {
        ambiguous: countSectionHeadings(body, NEXT_HEADING) > 0,
        // The same body answers, for free, how many anchors a first write has
        // to splice above — `## History` is on every mimir-written document.
        insertAnchors: countSectionHeadings(body, HISTORY_HEADING),
        present: false,
        text: null,
      };
    },
    readSections,
    readSectionsMany: async (stems, want) => {
      // ONE `vault.get { section, targets: [...] }` over every stem (MMR-322) —
      // the `loadDescriptions` shape (MMR-263). The client serializes its calls,
      // so N per-stem reads are N sequential IPC round-trips no `Promise.all`
      // can overlap; batching is the only way a fan-out read stays one hop.
      const out = new Map<string, BodySections>();
      const unique = [...new Set(stems)];
      // An empty target list to `vault.get` is unverified behavior (the
      // transitions feed and the annotation probe make the same guard).
      if (unique.length === 0) {
        return out;
      }
      const records = await client.getSections(unique, headingsFor(want));
      for (const record of records) {
        const doc = pathAndSections(record);
        if (doc === null) {
          continue;
        }
        out.set(stemOf(doc.path), parseFacets(doc.sections, want));
      }
      return out;
    },
  };
}
