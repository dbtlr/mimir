import { isDeepStrictEqual } from 'node:util';

import type { Insertable, Kysely, Transaction } from 'kysely';

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
import { canonicalTransitionOrder, STORE_EXPORT_SCHEMA_VERSION } from '../export';
import { renderArtifactRef, renderSeedRef } from '../ids';
import type { Node } from '../model';
import type { NewAnnotationRecord, NewTransitionRecord } from '../store';
import { now } from '../time';
import { assertSingleValuedIdentities } from '../transfer-validate';
import { exportArtifacts, insertExportedArtifacts } from './artifacts';
import { insertBatched } from './batch';
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
 * preview cannot be a cheaper simulation without being a second implementation
 * that drifts. It is the same transaction, ended by {@link PreviewRollbackError}
 * instead of a commit.
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

  const tags: ExportedTag[] = [
    ...projects.flatMap((project) =>
      (workingSet.projectTags.get(project.key) ?? []).map(
        (record): ExportedTag => ({
          entity_id: project.key,
          entity_type: 'project',
          tag: record.tag,
        }),
      ),
    ),
    ...nodes.flatMap((node) =>
      (workingSet.nodeTags.get(node.id) ?? []).map(
        (record): ExportedTag => ({ entity_id: node.id, entity_type: 'node', tag: record.tag }),
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
 * and a Postgres export of the same facts are byte-identical. The global
 * insert order is NOT emitted: it is not a stored fact, and an import puts the
 * rows back in the order it reads them, which the canonical order keeps
 * per entity.
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

function tagsFor(document: StoreExport, entityType: 'node' | 'project', id: string): string[] {
  return document.tags
    .filter((tag) => tag.entity_type === entityType && tag.entity_id === id)
    .map((tag) => tag.tag)
    .toSorted();
}

function bundlesOf(document: StoreExport): Bundles {
  const owned = new Map(document.bodySections.map((sections) => [sections.stem, sections]));
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
      history: (history.get(project.key) ?? []).map(withoutEntity),
      next: owned.get(project.key)?.next ?? null,
      record,
      tags: tagsFor(document, 'project', project.key),
    });
  }
  for (const node of document.nodes) {
    bundles.nodes.set(node.id, {
      annotations: (annotations.get(node.id) ?? []).map((row) => ({
        content: row.content,
        created_at: row.created_at,
      })),
      description: owned.get(node.id)?.description ?? null,
      history: (history.get(node.id) ?? []).map(withoutEntity),
      next: owned.get(node.id)?.next ?? null,
      prereqs: (prereqs.get(node.id) ?? []).map((edge) => edge.depends_on_node_id).toSorted(),
      record: node,
      tags: tagsFor(document, 'node', node.id),
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

/** A transition without its entity key — the entity is the bundle it rides in. */
function withoutEntity(row: NewTransitionRecord): unknown {
  const { node_id: _node, project_id: _project, ...rest } = row;
  return rest;
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
  document: StoreExport,
  opts: ImportOptions,
): Promise<ImportReport> {
  if (document.schema_version !== STORE_EXPORT_SCHEMA_VERSION) {
    throw validation(
      `unsupported transfer document schema version ${String(document.schema_version)}`,
      `this binary reads schema version ${String(STORE_EXPORT_SCHEMA_VERSION)}`,
    );
  }
  assertSingleValuedIdentities(document);
  const incoming = bundlesOf(document);

  try {
    return await serializable(db, async (tx) => {
      const report = await applyImport(tx, document, opts, incoming);
      if (!report.applied) {
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
  const pushTags = (entityType: 'node' | 'project', entityId: string): void => {
    for (const tag of tagsFor(document, entityType, entityId)) {
      tagRows.push({ entity_id: entityId, entity_type: entityType, tag });
    }
  };

  for (const project of document.projects) {
    const counters = importedCounters(document, project);
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
      edgeRows.set(JSON.stringify([edge.node_id, edge.depends_on_node_id]), {
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

  return { applied: opts.dryRun !== true, created, mode: opts.mode, skipped };
}

/** The largest sequence in the list; zero when the kind brings none. */
function highest(seqs: readonly number[]): number {
  return seqs.reduce((max, seq) => Math.max(max, seq), 0);
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
  document: StoreExport,
  project: ExportedProject,
): { artifact: number; node: number; seed: number } {
  return {
    artifact: Math.max(
      project.counters.artifact,
      highest(document.artifacts.filter((a) => a.key === project.key).map((a) => a.seq)),
    ),
    node: Math.max(
      project.counters.node,
      highest(document.nodes.filter((n) => n.project_id === project.key).map((n) => n.seq)),
    ),
    seed: Math.max(
      project.counters.seed,
      highest(document.seeds.filter((seed) => seed.key === project.key).map((seed) => seed.seq)),
    ),
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
