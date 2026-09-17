import { isDeepStrictEqual } from 'node:util';

import type { Insertable, Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import { validation } from '../errors';
import type {
  ExportedBodySections,
  ExportedCounters,
  ExportedProject,
  ExportedTag,
  ImportOptions,
  ImportReport,
  StoreExport,
} from '../export';
import {
  canonicalSetOrder,
  canonicalTransitionOrder,
  STORE_EXPORT_SCHEMA_VERSION,
} from '../export';
import { renderArtifactRef, renderSeedRef } from '../ids';
import type { Node } from '../model';
import type { NewAnnotationRecord, NewTransitionRecord } from '../store';
import { now } from '../time';
import { parseTransferDocument } from '../transfer-validate';
import { exportArtifacts, insertExportedArtifacts } from './artifacts';
import { insertBatched, pairKey } from './batch';
import { createPostgresBodySectionStore } from './body-sections';
import type {
  AnnotationTable,
  DB,
  DependencyTable,
  NodeTable,
  ProjectTable,
  TagTable,
  TransitionLogTable,
} from './schema';
import { exportScratchpads, insertScratchpads } from './scratchpads';
import { exportSeeds, insertExportedSeeds } from './seeds';
import type { Executor } from './tx';
import { serializable, snapshotRead } from './tx';
import { loadWorkingSet } from './working-set';

/**
 * The Postgres backend's export and import (ADR 0030 Decision 4) — the whole
 * store's stored facts out to one backend-neutral document, and such a document
 * back in with every id, sequence, and timestamp preserved.
 *
 * **The export never refuses.** The Norn export has to: its reader is tolerant
 * of corruption a vault can hold, so it re-enumerates the physical documents and
 * fails closed on anything the collections dropped. The relational schema makes
 * every one of those states unrepresentable — an orphan violates a foreign key,
 * a collider violates a primary key, a dangling edge violates both — so there is
 * nothing for a census to find and no refusal to make.
 *
 * **Import compares through the export.** A `resume` must skip a record a prior
 * run already wrote and refuse one that differs, which means deciding whether
 * the target's version of a record is the same record. Rather than hand-writing
 * that comparison per collection, the import EXPORTS the target and compares the
 * two documents: the shapes are identical by construction, so "identical" means
 * what the transfer document says it means, and the two halves cannot drift.
 *
 * **Import writes whole collections, not rows.** Every table is filled by
 * multi-row INSERTs chunked under the bind-parameter ceiling (see ./batch): the
 * import's cost is otherwise one round trip per record, and a real board brings
 * tens of thousands. The decisions come first and the statements second — the
 * loops below settle every record into a batch, and the batches are written in
 * foreign-key order afterwards.
 *
 * **A preview runs the whole import and rolls it back** (`dryRun`, MMR-380).
 * Every check an apply makes is a check this backend makes IN the transaction —
 * the fence, the per-record settle, and the constraints themselves — so the
 * preview cannot use a second implementation. Shared validation rejects faults
 * in the supplied document before this transaction. The preview still forces
 * deferred database constraints before rollback, so target-state failures are
 * checked without relying on a COMMIT it never reaches.
 */

/** Every body-section facet the export reads, in one batched pass. */
const EXPORT_FACETS = { annotations: true, description: true, next: true } as const;

export async function exportPostgresStore(ex: Executor): Promise<StoreExport> {
  const workingSet = await loadWorkingSet(ex);
  const counters = await ex
    .selectFrom('project')
    .select(['key', 'last_seq', 'last_artifact_seq', 'last_seed_seq'])
    .execute();
  const countersByKey = new Map(counters.map((row) => [row.key, row]));
  const projects = [...workingSet.projects];
  const nodes = [...workingSet.nodes];
  const sections = await createPostgresBodySectionStore(ex).readSectionsMany(
    [...projects.map((project) => project.key), ...nodes.map((node) => node.id)],
    EXPORT_FACETS,
  );

  // Re-sorted in JS, not trusted from the SQL `ORDER BY` that read them: that
  // order is the database's collation, which the operator chose and a vault
  // does not have (see `canonicalSetOrder`).
  const tags: ExportedTag[] = [
    ...projects.flatMap((project) =>
      canonicalSetOrder((workingSet.projectTags.get(project.key) ?? []).map((row) => row.tag)).map(
        (tag): ExportedTag => ({ entity_id: project.key, entity_type: 'project', tag }),
      ),
    ),
    ...nodes.flatMap((node) =>
      canonicalSetOrder((workingSet.nodeTags.get(node.id) ?? []).map((row) => row.tag)).map(
        (tag): ExportedTag => ({ entity_id: node.id, entity_type: 'node', tag }),
      ),
    ),
  ];

  const annotations: NewAnnotationRecord[] = nodes.flatMap((node) =>
    (sections.get(node.id)?.annotations ?? []).map(
      (view): NewAnnotationRecord => ({
        content: view.content,
        created_at: view.createdAt,
        node_id: node.id,
      }),
    ),
  );

  const transitions = await exportTransitions(ex);

  const bodySections: ExportedBodySections[] = [
    // A project carries no description section — its description is a column on
    // the project record — so only `next` is projected.
    ...projects.flatMap((project) => ownedSections(project.key, sections.get(project.key)?.next)),
    ...nodes.flatMap((node) =>
      ownedSections(
        node.id,
        sections.get(node.id)?.next,
        sections.get(node.id)?.description ?? null,
      ),
    ),
  ];

  const exportedProjects: ExportedProject[] = [];
  for (const project of projects) {
    const row = countersByKey.get(project.key);
    exportedProjects.push({
      archived_at: project.archived_at,
      counters: {
        artifact: row?.last_artifact_seq ?? 0,
        node: row?.last_seq ?? 0,
        seed: row?.last_seed_seq ?? 0,
      },
      created_at: project.created_at,
      description: project.description,
      key: project.key,
      name: project.name,
      updated_at: project.updated_at,
    });
  }

  return {
    annotations,
    artifacts: await exportArtifacts(ex),
    bodySections,
    edges: [...workingSet.edges],
    exported_at: now(),
    nodes,
    projects: exportedProjects,
    schema_version: STORE_EXPORT_SCHEMA_VERSION,
    scratchpads: await exportScratchpads(ex),
    seeds: await exportSeeds(ex),
    tags,
    transitions,
  };
}

/**
 * The transition log in the seam's canonical order (see
 * `canonicalTransitionOrder`): rows are read in insert order, which is this
 * backend's document order per entity — the stored fact ADR 0015 names — and
 * then grouped by entity the way every backend groups them, so a Norn export
 * and a Postgres export of the same facts are equal as values (the file writer
 * fixes key order, so the files are byte-identical too — `canonicalJson`). The
 * global insert order is NOT emitted: it is not a stored fact, and an import
 * puts the rows back in the order it reads them, which the canonical order
 * keeps per entity.
 *
 * One consequence the `transitions` FEED shows: two transitions on DIFFERENT
 * entities stamped in the same millisecond may swap places in that feed's
 * `(at, id)` order after a round trip, because the import re-numbers the rows
 * in canonical order rather than the source's insert order. Nothing is lost —
 * the global insert order was never a fact — and each entity's own order holds.
 */
async function exportTransitions(ex: Executor): Promise<NewTransitionRecord[]> {
  const rows = await ex.selectFrom('transition_log').selectAll().orderBy('id').execute();
  const records: NewTransitionRecord[] = [];
  for (const row of rows) {
    records.push({
      at: row.at,
      from_value: row.from_value,
      kind: row.kind,
      reason: row.reason,
      to_value: row.to_value,
      // Entity-keyed (ADR 0015): exactly one of the two is set, so the record
      // carries exactly the one key rather than a null under the other.
      ...(row.node_id === null ? { project_id: row.project_key } : { node_id: row.node_id }),
      ...(row.handles === null ? {} : { handles: row.handles }),
    });
  }
  return canonicalTransitionOrder(records);
}

/**
 * One document's owned prose sections, omitted entirely when it carries none.
 * "Carries none" is presence, not prose: a present-but-empty `## Next` is a
 * document state an import must reproduce, so it earns a row with a null text.
 */
function ownedSections(
  stem: string,
  next: ExportedBodySections['next'] | undefined,
  description?: string | null,
): ExportedBodySections[] {
  const facet = next ?? { present: false, text: null };
  if ((description ?? null) === null && !facet.present) {
    return [];
  }
  return [{ next: facet, stem, ...(description === undefined ? {} : { description }) }];
}

// ── Import ─────────────────────────────────────────────────────────────────

/**
 * One record plus every fact that rides with it — what "already present and
 * identical" compares. Derived from a whole {@link StoreExport} so the incoming
 * document and the target's own export are read by the same code.
 */
type Bundles = {
  projects: Map<string, unknown>;
  nodes: Map<string, unknown>;
  artifacts: Map<string, unknown>;
  seeds: Map<string, unknown>;
  scratchpads: Map<string, unknown>;
};

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    index.set(key, [...(index.get(key) ?? []), row]);
  }
  return index;
}

/**
 * Every entity's tag set, indexed once per document (MMR-380).
 *
 * Indexed rather than filtered per entity: the naive scan is one pass over the
 * whole tag collection per node AND per project — quadratic in a board's size,
 * and the import's dominant cost once the round trips are batched away.
 */
type TagIndex = ReadonlyMap<string, string[]>;

function tagIndexKey(entityType: 'node' | 'project', id: string): string {
  return `${entityType}|${id}`;
}

function indexTags(document: StoreExport): TagIndex {
  const index = new Map<string, string[]>();
  for (const row of document.tags) {
    if (row.entity_type !== 'node' && row.entity_type !== 'project') {
      continue;
    }
    const key = tagIndexKey(row.entity_type, row.entity_id);
    const tags = index.get(key);
    if (tags === undefined) {
      index.set(key, [row.tag]);
    } else {
      tags.push(row.tag);
    }
  }
  // One set order for every backend, applied after the read (`canonicalSetOrder`).
  for (const [key, tags] of index) {
    index.set(key, canonicalSetOrder(tags));
  }
  return index;
}

function tagsFor(tags: TagIndex, entityType: 'node' | 'project', id: string): string[] {
  return tags.get(tagIndexKey(entityType, id)) ?? [];
}

function bundlesOf(document: StoreExport): Bundles {
  const owned = new Map(document.bodySections.map((sections) => [sections.stem, sections]));
  const tags = indexTags(document);
  const annotations = groupBy(document.annotations, (row) => row.node_id);
  const prereqs = groupBy(document.edges, (edge) => edge.node_id);
  const history = groupBy(document.transitions, (row) => row.node_id ?? row.project_id ?? '');
  const bundles: Bundles = {
    artifacts: new Map(),
    nodes: new Map(),
    projects: new Map(),
    scratchpads: new Map(),
    seeds: new Map(),
  };
  for (const project of document.projects) {
    const { counters: _counters, ...record } = project;
    bundles.projects.set(project.key, {
      history: (history.get(project.key) ?? []).map(comparableTransition),
      next: owned.get(project.key)?.next ?? null,
      record,
      tags: tagsFor(tags, 'project', project.key),
    });
  }
  for (const node of document.nodes) {
    bundles.nodes.set(node.id, {
      annotations: (annotations.get(node.id) ?? []).map((row) => ({
        content: row.content,
        created_at: row.created_at,
      })),
      description: owned.get(node.id)?.description ?? null,
      history: (history.get(node.id) ?? []).map(comparableTransition),
      next: owned.get(node.id)?.next ?? null,
      prereqs: canonicalSetOrder(
        (prereqs.get(node.id) ?? []).map((edge) => edge.depends_on_node_id),
      ),
      record: node,
      tags: tagsFor(tags, 'node', node.id),
    });
  }
  for (const artifact of document.artifacts) {
    bundles.artifacts.set(renderArtifactRef(artifact), artifact);
  }
  for (const seed of document.seeds) {
    bundles.seeds.set(renderSeedRef(seed), seed);
  }
  for (const pad of document.scratchpads) {
    bundles.scratchpads.set(pad.id, pad);
  }
  return bundles;
}

/**
 * One transition in the shape a resume compares on: without its entity key (the
 * entity is the bundle it rides in), and canonical in the two fields a document
 * may spell two ways.
 *
 * `reason` is `string | null | undefined` on the record, so a document that
 * OMITS it imports fine and re-exports it as an explicit null — and a deep
 * compare reads absent and null as different, which made a document refuse its
 * own resume (MMR-380). `handles` is the mirror case and stays absent-when-
 * absent, which is how both backends emit it.
 */
function comparableTransition(row: NewTransitionRecord): unknown {
  const { node_id: _node, project_id: _project, handles, reason, ...rest } = row;
  return { ...rest, reason: reason ?? null, ...(handles === undefined ? {} : { handles }) };
}

/** The refusal a `resume` raises when the target's record is not this one. */
function differs(identity: string): never {
  throw validation(
    `${identity} already exists and differs from the transfer document`,
    'a resume may only skip records a prior run of this same import wrote — inspect that record, or import into a clean target',
  );
}

/**
 * Ends a preview's transaction without failing the import (MMR-380).
 *
 * Private and never thrown past this module. It carries no SQLSTATE, so
 * `withSerializableRetry` treats it as it treats any deterministic failure —
 * propagated, never replayed — and the catch below turns it back into the
 * report the rolled-back transaction computed.
 */
class PreviewRollbackError extends Error {
  readonly report: ImportReport;

  constructor(report: ImportReport) {
    super('the import preview rolled back');
    this.name = 'PreviewRollbackError';
    this.report = report;
  }
}

export async function importPostgresStore(
  db: Kysely<DB>,
  input: unknown,
  opts: ImportOptions,
): Promise<ImportReport> {
  const document = parseTransferDocument(input);
  const incoming = bundlesOf(document);

  try {
    return await serializable(db, async (tx) => {
      const report = await applyImport(tx, document, opts, incoming);
      if (!report.applied) {
        // Force target-state constraints before the rollback that replaces COMMIT.
        await sql`set constraints all immediate`.execute(tx);
        throw new PreviewRollbackError(report);
      }
      return report;
    });
  } catch (error) {
    if (error instanceof PreviewRollbackError) {
      return error.report;
    }
    throw error;
  }
}

/** The whole import inside one open transaction — the preview runs it too. */
async function applyImport(
  tx: Transaction<DB>,
  document: StoreExport,
  opts: ImportOptions,
  incoming: Bundles,
): Promise<ImportReport> {
  if (opts.mode === 'fresh') {
    // Refuse BEFORE writing anything: a fresh import owns the identities it
    // brings, and an existing project means the target already holds some.
    const occupied = new Set(
      (await tx.selectFrom('project').select('key').execute()).map((row) => row.key),
    );
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
  }
  const present =
    opts.mode === 'resume'
      ? bundlesOf(await exportPostgresStore(tx))
      : bundlesOf({ ...document, ...EMPTY_COLLECTIONS });

  let created = 0;
  let skipped = 0;
  /** Decide one record: skip an identical present one, refuse a differing one. */
  const settle = (kind: keyof Bundles, identity: string): boolean => {
    const existing = present[kind].get(identity);
    if (existing === undefined) {
      created += 1;
      return true;
    }
    if (!isDeepStrictEqual(existing, incoming[kind].get(identity))) {
      differs(identity);
    }
    skipped += 1;
    return false;
  };

  const ownedSectionsByStem = new Map(
    document.bodySections.map((sections) => [sections.stem, sections]),
  );
  const nextOf = (stem: string): { next_present: boolean; next_text: string | null } => {
    const facet = ownedSectionsByStem.get(stem)?.next;
    return { next_present: facet?.present ?? false, next_text: facet?.text ?? null };
  };

  const newNodes = new Set<string>();
  const newProjects = new Set<string>();

  const projectRows: Insertable<ProjectTable>[] = [];
  const stale: { key: string; counters: ExportedCounters }[] = [];
  const tagRows: Insertable<TagTable>[] = [];
  const tags = indexTags(document);
  const pushTags = (entityType: 'node' | 'project', entityId: string): void => {
    for (const tag of tagsFor(tags, entityType, entityId)) {
      tagRows.push({ entity_id: entityId, entity_type: entityType, tag });
    }
  };

  const carried = carriedSequences(document);
  for (const project of document.projects) {
    const counters = importedCounters(carried, project);
    if (settle('projects', project.key)) {
      newProjects.add(project.key);
      projectRows.push({
        archived_at: project.archived_at,
        created_at: project.created_at,
        description: project.description,
        key: project.key,
        last_artifact_seq: counters.artifact,
        last_seed_seq: counters.seed,
        last_seq: counters.node,
        name: project.name,
        ...nextOf(project.key),
        updated_at: project.updated_at,
      });
    } else {
      // The allocator never moves backwards: after the import the next create
      // must miss every identity the document brought (ADR 0006), and must not
      // fall back below what a prior run of this import already set.
      stale.push({ counters, key: project.key });
    }
    pushTags('project', project.key);
  }

  const nodeRows: Insertable<NodeTable>[] = [];
  for (const node of document.nodes) {
    if (!settle('nodes', node.id)) {
      continue;
    }
    newNodes.add(node.id);
    nodeRows.push({
      ...nodeValues(node),
      // `description` is a body section in the document and a column here, so
      // it rides the row rather than a follow-up UPDATE per node.
      description: ownedSectionsByStem.get(node.id)?.description ?? null,
      ...nextOf(node.id),
    });
    pushTags('node', node.id);
  }

  const edgeRows = new Map<string, Insertable<DependencyTable>>();
  for (const edge of document.edges) {
    if (newNodes.has(edge.node_id)) {
      // Deduped across the batch: a repeated edge would be settled by the
      // conflict clause anyway, but not before spending bind parameters.
      edgeRows.set(pairKey(edge.node_id, edge.depends_on_node_id), {
        depends_on_node_id: edge.depends_on_node_id,
        node_id: edge.node_id,
      });
    }
  }

  const annotationRows: Insertable<AnnotationTable>[] = document.annotations
    .filter((annotation) => newNodes.has(annotation.node_id))
    .map((annotation) => ({
      content: annotation.content,
      created_at: annotation.created_at,
      node_id: annotation.node_id,
    }));

  const transitionRows: Insertable<TransitionLogTable>[] = [];
  for (const row of document.transitions) {
    const entity = row.node_id ?? row.project_id ?? '';
    if (!newNodes.has(entity) && !newProjects.has(entity)) {
      continue;
    }
    transitionRows.push({
      at: row.at,
      from_value: row.from_value,
      handles: row.handles === undefined ? null : JSON.stringify(row.handles),
      kind: row.kind,
      node_id: row.node_id ?? null,
      project_key: row.project_id ?? null,
      reason: row.reason ?? null,
      to_value: row.to_value,
    });
  }

  const artifacts = document.artifacts.filter((artifact) =>
    settle('artifacts', renderArtifactRef(artifact)),
  );
  const seeds = document.seeds.filter((seed) => settle('seeds', renderSeedRef(seed)));
  const pads = document.scratchpads.filter((pad) => settle('scratchpads', pad.id));

  // Written in foreign-key order: a project owns its nodes, artifacts, seeds,
  // and pads, and a node owns its edges, annotations, and transitions.
  await insertBatched(projectRows, (chunk) => tx.insertInto('project').values(chunk).execute());
  for (const project of stale) {
    await raiseCounters(tx, project.key, project.counters);
  }
  await insertBatched(nodeRows, (chunk) => tx.insertInto('node').values(chunk).execute());
  await insertBatched(tagRows, (chunk) =>
    tx
      .insertInto('tag')
      .values(chunk)
      .onConflict((oc) => oc.doNothing())
      .execute(),
  );
  await insertBatched([...edgeRows.values()], (chunk) =>
    tx
      .insertInto('dependency')
      .values(chunk)
      .onConflict((oc) => oc.doNothing())
      .execute(),
  );
  await insertBatched(annotationRows, (chunk) =>
    tx.insertInto('annotation').values(chunk).execute(),
  );
  await insertBatched(transitionRows, (chunk) =>
    tx.insertInto('transition_log').values(chunk).execute(),
  );
  await insertExportedArtifacts(tx, artifacts);
  await insertExportedSeeds(tx, seeds);
  await insertScratchpads(tx, pads);

  return { applied: !opts.dryRun, created, mode: opts.mode, skipped };
}

/**
 * The highest sequence of each kind the document actually CONTAINS, per project
 * — one pass over each collection rather than one pass per project (MMR-380).
 */
type CarriedSequences = {
  artifact: ReadonlyMap<string, number>;
  node: ReadonlyMap<string, number>;
  seed: ReadonlyMap<string, number>;
};

function raise(highest: Map<string, number>, key: string, seq: number): void {
  highest.set(key, Math.max(highest.get(key) ?? 0, seq));
}

function carriedSequences(document: StoreExport): CarriedSequences {
  const artifact = new Map<string, number>();
  const node = new Map<string, number>();
  const seed = new Map<string, number>();
  for (const row of document.artifacts) {
    raise(artifact, row.key, row.seq);
  }
  for (const row of document.nodes) {
    raise(node, row.project_id, row.seq);
  }
  for (const row of document.seeds) {
    raise(seed, row.key, row.seq);
  }
  return { artifact, node, seed };
}

/**
 * The counters a project must carry AFTER an import: never below the highest
 * sequence of its kind the document actually brings (MMR-379).
 *
 * The carried counter is not trusted on its own. A hand-edited or
 * foreign-backend document can state a counter BELOW the sequences it also
 * carries, and a store that wrote it verbatim would re-hand an identity the
 * same import just wrote — the next create would then die on a raw primary-key
 * violation. The allocator never moves backwards (ADR 0006), so the written
 * value is the greatest of what the document claims and what it contains.
 */
function importedCounters(
  carried: CarriedSequences,
  project: ExportedProject,
): { artifact: number; node: number; seed: number } {
  return {
    artifact: Math.max(project.counters.artifact, carried.artifact.get(project.key) ?? 0),
    node: Math.max(project.counters.node, carried.node.get(project.key) ?? 0),
    seed: Math.max(project.counters.seed, carried.seed.get(project.key) ?? 0),
  };
}

/** An otherwise-valid document with no records — the `fresh` mode's empty target. */
const EMPTY_COLLECTIONS = {
  annotations: [],
  artifacts: [],
  bodySections: [],
  edges: [],
  nodes: [],
  projects: [],
  scratchpads: [],
  seeds: [],
  tags: [],
  transitions: [],
} satisfies Omit<StoreExport, 'exported_at' | 'schema_version'>;

/** Raise a present project's counters to cover the identities being imported. */
async function raiseCounters(
  tx: Transaction<DB>,
  key: string,
  counters: { artifact: number; node: number; seed: number },
): Promise<void> {
  await tx
    .updateTable('project')
    .set((eb) => ({
      last_artifact_seq: eb.fn('greatest', [
        eb.ref('last_artifact_seq'),
        eb.val(counters.artifact),
      ]),
      last_seed_seq: eb.fn('greatest', [eb.ref('last_seed_seq'), eb.val(counters.seed)]),
      last_seq: eb.fn('greatest', [eb.ref('last_seq'), eb.val(counters.node)]),
    }))
    .where('key', '=', key)
    .execute();
}

/** One exported node as its row — `description` and `next` ride the sections. */
function nodeValues(node: Node): Insertable<NodeTable> {
  return {
    branch: node.branch,
    completed_at: node.completed_at,
    created_at: node.created_at,
    description: null,
    external_ref: node.external_ref,
    harness: node.harness,
    hold: node.hold,
    hold_reason: node.hold_reason,
    host: node.host,
    id: node.id,
    lifecycle: node.lifecycle,
    open_ended: node.open_ended,
    parent_id: node.parent_id,
    priority: node.priority,
    project_key: node.project_id,
    rank: node.rank,
    seq: node.seq,
    session: node.session,
    size: node.size,
    summary: node.summary,
    target: node.target,
    title: node.title,
    type: node.type,
    updated_at: node.updated_at,
    upstream: node.upstream,
  };
}

/** The whole store's stored facts, read over one consistent snapshot. */
export function exportPostgresStoreFrom(db: Kysely<DB>): Promise<StoreExport> {
  return snapshotRead(db, (tx) => exportPostgresStore(tx));
}
