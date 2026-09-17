import { isDeepStrictEqual } from 'node:util';

import type { Kysely, Transaction } from 'kysely';

import { validation } from '../errors';
import type {
  ExportedBodySections,
  ExportedProject,
  ExportedTag,
  ImportOptions,
  ImportReport,
  StoreExport,
} from '../export';
import { STORE_EXPORT_SCHEMA_VERSION } from '../export';
import { renderArtifactRef, renderSeedRef } from '../ids';
import type { Node } from '../model';
import type { NewAnnotationRecord, NewTransitionRecord } from '../store';
import { now } from '../time';
import { assertSingleValuedIdentities } from '../transfer-validate';
import { exportArtifacts, insertExportedArtifact } from './artifacts';
import { createPostgresBodySectionStore } from './body-sections';
import type { DB } from './schema';
import { exportScratchpads, insertScratchpad } from './scratchpads';
import { exportSeeds, insertExportedSeed } from './seeds';
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
 * The whole transition log in ONE globally ordered collection — `(at, id)`,
 * which is this backend's true insertion order.
 *
 * Deliberately NOT the Norn shape (project rows, then node rows, each in
 * document order): a markdown vault has no global sequence to emit, so it emits
 * a per-entity one. This backend does, and emitting it is what makes an import
 * reproduce the source's own log order — which the resume cursor is derived
 * from, so a round trip through the transfer document leaves even the cursor
 * where it was.
 */
async function exportTransitions(ex: Executor): Promise<NewTransitionRecord[]> {
  const rows = await ex
    .selectFrom('transition_log')
    .selectAll()
    .orderBy('at')
    .orderBy('id')
    .execute();
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
  return records;
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

  return serializable(db, async (tx) => {
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

    for (const project of document.projects) {
      if (settle('projects', project.key)) {
        newProjects.add(project.key);
        await tx
          .insertInto('project')
          .values({
            archived_at: project.archived_at,
            created_at: project.created_at,
            description: project.description,
            key: project.key,
            last_artifact_seq: project.counters.artifact,
            last_seed_seq: project.counters.seed,
            last_seq: project.counters.node,
            name: project.name,
            ...nextOf(project.key),
            updated_at: project.updated_at,
          })
          .execute();
      } else {
        // The allocator never moves backwards: after the import the next create
        // must miss every identity the document brought (ADR 0006).
        await raiseCounters(tx, project);
      }
      await writeTags(tx, 'project', project.key, tagsFor(document, 'project', project.key));
    }

    for (const node of document.nodes) {
      if (!settle('nodes', node.id)) {
        continue;
      }
      newNodes.add(node.id);
      await tx
        .insertInto('node')
        .values({ ...nodeValues(node), ...nextOf(node.id) })
        .execute();
      await writeTags(tx, 'node', node.id, tagsFor(document, 'node', node.id));
    }
    // `description` is a column here but a body section in the document, so it
    // is written after the row rather than as part of it.
    for (const sections of document.bodySections) {
      if (newNodes.has(sections.stem) && sections.description !== undefined) {
        await tx
          .updateTable('node')
          .set({ description: sections.description })
          .where('id', '=', sections.stem)
          .execute();
      }
    }
    for (const edge of document.edges) {
      if (newNodes.has(edge.node_id)) {
        await tx
          .insertInto('dependency')
          .values({ depends_on_node_id: edge.depends_on_node_id, node_id: edge.node_id })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }
    for (const annotation of document.annotations) {
      if (newNodes.has(annotation.node_id)) {
        await tx.insertInto('annotation').values(annotation).execute();
      }
    }
    for (const row of document.transitions) {
      const entity = row.node_id ?? row.project_id ?? '';
      if (!newNodes.has(entity) && !newProjects.has(entity)) {
        continue;
      }
      await tx
        .insertInto('transition_log')
        .values({
          at: row.at,
          from_value: row.from_value,
          handles: row.handles === undefined ? null : JSON.stringify(row.handles),
          kind: row.kind,
          node_id: row.node_id ?? null,
          project_key: row.project_id ?? null,
          reason: row.reason ?? null,
          to_value: row.to_value,
        })
        .execute();
    }
    for (const artifact of document.artifacts) {
      if (settle('artifacts', renderArtifactRef(artifact))) {
        await insertExportedArtifact(tx, artifact);
      }
    }
    for (const seed of document.seeds) {
      if (settle('seeds', renderSeedRef(seed))) {
        await insertExportedSeed(tx, seed);
      }
    }
    for (const pad of document.scratchpads) {
      if (settle('scratchpads', pad.id)) {
        await insertScratchpad(tx, pad);
      }
    }
    return { created, mode: opts.mode, skipped };
  });
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
async function raiseCounters(tx: Transaction<DB>, project: ExportedProject): Promise<void> {
  await tx
    .updateTable('project')
    .set((eb) => ({
      last_artifact_seq: eb.fn('greatest', [
        eb.ref('last_artifact_seq'),
        eb.val(project.counters.artifact),
      ]),
      last_seed_seq: eb.fn('greatest', [eb.ref('last_seed_seq'), eb.val(project.counters.seed)]),
      last_seq: eb.fn('greatest', [eb.ref('last_seq'), eb.val(project.counters.node)]),
    }))
    .where('key', '=', project.key)
    .execute();
}

/** Tag rows for one entity, idempotently (a resume re-asserts what is there). */
async function writeTags(
  tx: Transaction<DB>,
  entityType: 'node' | 'project',
  entityId: string,
  tags: readonly string[],
): Promise<void> {
  if (tags.length === 0) {
    return;
  }
  await tx
    .insertInto('tag')
    .values(tags.map((tag) => ({ entity_id: entityId, entity_type: entityType, tag })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/** One exported node as its row — `description` and `next` ride the sections. */
function nodeValues(node: Node) {
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
