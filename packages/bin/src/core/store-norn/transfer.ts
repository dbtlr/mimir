import { isDeepStrictEqual } from 'node:util';

import type { AnnotationView, HistoryEntry, TagEntityType } from '@mimir/contract';

import type { BodySections, NextFacet } from '../body-sections/store';
import { invariant, validation } from '../errors';
import type {
  ExportedBodySections,
  ExportedCounters,
  ExportedProject,
  ExportedTag,
  ImportOptions,
  ImportReport,
  StoreExport,
} from '../export';
import { STORE_EXPORT_SCHEMA_VERSION } from '../export';
import { renderMigratedNodeBody, renderMigratedProjectBody, toCanonicalLf } from '../history-codec';
import { parseId, renderArtifactRef, renderSeedRef } from '../ids';
import type { Node } from '../model';
import type { NewAnnotationRecord, NewTransitionRecord, NodeTag } from '../store';
import { now } from '../time';
import { assertSingleValuedIdentities } from '../transfer-validate';
import { nodeFrontmatter, projectFrontmatter } from '../vault-frontmatter';
import { artifactDocument, exportArtifacts } from './artifacts';
import { createNornBodySectionStore } from './body-sections';
import type { ChunkLimits } from './chunking';
import { ASSUMED_BODY_BYTES, READ_LIMITS, readChunked } from './chunking';
import type { NornClient } from './client';
import { collapse, isStringRecord, linkStems, stemOf } from './decode';
import type { RawDocument } from './raw-write';
import { createRawDocuments, WRITE_LIMITS } from './raw-write';
import { exportScratchpads, scratchpadDocument } from './scratchpads';
import { exportSeeds, seedDocument } from './seeds';
import { loadWorkingSetOverNorn } from './store';

/**
 * The Norn backend's export and import (MMR-378, ADR 0030 Decision 4) — the
 * whole store's stored facts out to one backend-neutral {@link StoreExport}, and
 * such a document back in with every id, sequence, and timestamp preserved.
 *
 * **Export reuses the seam's own decoders.** Every collection comes from the
 * reader that already owns that shape (the working-set load, the artifact, seed,
 * and scratchpad exporters in their own modules, the body-section store), so an
 * exported record is exactly what a `Store` read would return — there is no
 * second decode here to drift from the first.
 *
 * **Export carries the facts the seam surfaces, and REFUSES when the vault holds
 * a document it cannot carry.** Those decoders are deliberately tolerant (ADR
 * 0017): the working-set validator drops a node whose project or parent is
 * missing and prunes a dangling `depends_on` edge, the scratchpad decode nulls a
 * dangling anchor, and the artifact and seed exporters hide an identity
 * collision. That tolerance is right for a read and wrong for a copy, so the
 * export re-enumerates every physical work-state document (metadata only) and
 * fails closed on anything the collections do not represent, naming the paths
 * and pointing at `mimir doctor`. A pruned edge and a nulled anchor count as
 * loss too — they are compared against the raw frontmatter of that same pass.
 * The transfer document is a portable backup only because of this refusal.
 *
 * **Import reuses the seam's own encoders.** Each imported record is turned back
 * into a whole document by the same frontmatter and body builders the normal
 * write path uses (`projectFrontmatter`, `nodeFrontmatter`, `artifactDocument`,
 * `seedDocument`, `scratchpadDocument`, the history codec's section renderers).
 * The result is byte-identical to the document a create-then-mutate sequence
 * would have grown, so a round trip through the transfer document is invisible.
 *
 * **No allocator recovery.** Norn allocates the next sequence from the target
 * DIRECTORY at apply time (`{{seq}}`, MMR-196), so writing the imported
 * documents IS writing the allocation state — there is no counter to set
 * afterwards, and no window in which a create could re-hand an imported
 * identity. The document still carries {@link ExportedCounters} because a
 * backend that stores counters as columns (Postgres, MMR-379) must write them;
 * this backend reads them for nothing. An interior gap in an imported sequence
 * is a freed number Norn may re-hand later — ADR 0006's accepted edge, not a
 * collision.
 *
 * **Failure is partial success** (ADR 0023). A multi-document plan may apply
 * some documents and refuse the rest, so a failed import leaves the target
 * half-written; `resume` is how the operator finishes it.
 */

/** Every body-section facet the export reads, in one batched round trip. */
const EXPORT_FACETS = {
  annotations: true,
  description: true,
  history: true,
  next: true,
} as const;

export async function exportNornStore(
  client: NornClient,
  limits: ChunkLimits = READ_LIMITS,
): Promise<StoreExport> {
  const workingSet = await loadWorkingSetOverNorn(client);
  const artifacts = await exportArtifacts(client, limits);
  const seeds = await exportSeeds(client, limits);
  const scratchpads = await exportScratchpads(client, limits);

  // Deterministic collection order, imposed here rather than trusted from the
  // readers: a re-export of an unchanged store must differ only in
  // `exported_at`, and two backends must agree on the document they emit.
  const projects = [...workingSet.projects].toSorted((a, b) => a.key.localeCompare(b.key));
  const nodes = [...workingSet.nodes].toSorted(byProjectThenSeq);

  const sections = await readSectionsChunked(
    client,
    [...projects.map((project) => project.key), ...nodes.map((node) => node.id)],
    limits,
  );

  const tags: ExportedTag[] = [
    ...projects.flatMap((project) =>
      tagRecords('project', project.key, workingSet.projectTags.get(project.key)),
    ),
    ...nodes.flatMap((node) => tagRecords('node', node.id, workingSet.nodeTags.get(node.id))),
  ];

  const annotations: NewAnnotationRecord[] = nodes.flatMap((node) =>
    (sections.get(node.id)?.annotations ?? []).map((view) => annotationRecord(node.id, view)),
  );

  // Project rows first, then nodes — within an entity, document order is the
  // `## History` order, which is the only ordering a markdown vault has.
  const transitions: NewTransitionRecord[] = [
    ...projects.flatMap((project) =>
      (sections.get(project.key)?.history ?? []).map((entry) =>
        transitionRecord(entry, { project_id: project.key }),
      ),
    ),
    ...nodes.flatMap((node) =>
      (sections.get(node.id)?.history ?? []).map((entry) =>
        transitionRecord(entry, { node_id: node.id }),
      ),
    ),
  ];

  const bodySections: ExportedBodySections[] = [
    // A project carries no `## Task Description` (its description is a
    // frontmatter field on the project record), so only `next` is projected.
    ...projects.flatMap((project) => ownedSections(project.key, sections.get(project.key))),
    ...nodes.flatMap((node) =>
      ownedSections(node.id, sections.get(node.id), { description: true }),
    ),
  ];

  // Copied rather than mutated in place: `projects` holds the working set's own
  // records, and the export must not reshape what a caller still holds.
  const exportedProjects: ExportedProject[] = [];
  for (const project of projects) {
    exportedProjects.push({
      ...project,
      counters: countersFor(project.key, nodes, artifacts, seeds),
    });
  }

  const document: StoreExport = {
    annotations,
    artifacts,
    bodySections,
    edges: [...workingSet.edges].toSorted(
      (a, b) =>
        a.node_id.localeCompare(b.node_id) ||
        a.depends_on_node_id.localeCompare(b.depends_on_node_id),
    ),
    exported_at: now(),
    nodes,
    projects: exportedProjects,
    schema_version: STORE_EXPORT_SCHEMA_VERSION,
    scratchpads,
    seeds,
    tags,
    transitions,
  };
  // Last, over the finished document: a copy that silently narrows is worse
  // than no copy at all.
  assertCarriesEveryDocument(document, await physicalDocuments(client));
  return document;
}

export async function importNornStore(
  client: NornClient,
  vaultRoot: string,
  document: StoreExport,
  opts: ImportOptions,
  limits: { read?: ChunkLimits; write?: ChunkLimits } = {},
): Promise<ImportReport> {
  if (document.schema_version !== STORE_EXPORT_SCHEMA_VERSION) {
    throw validation(
      `unsupported transfer document schema version ${String(document.schema_version)}`,
      `this binary reads schema version ${String(STORE_EXPORT_SCHEMA_VERSION)}`,
    );
  }
  assertSingleValuedIdentities(document);
  const documents = transferDocuments(document);

  if (opts.mode === 'fresh') {
    // Refuse BEFORE writing anything: a fresh import owns the identities it
    // brings, and an existing project means the target already holds some of
    // them (ADR 0030 Decision 4).
    const occupied = await existingProjectKeys(client);
    const collisions = document.projects
      .map((project) => project.key)
      .filter((key) => occupied.has(key))
      .toSorted((a, b) => a.localeCompare(b));
    if (collisions.length > 0) {
      throw validation(
        `the target already holds an imported project: ${collisions.join(', ')}`,
        'a fresh import owns the identities it brings — import into an empty store, or resume to finish a partial import',
      );
    }
    await createRawDocuments(client, vaultRoot, documents, limits.write ?? WRITE_LIMITS);
    return { created: documents.length, mode: 'fresh', skipped: 0 };
  }

  // Resume: every document already present at its canonical path with content
  // identical to what this import would write is a document a prior run landed;
  // skip it. A present document whose content DIFFERS is not this import's, so
  // refuse and name the path rather than guess whose bytes win.
  const present = await readDocuments(
    client,
    documents.map((doc) => doc.path),
    limits.read ?? READ_LIMITS,
  );
  const pending: RawDocument[] = [];
  let skipped = 0;
  for (const doc of documents) {
    const existing = present.get(doc.path);
    if (existing === undefined) {
      pending.push(doc);
    } else if (sameDocument(doc, existing)) {
      skipped += 1;
    } else {
      throw validation(
        `${doc.path} already exists and differs from the transfer document`,
        'a resume may only skip documents a prior run of this same import wrote — inspect that document, or import into a clean target',
      );
    }
  }
  await createRawDocuments(client, vaultRoot, pending, limits.write ?? WRITE_LIMITS);
  return { created: pending.length, mode: 'resume', skipped };
}

// ── Export helpers ─────────────────────────────────────────────────────────

/**
 * Every owned body section of every project and node, in byte-bounded
 * `readSectionsMany` calls.
 *
 * Chunked HERE rather than inside `readSectionsMany` on purpose. That method's
 * whole reason to exist is that N per-stem reads are N sequential IPC hops
 * (MMR-322), and its callers on the session-boot hot path ask for ~25 stems —
 * well inside the cap. Only the export asks for every stem in the vault (2200
 * on the vault this was measured against), so the export is where the budget
 * belongs; pushing it down would slow the hot path to fix a problem it does not
 * have.
 *
 * The sections requested here carry a document's whole `## Task Description`,
 * `## Next`, `## History`, and `## Annotations` prose, so the weight assumption
 * is the same body-sized one the artifact and seed reads use — a section set is
 * a body minus its headings.
 */
async function readSectionsChunked(
  client: NornClient,
  stems: readonly string[],
  limits: ChunkLimits,
): Promise<Map<string, BodySections>> {
  const store = createNornBodySectionStore(client);
  const entries = await readChunked(
    stems,
    () => ASSUMED_BODY_BYTES,
    limits,
    (stem) => stem,
    async (chunk) => [...(await store.readSectionsMany([...chunk], EXPORT_FACETS))],
  );
  return new Map(entries);
}

/** Nodes order by owning project, then allocated sequence — stable and
 * human-legible, unlike a lexicographic sort over `KEY-seq` stems. */
function byProjectThenSeq(a: Node, b: Node): number {
  return a.project_id === b.project_id ? a.seq - b.seq : a.project_id.localeCompare(b.project_id);
}

function tagRecords(
  entityType: TagEntityType,
  entityId: string,
  applied: readonly NodeTag[] | undefined,
): ExportedTag[] {
  return (applied ?? [])
    .map((record) => ({ entity_id: entityId, entity_type: entityType, tag: record.tag }))
    .toSorted((a, b) => a.tag.localeCompare(b.tag));
}

function annotationRecord(nodeId: string, view: AnnotationView): NewAnnotationRecord {
  return { content: view.content, created_at: view.createdAt, node_id: nodeId };
}

function transitionRecord(
  entry: HistoryEntry,
  entity: { node_id: string } | { project_id: string },
): NewTransitionRecord {
  return {
    ...entity,
    at: entry.at,
    from_value: entry.from,
    kind: entry.kind,
    reason: entry.reason,
    to_value: entry.to,
    ...(entry.handles === undefined ? {} : { handles: entry.handles }),
  };
}

/** The `## Next` facet of a document that resolved no sections at all — absent,
 * which is what an unread or section-less document means. */
const NO_NEXT: NextFacet = { present: false, text: null };

/**
 * One document's owned prose sections, omitted entirely when it carries none —
 * an empty row would be noise in the transfer document and a no-op on import.
 *
 * "Carries none" is presence, not prose: a `## Next` heading with a blank body
 * is a document state an import must reproduce, so it earns a row even though
 * its text is null. `owns.description` marks the documents that HAVE a
 * `## Task Description` (nodes); a project's description is frontmatter.
 */
function ownedSections(
  stem: string,
  sections: BodySections | undefined,
  owns: { description?: boolean } = {},
): ExportedBodySections[] {
  const next = sections?.next ?? NO_NEXT;
  const description = owns.description === true ? (sections?.description ?? null) : null;
  if (description === null && !next.present) {
    return [];
  }
  return [{ next, stem, ...(owns.description === true ? { description } : {}) }];
}

/**
 * A project's sequence-allocation state (ADR 0006) — the highest sequence each
 * kind has handed out. For Norn this is derived, not stored: the documents in
 * the project's directories ARE the allocator, so the highest present sequence
 * is exactly the counter a backend that stores one would hold.
 */
function countersFor(
  key: string,
  nodes: readonly Node[],
  artifacts: readonly { key: string; seq: number }[],
  seeds: readonly { key: string; seq: number }[],
): ExportedCounters {
  return {
    artifact: highestSeq(artifacts.filter((a) => a.key === key).map((a) => a.seq)),
    node: highestSeq(nodes.filter((n) => n.project_id === key).map((n) => n.seq)),
    seed: highestSeq(seeds.filter((s) => s.key === key).map((s) => s.seq)),
  };
}

/** The largest sequence in the list; zero when the kind has none. */
function highestSeq(seqs: readonly number[]): number {
  return seqs.reduce((max, seq) => Math.max(max, seq), 0);
}

// ── Import helpers ─────────────────────────────────────────────────────────

/** The whole transfer document as physical vault documents, in write order:
 * projects, then their nodes, artifacts, seeds, and finally the scratchpads.
 * Norn tolerates dangling wikilinks, so the order is for legibility (and for a
 * partial failure leaving the most structural documents behind), not a
 * referential requirement. */
function transferDocuments(document: StoreExport): RawDocument[] {
  const tags = indexTags(document.tags);
  const owned = new Map(document.bodySections.map((sections) => [sections.stem, sections]));
  const history = indexTransitions(document.transitions);
  const annotations = groupBy(document.annotations, (row) => row.node_id);
  const prereqs = groupBy(document.edges, (edge) => edge.node_id);

  const projects = document.projects.map((project) =>
    projectDocument(project, tags, owned, history),
  );
  const nodes = document.nodes.map((node) => {
    const sections = owned.get(node.id);
    return {
      body: renderMigratedNodeBody(
        sections?.description ?? null,
        history.get(node.id) ?? [],
        (annotations.get(node.id) ?? []).map((row) => ({
          content: row.content,
          createdAt: row.created_at,
        })),
        sections?.next,
      ),
      frontmatter: nodeFrontmatter(node, {
        // Match the write path's relation shape exactly (`nodeRelations`):
        // prerequisites deduped and sorted, tags sorted by tag.
        dependsOn: [
          ...new Set((prereqs.get(node.id) ?? []).map((edge) => edge.depends_on_node_id)),
        ].toSorted((a, b) => a.localeCompare(b)),
        parentStem: node.parent_id,
        projectKey: node.project_id,
        tags: tagsFor(tags, 'node', node.id),
      }),
      path: `${node.project_id}/${node.id}.md`,
    };
  });

  return [
    ...projects,
    ...nodes,
    ...document.artifacts.map(artifactDocument),
    ...document.seeds.map(seedDocument),
    ...document.scratchpads.map(scratchpadDocument),
  ];
}

function projectDocument(
  project: ExportedProject,
  tags: TagIndex,
  owned: ReadonlyMap<string, ExportedBodySections>,
  history: ReadonlyMap<string, HistoryEntry[]>,
): RawDocument {
  return {
    body: renderMigratedProjectBody(history.get(project.key) ?? [], owned.get(project.key)?.next),
    frontmatter: projectFrontmatter(project, tagsFor(tags, 'project', project.key)),
    path: `${project.key}/${project.key}.md`,
  };
}

type TagIndex = ReadonlyMap<string, string[]>;

function tagKey(entityType: TagEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function indexTags(rows: readonly ExportedTag[]): TagIndex {
  const index = new Map<string, string[]>();
  for (const row of rows) {
    const key = tagKey(row.entity_type, row.entity_id);
    index.set(key, [...(index.get(key) ?? []), row.tag]);
  }
  return index;
}

/**
 * The tag records the frontmatter encoders want, sorted by tag as the write path
 * sorts them. The synthesized `created_at` is never emitted (a vault tag set is
 * plain strings, ADR 0005) — it exists only because {@link NodeTag} is the shape
 * the encoders take.
 */
function tagsFor(tags: TagIndex, entityType: TagEntityType, entityId: string): NodeTag[] {
  return (tags.get(tagKey(entityType, entityId)) ?? [])
    .toSorted((a, b) => a.localeCompare(b))
    .map((tag) => ({ created_at: '', tag }));
}

/** Transitions back to `## History` entries, keyed by their entity, preserving
 * the transfer document's per-entity order (which is document order). */
function indexTransitions(rows: readonly NewTransitionRecord[]): Map<string, HistoryEntry[]> {
  const index = new Map<string, HistoryEntry[]>();
  for (const row of rows) {
    const entity = row.node_id ?? row.project_id;
    if (entity == null) {
      throw invariant('a transfer-document transition targets neither a node nor a project');
    }
    const entry: HistoryEntry = {
      at: row.at,
      from: row.from_value,
      kind: row.kind,
      reason: row.reason ?? null,
      to: row.to_value,
    };
    if (row.handles !== undefined) {
      entry.handles = row.handles;
    }
    index.set(entity, [...(index.get(entity) ?? []), entry]);
  }
  return index;
}

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    index.set(key, [...(index.get(key) ?? []), row]);
  }
  return index;
}

/**
 * The project keys the target already holds — TWO occupancies, because a project
 * has two identities and a fresh import must refuse on either.
 *
 * The frontmatter `key` is the project's real identity (a project document may
 * be physically relocated), so it is read first. The canonical path `KEY/KEY.md`
 * is the identity the IMPORT is about to claim, and a document sitting there
 * blocks the write whatever its frontmatter says — a project doc whose `key`
 * field was lost to a hand-edit would otherwise pass the fence and then refuse
 * mid-write, half-importing the store.
 */
async function existingProjectKeys(client: NornClient): Promise<Set<string>> {
  const docs = await client.find({ eq: ['type:project'], no_limit: true });
  const occupied = new Set<string>();
  for (const doc of docs) {
    const key = collapse(doc.frontmatter?.key);
    if (key !== null) {
      occupied.add(key);
    }
    const stem = stemOf(doc.path);
    if (doc.path === `${stem}/${stem}.md`) {
      occupied.add(stem);
    }
  }
  return occupied;
}

/** The physical work-state types the export must carry — every document kind
 * whose facts ride a collection of the transfer document. */
const CARRIED_TYPES = 'type:project,task,phase,initiative,seed,artifact,scratch';

/** How many offending paths a refusal names before it stops. */
const REFUSAL_SAMPLE = 20;

/** One physical document as the loss check sees it: where it lives, which
 * exported identity should represent it, and its raw frontmatter. */
type PhysicalDocument = {
  path: string;
  identity: string;
  frontmatter: Record<string, unknown>;
};

/**
 * Every physical work-state document in the vault, metadata only — the
 * independent census the export is checked against.
 *
 * Metadata only is what makes this affordable: no body crosses the wire, so the
 * whole-vault `find` stays well inside the response cap (NRN-s30, see
 * ./chunking) however large the documents are.
 */
async function physicalDocuments(client: NornClient): Promise<PhysicalDocument[]> {
  const docs = await client.find({ in: [CARRIED_TYPES], no_limit: true });
  return docs.map((doc) => {
    const frontmatter = doc.frontmatter ?? {};
    const stem = stemOf(doc.path);
    return {
      frontmatter,
      // A project is identified by its frontmatter `key`, which is what the
      // export keys it by and survives a physical relocation; every other kind
      // is identified by its stem, which IS its id.
      identity:
        collapse(frontmatter.type) === 'project' ? (collapse(frontmatter.key) ?? stem) : stem,
      path: doc.path,
    };
  });
}

/**
 * The frontmatter link fields whose exported counterpart the loss check compares
 * against the raw document, and the exported links of one identity under each.
 *
 * A REF the export drops is loss exactly as a whole document is: the validator
 * nulls a `parent` that resolves to no surviving node and prunes a `depends_on`
 * or `spawned` ref the same way, and the scratchpad decode nulls a dangling
 * `anchor`. The document survives, quietly thinner.
 *
 * A field absent from this map for a given identity is not compared — an
 * artifact's `anchor` list, for instance, is carried verbatim on its own record
 * with its dangling entries intact, so there is nothing to lose.
 */
type CarriedLinks = Map<string, Map<string, Set<string>>>;

function carriedLinks(document: StoreExport): CarriedLinks {
  const links: CarriedLinks = new Map();
  const put = (identity: string, field: string, refs: Iterable<string>): void => {
    const fields = links.get(identity) ?? new Map<string, Set<string>>();
    fields.set(field, new Set(refs));
    links.set(identity, fields);
  };
  const prereqs = groupBy(document.edges, (edge) => edge.node_id);
  for (const node of document.nodes) {
    // A bare project KEY in `parent` is a root marker, not an edge, so only a
    // `KEY-seq` parent is comparable — see the filter at the call site.
    put(node.id, 'parent', node.parent_id === null ? [] : [node.parent_id]);
    put(
      node.id,
      'depends_on',
      (prereqs.get(node.id) ?? []).map((edge) => edge.depends_on_node_id),
    );
  }
  for (const seed of document.seeds) {
    put(renderSeedRef(seed), 'spawned', seed.spawned);
  }
  for (const pad of document.scratchpads) {
    put(pad.id, 'anchor', pad.anchors);
  }
  return links;
}

/**
 * Fail closed: refuse the export when the vault holds a document or a link the
 * collections do not carry.
 *
 * Two losses, one refusal, because they have one repair. A document with no
 * representative was dropped by a tolerant decoder (a node whose project is
 * missing or whose lifecycle is foreign, an identity collision, a pad with an
 * unusable id or timestamp). A link on disk with no exported counterpart was
 * nulled or pruned by the validator ({@link carriedLinks}). Each is vault
 * corruption `mimir doctor` names and repairs, and each would leave the copy
 * quietly narrower than the original.
 */
function assertCarriesEveryDocument(
  document: StoreExport,
  physical: readonly PhysicalDocument[],
): void {
  const carried = new Set<string>([
    ...document.projects.map((project) => project.key),
    ...document.nodes.map((node) => node.id),
    ...document.artifacts.map((artifact) => renderArtifactRef(artifact)),
    ...document.seeds.map((seed) => renderSeedRef(seed)),
    ...document.scratchpads.map((pad) => pad.id),
  ]);
  const links = carriedLinks(document);

  const lost: string[] = [];
  for (const doc of physical) {
    if (!carried.has(doc.identity)) {
      lost.push(doc.path);
      continue;
    }
    const fields = links.get(doc.identity);
    if (fields === undefined) {
      continue;
    }
    for (const [field, exported] of fields) {
      const stored = linkStems(doc.frontmatter[field]).filter(
        // A `parent` naming a bare project KEY is the root marker, which the
        // export represents as a null `parent_id` rather than as an edge.
        (ref) => field !== 'parent' || parseId(ref) !== null,
      );
      if (stored.some((ref) => !exported.has(ref))) {
        lost.push(doc.path);
        break;
      }
    }
  }
  if (lost.length > 0) {
    throw validation(
      `the export cannot carry ${String(lost.length)} vault document(s): ${namedSample(lost.toSorted((a, b) => a.localeCompare(b)))}`,
      "the store read drops what it cannot resolve, and a copy that drops facts is not a backup — run 'mimir doctor' to find and repair the corruption, then export again",
    );
  }
}

/** The first {@link REFUSAL_SAMPLE} names, with a count of whatever is left —
 * a refusal must be actionable without printing a whole vault. */
function namedSample(names: readonly string[]): string {
  const shown = names.slice(0, REFUSAL_SAMPLE).join(', ');
  const rest = names.length - REFUSAL_SAMPLE;
  return rest > 0 ? `${shown} (and ${String(rest)} more)` : shown;
}

type StoredDocument = { frontmatter: Record<string, unknown>; body: string };

/**
 * Read whatever already occupies the given paths — absent paths are simply
 * missing from the map (norn yields no record rather than an error).
 *
 * Body-carrying, so byte-bounded like every other such read (NRN-s30, see
 * ./chunking): a resume asks after every document the transfer document holds,
 * which for a real vault is thousands of them.
 */
async function readDocuments(
  client: NornClient,
  paths: readonly string[],
  limits: ChunkLimits,
): Promise<Map<string, StoredDocument>> {
  const records = await readChunked(
    paths,
    () => ASSUMED_BODY_BYTES,
    limits,
    (path) => path,
    (chunk) => client.get([...chunk], '.frontmatter,.body'),
  );
  const found = new Map<string, StoredDocument>();
  for (const record of records) {
    const doc = storedDocument(record);
    if (doc !== null) {
      found.set(doc.path, { body: doc.body, frontmatter: doc.frontmatter });
    }
  }
  return found;
}

function storedDocument(record: unknown): (StoredDocument & { path: string }) | null {
  if (!isStringRecord(record) || typeof record.path !== 'string') {
    return null;
  }
  return {
    body: typeof record.body === 'string' ? record.body : '',
    frontmatter: isStringRecord(record.frontmatter) ? record.frontmatter : {},
    path: record.path,
  };
}

/**
 * Is what is on disk exactly what this import would write? Frontmatter compares
 * structurally (YAML key order is not a fact). The body compares after two
 * normalizations that are write-path artifacts rather than content: norn stores
 * markdown with exactly one trailing newline, and the history codec's canonical
 * line ending is LF (a CRLF re-save is the same document, MMR-167/MMR-172).
 */
function sameDocument(written: RawDocument, existing: StoredDocument): boolean {
  return (
    isDeepStrictEqual(existing.frontmatter, written.frontmatter) &&
    normalizeBody(existing.body) === normalizeBody(written.body)
  );
}

function normalizeBody(body: string): string {
  const canonical = toCanonicalLf(body);
  return canonical.endsWith('\n') ? canonical.slice(0, -1) : canonical;
}
