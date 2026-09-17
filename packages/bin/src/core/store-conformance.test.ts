import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { Scratchpad } from '@mimir/contract';

import type { TestStore } from '../testing/store';
import { createTestStore } from '../testing/store';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { MimirError } from './errors';
import type { StoreExport } from './export';
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
} from './mutations';
import type { Store } from './store';

/**
 * The `Store`-seam conformance oracle (MMR-378, ADR 0030) — the contract suite
 * every backend must satisfy, starting with export/import (Decision 4). It is
 * the thing that holds two backends behaviorally identical, so it is written
 * against the seam alone: no backend type appears below the `backends` table,
 * and MMR-379 adds the `postgres` arm by adding one row.
 *
 * The Norn arm needs a real `norn` binary and is skipped when it is off PATH.
 */
const NORN = Bun.which('norn') !== null;

// Every case builds one or two whole temp vaults over a `norn mcp` subprocess
// and exercises most of the write surface against them, which runs well past
// bun's 5s default on a loaded runner (the same budget the other
// subprocess-backed suites take).
setDefaultTimeout(60_000);

/**
 * One fresh, empty store of a backend, plus the two physical seams the Norn arm
 * needs and a Postgres arm would not have. Both are optional so a backend
 * without a document substrate can still run the seam-level cases; the cases
 * that use them say so.
 */
type Instance = {
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

type Backend = {
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
function vaultBodies(root: string): Map<string, string> {
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
function byPath(documents: Map<string, string>): [string, string][] {
  return [...documents].toSorted(([a], [b]) => a.localeCompare(b));
}

/**
 * Run an import that must be refused, and yield its refusal text (summary plus
 * hint) for assertion. `expect(...).rejects` is not available here — bun's
 * `expect` is synchronous — and the refusals under test are `MimirError`s whose
 * identifying subject may sit in either half.
 */
async function refusalOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return error instanceof MimirError
      ? `${error.message} — ${error.hint ?? ''}`
      : `unexpected error: ${String(error)}`;
  }
  throw new Error('expected the import to be refused, but it completed');
}

async function nornInstance(): Promise<Instance> {
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

const backends: Backend[] = [{ make: nornInstance, name: 'norn', skip: !NORN }];

// ── Fixture ────────────────────────────────────────────────────────────────

const PAD_ID = '123e4567-e89b-42d3-a456-426614174000';

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
async function seedWorkingSet(store: Store): Promise<void> {
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

function scratchpad(anchor: string): Scratchpad {
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
  };
}

// ── Seam-level observation ─────────────────────────────────────────────────

/**
 * Everything the seam can read back, in a shape two stores can be compared on.
 * Collections are sorted and Maps flattened so a backend's own ordering is not
 * mistaken for a difference in the facts.
 */
async function observe(store: Store): Promise<unknown> {
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
function withoutStamp(document: StoreExport): Omit<StoreExport, 'exported_at'> {
  const { exported_at: _stamp, ...rest } = document;
  return rest;
}

// One describe-free loop per backend; each arm carries its own skip.
// oxlint-disable-next-line vitest/prefer-each
for (const backend of backends) {
  const instances: Instance[] = [];
  const fresh = async (): Promise<Instance> => {
    const instance = await backend.make();
    instances.push(instance);
    return instance;
  };
  afterEach(async () => {
    while (instances.length > 0) {
      await instances.pop()?.close();
    }
  });

  test.skipIf(backend.skip)(
    `${backend.name}: export → import into a fresh store round-trips every collection`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();

      const target = await fresh();
      const report = await target.store.import(document, { mode: 'fresh' });
      expect(report.mode).toBe('fresh');
      expect(report.skipped).toBe(0);
      expect(report.created).toBeGreaterThan(0);

      expect(await observe(target.store)).toEqual(await observe(source.store));

      // A re-export of the target is the same document but for its stamp.
      const second = await target.store.export();
      expect(withoutStamp(second)).toEqual(withoutStamp(document));
      expect(second.exported_at).not.toBe('');

      // The counters state the allocation high-water mark per kind (ADR 0006).
      const mmr = document.projects.find((project) => project.key === 'MMR');
      expect(mmr?.counters).toEqual({ artifact: 2, node: 4, seed: 1 });

      // Byte-identity where the backend has documents: an imported body must
      // equal the one the normal write path grew, or the round trip is visible.
      if (source.bodies !== undefined && target.bodies !== undefined) {
        expect(byPath(target.bodies())).toEqual(byPath(source.bodies()));
      }
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: a create after an import never collides with an imported identity`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();
      const target = await fresh();
      await target.store.import(document, { mode: 'fresh' });

      const importedNodes = new Set(document.nodes.map((node) => node.id));
      const importedArtifacts = new Set(
        document.artifacts.map((artifact) => `${artifact.key}-a${String(artifact.seq)}`),
      );
      const importedSeeds = new Set(
        document.seeds.map((seed) => `${seed.key}-s${String(seed.seq)}`),
      );

      const phase = document.nodes.find((node) => node.type === 'phase');
      expect(phase).toBeDefined();
      const task = await createTask(target.store, {
        parentId: phase?.id ?? '',
        title: 'after the import',
      });
      const artifact = await target.store.artifacts.create({
        content: 'later',
        key: 'MMR',
        links: [],
        tags: [],
        title: 'Later',
      });
      const seed = await target.store.seeds.create({
        description: null,
        key: 'MMR',
        kind: 'idea',
        requester: null,
        title: 'Later seed',
      });

      expect(importedNodes.has(task.id)).toBe(false);
      expect(importedArtifacts.has(`${artifact.key}-a${String(artifact.seq)}`)).toBe(false);
      expect(importedSeeds.has(`${seed.key}-s${String(seed.seq)}`)).toBe(false);
      // Not merely distinct — past the imported high-water mark of each kind.
      expect(task.seq).toBeGreaterThan(document.projects[0]?.counters.node ?? 0);
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: a fresh import refuses when an imported project already exists`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();

      const target = await fresh();
      await createProject(target.store, { description: null, key: 'MMR', name: 'Occupied' });
      const before = await observe(target.store);

      expect(await refusalOf(target.store.import(document, { mode: 'fresh' }))).toContain('MMR');
      // Refused BEFORE writing anything.
      expect(await observe(target.store)).toEqual(before);
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: the export refuses a store holding a record it cannot carry`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      if (source.seedDocument === undefined) {
        return;
      }
      // An orphan: a task whose `parent` names a node that does not exist. The
      // tolerant read nulls that edge and hands back a root-level task (ADR
      // 0017), so an export that trusted the read would ship a DIFFERENT
      // hierarchy than the vault holds.
      await source.seedDocument('MMR/MMR-9.md', {
        created: '2026-09-01T00:00:00.000Z',
        lifecycle: 'active',
        parent: '[[MMR-99]]',
        project: '[[MMR]]',
        title: 'Orphan',
        type: 'task',
        updated_at: '2026-09-01T00:00:00.000Z',
      });

      const refusal = await refusalOf(source.store.export());
      expect(refusal).toContain('MMR/MMR-9.md');
      expect(refusal).toContain('mimir doctor');
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: the export refuses an identity claimed by two records`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      if (source.seedDocument === undefined) {
        return;
      }
      // Two documents resolving to one `KEY-a1`. Every seam read hides both, so
      // an export could only ship one of them — and would be choosing a winner
      // the store itself declines to choose.
      await source.seedDocument(
        'MMR/artifacts/spare/MMR-a1.md',
        {
          created: '2026-09-01T00:00:00.000Z',
          project: '[[MMR]]',
          title: 'Collider',
          type: 'artifact',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
        'other content',
      );

      expect(await refusalOf(source.store.export())).toContain('MMR-a1.md');
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: an import refuses a document claiming one identity twice`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();
      const first = document.artifacts.at(0);
      if (first === undefined) {
        throw new Error('the fixture must export at least one artifact');
      }
      const doubled: StoreExport = {
        ...document,
        artifacts: [...document.artifacts, { ...first, title: 'Impostor' }],
      };

      const target = await fresh();
      const before = await observe(target.store);
      expect(await refusalOf(target.store.import(doubled, { mode: 'fresh' }))).toContain('MMR-a1');
      // Refused BEFORE writing anything — the alternative is a half-written
      // target for a fault that was visible in the document all along.
      expect(await observe(target.store)).toEqual(before);
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: a fresh import refuses a project document that lost its key`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();

      const target = await fresh();
      if (target.seedDocument === undefined) {
        return;
      }
      // The project's canonical path is occupied, but the document no longer
      // carries the `key` field the occupancy read keys off. The path is the
      // identity the import is about to claim, so it must refuse on that alone —
      // otherwise the fence passes and the write refuses mid-import.
      await target.seedDocument('MMR/MMR.md', {
        created: '2026-09-01T00:00:00.000Z',
        name: 'Nameless',
        type: 'project',
        updated_at: '2026-09-01T00:00:00.000Z',
      });

      expect(await refusalOf(target.store.import(document, { mode: 'fresh' }))).toContain('MMR');
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: resume skips identical documents and refuses a differing one`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();

      const target = await fresh();
      const first = await target.store.import(document, { mode: 'fresh' });

      const resumed = await target.store.import(document, { mode: 'resume' });
      expect(resumed).toEqual({ created: 0, mode: 'resume', skipped: first.created });
      expect(await observe(target.store)).toEqual(await observe(source.store));

      // A half-written target — the state a partial import actually leaves
      // (ADR 0023) — is finished by the same resume: the missing documents are
      // written and every present one is skipped.
      if (target.removeDocument !== undefined) {
        target.removeDocument('MMR/artifacts/MMR-a1.md');
        target.removeDocument('MMR/seeds/MMR-s1.md');
        const finished = await target.store.import(document, { mode: 'resume' });
        expect(finished).toEqual({
          created: 2,
          mode: 'resume',
          skipped: first.created - 2,
        });
        expect(await observe(target.store)).toEqual(await observe(source.store));
      }

      if (target.corruptDocument === undefined) {
        return;
      }
      target.corruptDocument('MMR/MMR-4.md', (raw) => raw.replace('Import', 'Imported'));
      expect(await refusalOf(target.store.import(document, { mode: 'resume' }))).toContain(
        'MMR/MMR-4.md',
      );
    },
  );
}
