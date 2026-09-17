import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { Scratchpad } from '@mimir/contract';

import { createInitiative, createPhase, createProject, createTask } from '../core/create';
import { MimirError } from '../core/errors';
import type { StoreExport } from '../core/export';
import {
  annotate,
  archiveProject,
  attachArtifact,
  depend,
  startTask,
  submitTask,
  tagEntities,
  updateNode,
  updateProject,
} from '../core/mutations';
import type { Store } from '../core/store';
import type { TestStore } from './store';
import { createTestStore } from './store';

/**
 * The shared harness behind the `Store`-seam conformance suites (MMR-378/379,
 * ADR 0030) — the backend table, the fixture, and the seam-level observation
 * every conformance case reads through. It lives outside the test files so the
 * export/import oracle and the write-surface sweep run over ONE backend table:
 * a new backend joins both suites by adding a single row here.
 *
 * Written against the seam alone — no backend type appears below
 * {@link backends}.
 */

/** Whether the Norn arm can run: its store needs a real `norn` binary on PATH. */
export const NORN = Bun.which('norn') !== null;

/**
 * One fresh, empty store of a backend, plus the two physical seams the Norn arm
 * needs and a Postgres arm would not have. Both are optional so a backend
 * without a document substrate can still run the seam-level cases; the cases
 * that use them say so.
 */
export type Instance = {
  store: Store;
  /** Byte-exact document BODY read — proves an imported body equals a grown one. */
  bodies?: () => Map<string, string>;
  /** Deliberate hand-edit, for the resume refuse-on-differing case. */
  corruptDocument?: (path: string, mutate: (raw: string) => string) => void;
  /** Deliberate removal, to stage the half-written target a resume finishes. */
  removeDocument?: (path: string) => void;
  /** Write a document the typed API cannot produce — an orphan, a collider, a
   * project with no `key`. The fail-closed export cases need it; a backend with
   * no document substrate stages the same corruption its own way. */
  seedDocument?: (
    path: string,
    frontmatter: Record<string, unknown>,
    body?: string,
  ) => Promise<void>;
  close: () => Promise<void>;
};

export type Backend = {
  name: string;
  make: () => Promise<Instance>;
  skip: boolean;
};

/**
 * Every `.md` document's BODY in a vault, keyed by its vault-relative path.
 *
 * The body only, deliberately. Frontmatter *facts* are compared through the seam
 * ({@link observe}), while frontmatter *field order* is not a fact the write path
 * fixes: a grown document appends each newly-set field in the order the verbs
 * set it, and a created one emits the encoder's order, so the normal write path
 * itself has no single field order for a given set of facts. The BODY is
 * different — its section order and record spacing are load-bearing markdown
 * a human reads and norn's section ops target, so an imported body must match a
 * grown one byte for byte.
 */
export function vaultBodies(root: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const absolute = join(entry.parentPath, entry.name);
    found.set(relative(root, absolute), bodyOf(readFileSync(absolute, 'utf8')));
  }
  return found;
}

/** Everything after a document's leading `---` frontmatter block. */
function bodyOf(raw: string): string {
  const end = raw.indexOf('\n---\n', '---\n'.length);
  return end === -1 ? raw : raw.slice(end + '\n---\n'.length);
}

/** A path-keyed map as a path-ordered entry list, so two vaults compare. */
export function byPath(documents: Map<string, string>): [string, string][] {
  return [...documents].toSorted(([a], [b]) => a.localeCompare(b));
}

/**
 * Run an action that must be refused, and yield its refusal text (summary plus
 * hint) for assertion. `expect(...).rejects` is not available here — bun's
 * `expect` is synchronous — and the refusals under test are `MimirError`s whose
 * identifying subject may sit in either half.
 */
export async function refusalOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return error instanceof MimirError
      ? `${error.message} — ${error.hint ?? ''}`
      : `unexpected error: ${String(error)}`;
  }
  throw new Error('expected the call to be refused, but it completed');
}

/** The `MimirError` an action must reject with — for code plus message assertions. */
export async function errorOf(action: Promise<unknown>): Promise<MimirError> {
  try {
    await action;
  } catch (error) {
    if (error instanceof MimirError) {
      return error;
    }
    throw new Error(`expected a MimirError, got: ${String(error)}`, { cause: error });
  }
  throw new Error('expected the call to be refused, but it completed');
}

export async function nornInstance(): Promise<Instance> {
  const test_: TestStore = await createTestStore();
  return {
    bodies: () => vaultBodies(test_.vaultRoot),
    close: () => test_.close(),
    corruptDocument: test_.corruptDocument,
    removeDocument: test_.removeDocument,
    seedDocument: test_.seedDocument,
    store: test_.store,
  };
}

/** The backend table every conformance suite loops over. One row per backend. */
export const backends: Backend[] = [{ make: nornInstance, name: 'norn', skip: !NORN }];

// ── Fixture ────────────────────────────────────────────────────────────────

export const PAD_ID = '123e4567-e89b-42d3-a456-426614174000';

/**
 * A working set that touches every exported collection: two projects (one
 * archived), a container hierarchy, a dependency edge, tags on a node / a
 * project / an artifact, an annotation, an artifact with content and a link, a
 * seed with a description and a spawned link, a scratchpad, a `## Next`
 * narrative on both a project and a container, and several transitions —
 * including one carrying resume handles.
 *
 * Built through the ordinary verbs on purpose: the import must reproduce what
 * the NORMAL write path produces, so the oracle's source has to be grown that
 * way rather than hand-assembled.
 */
export async function seedWorkingSet(store: Store): Promise<void> {
  await createProject(store, {
    description: 'the work-state tool',
    key: 'MMR',
    name: 'Mimir',
    tags: ['core'],
  });
  await createProject(store, { description: null, key: 'OPS', name: 'Operations' });

  const initiative = await createInitiative(store, {
    description: 'the bridge',
    projectId: 'MMR',
    title: 'Shared store',
  });
  const phase = await createPhase(store, {
    parentId: initiative.id,
    target: '2026-12-01',
    title: 'Phase A',
  });
  const prereq = await createTask(store, {
    description: 'export first',
    parentId: phase.id,
    priority: 'p1',
    summary: 'the export',
    title: 'Export',
  });
  const dependent = await createTask(store, {
    parentId: phase.id,
    size: 'medium',
    title: 'Import',
  });

  await depend(store, dependent.id, [prereq.id]);
  await tagEntities(store, [{ entityId: prereq.id, entityType: 'node' }], ['api', 'urgent']);
  await annotate(store, prereq.id, 'a note with a ## heading line');

  // Two transitions, the first carrying resume handles.
  await startTask(store, prereq.id, { branch: 'feat/export', host: 'workbench' });
  await submitTask(store, prereq.id);

  await updateNode(store, initiative.id, { next: 'land the export, then the import' });
  await updateProject(store, 'MMR', { next: 'ship the bridge' });

  // A PRESENT but EMPTY `## Next` — the heading on the document with no prose
  // under it. The verbs cannot author it (a blank narrative is a clear), so it
  // goes through the writer directly, co-writing the stamp the write path
  // requires. Presence is a stored fact of its own: an export carrying only the
  // prose would drop the heading, and the round trip would be visible (MMR-378).
  await store.transact(async (w) => {
    await w.setNextSection('node', phase.id, { present: false, text: '' });
    await w.updateNode(phase.id, { updated_at: '2026-09-02T12:00:00.000Z' });
  });

  await attachArtifact(store, {
    content: '# spec\n\nthe transfer document',
    linkNodeIds: [prereq.id],
    projectId: 'MMR',
    summary: 'the transfer document',
    tags: ['spec'],
    title: 'Transfer spec',
  });

  // A body ending in a blank line — the edge a naive import sheds one newline
  // from per hop, because norn appends a trailing newline only when one is
  // absent while the read strips exactly one (found on a real vault).
  await store.artifacts.create({
    content: '# notes\n\n## Agenda\n\n',
    key: 'MMR',
    links: [],
    tags: [],
    title: 'Trailing newline',
  });

  const seed = await store.seeds.create({
    description: 'someone should look at the cutover',
    key: 'MMR',
    kind: 'idea',
    requester: 'OPS',
    title: 'Cutover',
  });
  await store.seeds.germinate(seed.key, seed.seq, dependent.id);

  await store.scratchpads.create(scratchpad(prereq.id));

  // Archived last: an archived project refuses further writes, and its archive
  // transition is the project-keyed `## History` row the export must carry.
  await archiveProject(store, 'OPS');
}

/** The fixture scratchpad, anchored to a node the caller names. */
export function scratchpad(anchor: string, overrides: Partial<Scratchpad> = {}): Scratchpad {
  return {
    agenda: [{ content: 'settle the document shape', number: 1, reason: null, state: 'open' }],
    anchors: [anchor],
    createdAt: '2026-09-01T12:00:00.000Z',
    freezingAt: null,
    id: PAD_ID,
    journal: [{ at: '2026-09-01T12:00:00.000Z', content: 'started', number: 1 }],
    project: 'MMR',
    title: 'Bridge notes',
    updatedAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
  };
}

// ── Seam-level observation ─────────────────────────────────────────────────

/**
 * Everything the seam can read back, in a shape two stores can be compared on.
 * Collections are sorted and Maps flattened so a backend's own ordering is not
 * mistaken for a difference in the facts.
 */
export async function observe(store: Store): Promise<unknown> {
  const workingSet = await store.loadWorkingSet();
  const projects = [...workingSet.projects].toSorted((a, b) => a.key.localeCompare(b.key));
  const nodes = [...workingSet.nodes].toSorted((a, b) => a.id.localeCompare(b.id));
  const stems = [...projects.map((p) => p.key), ...nodes.map((n) => n.id)];
  const artifacts = [];
  for (const project of projects) {
    for (const record of await store.artifacts.listForProject(project.key)) {
      artifacts.push(await store.artifacts.load(record.key, record.seq, { content: true }));
    }
  }
  const seeds = [];
  for (const record of (await store.seeds.listAll()).toSorted((a, b) => a.seq - b.seq)) {
    seeds.push({
      history: await store.seeds.loadHistory(record.key, record.seq),
      record: await store.seeds.load(record.key, record.seq, { content: true }),
    });
  }
  const sections = await store.bodySections.readSectionsMany(stems, {
    annotations: true,
    description: true,
    history: true,
    next: true,
  });
  return {
    artifacts,
    bodySections: [...sections].toSorted(([a], [b]) => a.localeCompare(b)),
    edges: [...workingSet.edges].toSorted((a, b) => a.node_id.localeCompare(b.node_id)),
    nodeTags: [...workingSet.nodeTags].toSorted(([a], [b]) => a.localeCompare(b)),
    nodes,
    projectTags: [...workingSet.projectTags].toSorted(([a], [b]) => a.localeCompare(b)),
    projects,
    projectsRead: [...(await store.loadProjects())].toSorted((a, b) => a.key.localeCompare(b.key)),
    scratchpads: await store.scratchpads.list(),
    seeds,
    transitions: await store.transitions.list(),
  };
}

/** Everything but the stamp — the part of an export that must be reproducible. */
export function withoutStamp(document: StoreExport): Omit<StoreExport, 'exported_at'> {
  const { exported_at: _stamp, ...rest } = document;
  return rest;
}
