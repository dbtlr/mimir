import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTestDb } from '../db/testing';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { createNornWriteStore } from '../norn/writer';
import { converge } from '../vault/converge';
import { nornSeedWrite, seedNodes } from '../vault/node-seed';
import { restoreArtifact } from './artifacts/norn';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { parseId, renderArtifactRef, renderId } from './ids';
import { getArtifact, getNode, listNodes, nextTasks, statusOfNode } from './intent/queries';
import type { Node } from './model';
import { archiveProject } from './mutations/archive';
import { reorder } from './mutations/data';
import { depend, undepend } from './mutations/dependency';
import { blockTask, parkTask } from './mutations/hold';
import { abandonTask, completeTask, startTask } from './mutations/lifecycle';
import { moveNode } from './mutations/structure';
import { tagEntities, untagEntities } from './mutations/tags';
import { listProjects, nodeTree } from './resource';
import type { Store, WorkingSet } from './store';
import { createSqliteStore } from './store-sqlite';

/** Test-local invariant — a lookup that must resolve (the strict ruleset bans `!`). */
function must<T>(v: T | undefined): T {
  if (v === undefined) {
    throw new Error('expected the lookup to resolve');
  }
  return v;
}

/**
 * Phase 2b parity harness (MMR-151, ADR 0016). Proves the DoD: every
 * frontmatter-derived read surface yields identical output-contract JSON across
 * the SQLite backend and a Norn backend reading a seeded vault. Skipped without
 * a real `norn` on PATH (CI); the seed + reader are exercised as one pipeline.
 */
const NORN = Bun.which('norn') !== null;

/**
 * Frontmatter facets — this harness's parity scope. The body-section facets
 * (annotations, history) now read through the {@link BodySectionStore} seam
 * (MMR-154), but their end-to-end parity is proven over a *migrated* store
 * (MMR-155 reconstructs the sections, MMR-156 diffs them) — the seed here is
 * frontmatter-only + empty sections, so it has no records to compare.
 */
const FACETS = [
  'deps',
  'artifacts',
  'tags',
  'children',
  'distribution',
  'leafCounts',
  'verdicts',
  'attention',
] as const;

let root: string;
let client: NornClient;
let db: Db;
let sqlite: Store;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-parity-'));
  await converge(join(root, 'vault'), { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: join(root, 'vault') });
  db = await createTestDb();
  sqlite = createSqliteStore(db);
});
afterEach(async () => {
  setSystemTime(); // release any frozen clock a write-verb test installed
  await client.close();
  await db.destroy();
  rmSync(root, { force: true, recursive: true });
});

/**
 * The Norn-backed Store: reads project state off `loadWorkingSetOverNorn`,
 * artifacts off the Norn slice, and — the MMR-153 write path — mutates through
 * the {@link createNornWriteStore} `transact` (the coalesce-to-one-plan writer),
 * no longer a throwing stub. `db` stays a trap: a frontmatter read must never
 * touch it, and the write path composes plan ops, never SQL.
 */
function createNornReadStore(c: NornClient): Store {
  return createNornWriteStore(c, join(root, 'vault'));
}

/** Seed the current SQLite state into the vault and return the Norn read store. */
async function seedAndNorn(): Promise<Store> {
  await seedNodes(await sqlite.loadWorkingSet(), nornSeedWrite(client));
  return createNornReadStore(client);
}

const keyOf = (ws: WorkingSet, n: Node): string => {
  const p = ws.projects.find((x) => x.id === n.project_id);
  if (p === undefined) {
    throw new Error('no project for node');
  }
  return p.key;
};
const stemOf = (ws: WorkingSet, n: Node): string => renderId({ key: keyOf(ws, n), seq: n.seq });

/**
 * A backend-independent WorkingSet view keyed by KEY-seq — the tripwire that
 * localizes a projection fault vs a downstream derivation fault.
 */
function normalizeWs(ws: WorkingSet): unknown {
  const nodeView = (n: Node) => ({
    completed_at: n.completed_at,
    created_at: n.created_at,
    description: n.description,
    external_ref: n.external_ref,
    hold: n.hold,
    hold_reason: n.hold_reason,
    lifecycle: n.lifecycle,
    parent:
      n.parent_id === null ? null : stemOf(ws, must(ws.nodes.find((x) => x.id === n.parent_id))),
    priority: n.priority,
    rank: n.rank,
    size: n.size,
    stem: stemOf(ws, n),
    tags: (ws.nodeTags.get(n.id) ?? []).map((t) => t.tag).toSorted(),
    target: n.target,
    title: n.title,
    type: n.type,
    updated_at: n.updated_at,
  });
  return {
    edges: ws.edges
      .map((e) => {
        const a = must(ws.nodes.find((x) => x.id === e.node_id));
        const b = must(ws.nodes.find((x) => x.id === e.depends_on_node_id));
        return `${stemOf(ws, a)}->${stemOf(ws, b)}`;
      })
      .toSorted(),
    nodes: ws.nodes.map(nodeView).toSorted((a, z) => a.stem.localeCompare(z.stem)),
    projects: ws.projects
      .map((p) => ({
        archived_at: p.archived_at,
        created_at: p.created_at,
        description: p.description,
        key: p.key,
        name: p.name,
        tags: (ws.projectTags.get(p.id) ?? []).map((t) => t.tag).toSorted(),
        updated_at: p.updated_at,
      }))
      .toSorted((a, z) => a.key.localeCompare(z.key)),
  };
}

/**
 * Reduce any `tags` array of TagView to sorted tag names. Tags are a set (ADR
 * 0005): the vault carries no per-tag note/timestamp, so the Norn reader
 * synthesizes them — a documented delta the parity contract compares on the
 * name set, exactly as the WorkingSet tripwire does. Everything else is diffed
 * byte-for-byte.
 */
function canon(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canon);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (
        k === 'tags' &&
        Array.isArray(v) &&
        v.every((t) => t !== null && typeof t === 'object' && 'tag' in t)
      ) {
        out[k] = v.map((t) => (t as { tag: string }).tag).toSorted();
      } else {
        out[k] = canon(v);
      }
    }
    return out;
  }
  return value;
}

/** Assert two backend read results are equal modulo the ADR-0005 tag delta. */
async function diff(a: Promise<unknown>, b: Promise<unknown>): Promise<void> {
  expect(canon(await a)).toEqual(canon(await b));
}

/** Diff every frontmatter read surface across the two backends for the seeded graph. */
async function assertParity(norn: Store): Promise<void> {
  const ws = await sqlite.loadWorkingSet();

  // tripwire: the projection itself
  expect(normalizeWs(await norn.loadWorkingSet())).toEqual(normalizeWs(ws));

  const F = [...FACETS];
  const archived = new Set(ws.projects.filter((p) => p.archived_at !== null).map((p) => p.id));
  for (const n of ws.nodes) {
    if (archived.has(n.project_id)) {
      continue;
    } // an archived subtree reads as absent (ADR 0015)
    const stem = stemOf(ws, n);
    await diff(getNode(norn, stem, { facets: F }), getNode(sqlite, stem, { facets: F }));
    await diff(statusOfNode(norn, stem), statusOfNode(sqlite, stem));
    // mid-tree: the resource.ts node-id branch (findNodeInSet + subtree), not just projectTree
    await diff(nodeTree(norn, stem, F), nodeTree(sqlite, stem, F));
  }
  for (const p of ws.projects) {
    if (p.archived_at !== null) {
      continue;
    } // archived projects 404 on get/tree (ADR 0015)
    await diff(getNode(norn, p.key, { facets: F }), getNode(sqlite, p.key, { facets: F }));
    await diff(statusOfNode(norn, p.key), statusOfNode(sqlite, p.key));
    await diff(nodeTree(norn, p.key, F), nodeTree(sqlite, p.key, F));
    // scoped `next` — resolveScope over the Norn working set
    await diff(
      nextTasks(norn, { facets: F, scope: p.key }),
      nextTasks(sqlite, { facets: F, scope: p.key }),
    );
  }

  // collection surfaces, across the status universes (exercises byCompletedOrder for terminals)
  await diff(nextTasks(norn, { facets: F }), nextTasks(sqlite, { facets: F }));
  for (const status of ['live', 'all', 'terminal', 'done', 'abandoned'] as const) {
    await diff(listNodes(norn, { facets: F, status }), listNodes(sqlite, { facets: F, status }));
  }
  for (const filter of ['active', 'archived', 'all'] as const) {
    await diff(listProjects(norn, F, filter), listProjects(sqlite, F, filter));
  }
}

test.skipIf(!NORN)('parity: a rich project — tree, deps, tags, holds, ranks', async () => {
  const p = await createProject(sqlite, { description: 'work', key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(sqlite, { projectId: p.id, title: 'Init' });
  const phase = await createPhase(sqlite, { parentId: init.id, target: 'v2', title: 'Phase' });
  const a = await createTask(sqlite, {
    externalRef: 'JIRA-9',
    parentId: phase.id,
    priority: 'p1',
    tags: ['x', 'y'],
    title: 'A',
  });
  const b = await createTask(sqlite, { parentId: phase.id, size: 'large', title: 'B' });
  const c = await createTask(sqlite, { parentId: phase.id, priority: 'p2', title: 'C' });
  const d = await createTask(sqlite, { parentId: phase.id, title: 'D done' });
  const e = await createTask(sqlite, { parentId: phase.id, title: 'E gone' });
  await depend(sqlite, b.id, [a.id]);
  await parkTask(sqlite, c.id, 'later');
  await completeTask(sqlite, d.id); // terminal + completed_at (byCompletedOrder)
  await abandonTask(sqlite, e.id, 'dropped');
  await reorder(sqlite, b.id, 'top', null);
  await tagEntities(sqlite, [{ entityId: p.id, entityType: 'project' }], ['release:v1']);

  await assertParity(await seedAndNorn());
});

test.skipIf(!NORN)('parity: cross-project dependency + an archived project', async () => {
  const foo = await createProject(sqlite, { key: 'FOO', name: 'Foo' });
  const bar = await createProject(sqlite, { key: 'BAR', name: 'Bar' });
  const fi = await createInitiative(sqlite, { projectId: foo.id, title: 'FI' });
  const fp = await createPhase(sqlite, { parentId: fi.id, title: 'FP' });
  const bi = await createInitiative(sqlite, { projectId: bar.id, title: 'BI' });
  const bp = await createPhase(sqlite, { parentId: bi.id, title: 'BP' });
  const consumer = await createTask(sqlite, { parentId: fp.id, title: 'consumer' });
  const prereq = await createTask(sqlite, { parentId: bp.id, title: 'prereq' });
  await depend(sqlite, consumer.id, [prereq.id]);
  await blockTask(sqlite, prereq.id, 'external');
  await archiveProject(sqlite, bar.id, 'done');

  await assertParity(await seedAndNorn());
});

test.skipIf(!NORN)('parity: stale/going-cold, an empty container, multi-tag', async () => {
  const p = await createProject(sqlite, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(sqlite, { projectId: p.id, title: 'Init' });
  await createPhase(sqlite, { parentId: init.id, title: 'Empty phase' }); // no children
  const phase = await createPhase(sqlite, { parentId: init.id, title: 'Live phase' });
  const t = await createTask(sqlite, { parentId: phase.id, tags: ['a', 'b', 'c'], title: 'Cold' });
  // backdate updated_at well past the stale threshold so `stale`/going-cold fire
  await db
    .updateTable('node')
    .set({ updated_at: '2000-01-01T00:00:00.000Z' })
    .where('id', '=', t.id)
    .execute();

  await assertParity(await seedAndNorn());
});

test.skipIf(!NORN)('parity: scoped and filtered selections', async () => {
  const p = await createProject(sqlite, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(sqlite, { projectId: p.id, title: 'Init' });
  const phase = await createPhase(sqlite, { parentId: init.id, title: 'Phase' });
  await createTask(sqlite, {
    parentId: phase.id,
    priority: 'p0',
    size: 'small',
    tags: ['alpha'],
    title: 'Refactor the store',
  });
  await createTask(sqlite, {
    parentId: phase.id,
    priority: 'p1',
    size: 'large',
    tags: ['alpha', 'beta'],
    title: 'Write the harness',
  });
  await createTask(sqlite, {
    parentId: phase.id,
    priority: 'p2',
    tags: ['beta'],
    title: 'Ship it',
  });
  const bar = await createProject(sqlite, { key: 'BAR', name: 'Bar' });
  const bi = await createInitiative(sqlite, { projectId: bar.id, title: 'BI' });
  await createTask(sqlite, { parentId: bi.id, priority: 'p1', tags: ['alpha'], title: 'Bar task' });

  const norn = await seedAndNorn();
  const F = [...FACETS];
  // tag / priority / size predicates over the Norn working set
  await diff(
    listNodes(norn, { facets: F, tag: 'alpha' }),
    listNodes(sqlite, { facets: F, tag: 'alpha' }),
  );
  await diff(
    listNodes(norn, { facets: F, tag: 'beta' }),
    listNodes(sqlite, { facets: F, tag: 'beta' }),
  );
  await diff(
    listNodes(norn, { facets: F, priority: 'p1' }),
    listNodes(sqlite, { facets: F, priority: 'p1' }),
  );
  await diff(
    listNodes(norn, { facets: F, size: 'large' }),
    listNodes(sqlite, { facets: F, size: 'large' }),
  );
  // q substring matcher
  await diff(
    listNodes(norn, { facets: F, q: 'harness' }),
    listNodes(sqlite, { facets: F, q: 'harness' }),
  );
  await diff(listNodes(norn, { facets: F, q: 'the' }), listNodes(sqlite, { facets: F, q: 'the' }));
  // scope resolution
  await diff(
    listNodes(norn, { facets: F, scope: 'MMR' }),
    listNodes(sqlite, { facets: F, scope: 'MMR' }),
  );
  await diff(
    nextTasks(norn, { facets: F, scope: 'BAR' }),
    nextTasks(sqlite, { facets: F, scope: 'BAR' }),
  );
});

/**
 * Regression guard for the divergence this harness surfaced: unscoped/multi-project
 * `next` used to order by `byProjectRank`'s leading `project_id` — a surrogate SQLite
 * assigns in creation order and the Norn reader assigns in KEY order, so a project
 * whose creation order differed from its KEY order returned ready tasks in a different
 * project order across backends. `byProjectRank` (and the `byRankOrder`/`byCompletedOrder`
 * siblings, whose `seq` tiebreak was per-project) now key on the portable project KEY /
 * KEY-seq stem, so the two backends agree. Built in non-alphabetical creation order to
 * exercise the exact case that used to diverge.
 */
test.skipIf(!NORN)(
  'unscoped next orders by portable project KEY — identical across backends',
  async () => {
    // create in non-alphabetical order so creation-order != KEY-order
    const zed = await createProject(sqlite, { key: 'ZED', name: 'Zed' });
    const aaa = await createProject(sqlite, { key: 'AAA', name: 'Aaa' });
    const zi = await createInitiative(sqlite, { projectId: zed.id, title: 'ZI' });
    const ai = await createInitiative(sqlite, { projectId: aaa.id, title: 'AI' });
    await createTask(sqlite, { parentId: zi.id, title: 'Z task' });
    await createTask(sqlite, { parentId: ai.id, title: 'A task' });

    const norn = await seedAndNorn();
    const F = [...FACETS];
    await diff(nextTasks(norn, { facets: F }), nextTasks(sqlite, { facets: F }));
  },
);

test.skipIf(!NORN)('parity: a real artifact across backends (facet + getArtifact)', async () => {
  const p = await createProject(sqlite, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(sqlite, { projectId: p.id, title: 'Init' });
  const t = await createTask(sqlite, { parentId: init.id, title: 'Task' });
  const tStem = renderId({ key: 'MMR', seq: t.seq });
  const { key, seq } = await sqlite.artifacts.create({
    content: '# Spec\n\nthe body',
    key: 'MMR',
    links: [tStem],
    tags: ['spec', 'design'],
    title: 'Design spec',
  });

  // seed the nodes, then restore the SAME artifact record into the vault (identity + created preserved)
  await seedNodes(await sqlite.loadWorkingSet(), nornSeedWrite(client));
  const rec = await sqlite.artifacts.load(key, seq, { content: true });
  if (rec === undefined) {
    throw new Error('artifact vanished from SQLite');
  }
  await restoreArtifact(client, rec, rec.content ?? '');
  const norn = createNornReadStore(client);

  // the artifacts facet is now non-empty on getNode/nodeTree/listProjects
  await assertParity(norn);
  // and the dedicated getArtifact(KEY-aN) surface, with the frozen body
  const aid = renderArtifactRef({ key, seq });
  await diff(
    getArtifact(norn, aid, { content: true }),
    getArtifact(sqlite, aid, { content: true }),
  );
  await diff(getArtifact(norn, aid), getArtifact(sqlite, aid));
});

test.skipIf(!NORN)('parity: a large synthetic graph (scale/shape)', async () => {
  const keys = ['PAA', 'PAB', 'PAC', 'PAD'];
  for (let pi = 0; pi < keys.length; pi += 1) {
    const key = must(keys[pi]);
    const proj = await createProject(sqlite, { key, name: `Project ${String(pi)}` });
    const init = await createInitiative(sqlite, { projectId: proj.id, title: `I${String(pi)}` });
    const prev: number[] = [];
    for (let ni = 0; ni < 6; ni += 1) {
      const phase = await createPhase(sqlite, { parentId: init.id, title: `Ph${String(ni)}` });
      const t1 = await createTask(sqlite, {
        parentId: phase.id,
        priority: 'p2',
        title: `T${String(ni)}a`,
      });
      const t2 = await createTask(sqlite, {
        parentId: phase.id,
        tags: [`t${String(ni)}`],
        title: `T${String(ni)}b`,
      });
      if (prev.length > 0) {
        await depend(sqlite, t1.id, [must(prev[prev.length - 1])]);
      }
      prev.push(t2.id);
    }
  }
  await assertParity(await seedAndNorn());
});

// ─────────────────────────────────────────────────────────────────────────────
// Write-verb parity (MMR-153): run a verb on BOTH the SQLite store and the Norn
// write store from one seeded state, then assert the read surfaces agree. The
// clock is frozen across both runs so a stamped `updated_at`/`completed_at`
// matches; `created_at` rides the seed (copied from SQLite) for a mutation, and
// is aligned explicitly for a create (SQLite's default clock ≠ the writer's).
// ─────────────────────────────────────────────────────────────────────────────

const FIXED = '2026-07-03T12:00:00.000Z';

/** Resolve a KEY-seq node stem to a store's current synthetic id — re-resolved
 * per op, since the Norn reader mints ids per load (never durable across applies). */
async function nodeIdIn(store: Store, stem: string): Promise<number> {
  const ref = parseId(stem);
  if (ref === null) {
    throw new Error(`not a node stem: ${stem}`);
  }
  const ws = await store.loadWorkingSet();
  const project = ws.projects.find((p) => p.key === ref.key);
  const node = ws.nodes.find((n) => n.project_id === project?.id && n.seq === ref.seq);
  if (node === undefined) {
    throw new Error(`no node for ${stem}`);
  }
  return node.id;
}

async function projectIdIn(store: Store, key: string): Promise<number> {
  const ws = await store.loadWorkingSet();
  const project = ws.projects.find((p) => p.key === key);
  if (project === undefined) {
    throw new Error(`no project ${key}`);
  }
  return project.id;
}

type Resolve = (stem: string) => Promise<number>;

/** Seed the SQLite base into the vault, freeze the clock, run `mutate` on each
 * backend (ids resolved by stem per store), and assert full read parity. */
async function verbParity(mutate: (store: Store, id: Resolve) => Promise<unknown>): Promise<void> {
  await seedNodes(await sqlite.loadWorkingSet(), nornSeedWrite(client));
  const norn = createNornReadStore(client);
  setSystemTime(new Date(FIXED));
  await mutate(sqlite, (stem) => nodeIdIn(sqlite, stem));
  await mutate(norn, (stem) => nodeIdIn(norn, stem));
  await assertParity(norn);
}

/** As {@link verbParity}, for a create: the new node's identity (seq) must match
 * across backends; its timestamps are aligned to the writer's frozen clock. */
async function createParity(
  parent: (store: Store) => Promise<number>,
  create: (store: Store, parentId: number) => Promise<Node>,
): Promise<void> {
  await seedNodes(await sqlite.loadWorkingSet(), nornSeedWrite(client));
  const norn = createNornReadStore(client);
  setSystemTime(new Date(FIXED));
  const sNode = await create(sqlite, await parent(sqlite));
  await create(norn, await parent(norn));
  await db
    .updateTable('node')
    .set({ created_at: FIXED, updated_at: FIXED })
    .where('id', '=', sNode.id)
    .execute();
  await assertParity(norn);
}

/** MMR → initiative → phase, with `count` todo tasks under the phase. */
async function scaffold(count: number): Promise<void> {
  const p = await createProject(sqlite, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(sqlite, { projectId: p.id, title: 'Init' });
  const phase = await createPhase(sqlite, { parentId: init.id, title: 'Phase' });
  for (let i = 0; i < count; i += 1) {
    await createTask(sqlite, { parentId: phase.id, title: `Task ${String(i)}` });
  }
}

test.skipIf(!NORN)('write parity: start a task', async () => {
  await scaffold(1);
  await verbParity(async (store, id) => startTask(store, await id('MMR-3')));
});

test.skipIf(!NORN)('write parity: park a task with a reason', async () => {
  await scaffold(2);
  await verbParity(async (store, id) => parkTask(store, await id('MMR-3'), 'waiting on review'));
});

test.skipIf(!NORN)('write parity: block a task with a reason', async () => {
  await scaffold(1);
  await verbParity(async (store, id) => blockTask(store, await id('MMR-3'), 'external dep'));
});

test.skipIf(!NORN)('write parity: complete a task', async () => {
  await scaffold(1);
  await verbParity(async (store, id) => completeTask(store, await id('MMR-3')));
});

test.skipIf(!NORN)('write parity: abandon a task with a reason', async () => {
  await scaffold(1);
  await verbParity(async (store, id) => abandonTask(store, await id('MMR-3'), 'dropped'));
});

test.skipIf(!NORN)('write parity: add a dependency edge', async () => {
  await scaffold(2);
  await verbParity(async (store, id) => depend(store, await id('MMR-4'), [await id('MMR-3')]));
});

test.skipIf(!NORN)('write parity: remove a dependency edge', async () => {
  await scaffold(2);
  await depend(sqlite, await nodeIdIn(sqlite, 'MMR-4'), [await nodeIdIn(sqlite, 'MMR-3')]);
  await verbParity(async (store, id) => undepend(store, await id('MMR-4'), [await id('MMR-3')]));
});

test.skipIf(!NORN)('write parity: tag then untag a task', async () => {
  await scaffold(1);
  await verbParity(async (store, id) =>
    tagEntities(store, [{ entityId: await id('MMR-3'), entityType: 'node' }], ['alpha', 'beta']),
  );
});

test.skipIf(!NORN)('write parity: untag removes a seeded tag', async () => {
  const p = await createProject(sqlite, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(sqlite, { projectId: p.id, title: 'Init' });
  const phase = await createPhase(sqlite, { parentId: init.id, title: 'Phase' });
  await createTask(sqlite, { parentId: phase.id, tags: ['keep', 'drop'], title: 'Tagged' });
  await verbParity(async (store, id) =>
    untagEntities(store, [{ entityId: await id('MMR-3'), entityType: 'node' }], ['drop']),
  );
});

test.skipIf(!NORN)('write parity: reorder a task to the top of the rankable set', async () => {
  await scaffold(3);
  await verbParity(async (store, id) => reorder(store, await id('MMR-5'), 'top', null));
});

test.skipIf(!NORN)('write parity: re-parent a task to another phase', async () => {
  const p = await createProject(sqlite, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(sqlite, { projectId: p.id, title: 'Init' });
  const phaseA = await createPhase(sqlite, { parentId: init.id, title: 'Phase A' });
  await createPhase(sqlite, { parentId: init.id, title: 'Phase B' }); // MMR-3
  await createTask(sqlite, { parentId: phaseA.id, title: 'Movable' }); // MMR-4
  await verbParity(async (store, id) => moveNode(store, await id('MMR-4'), await id('MMR-3')));
});

test.skipIf(!NORN)('write parity: create a task under a phase', async () => {
  await scaffold(0);
  await createParity(
    (store) => nodeIdIn(store, 'MMR-2'),
    (store, parentId) =>
      createTask(store, { parentId, priority: 'p1', tags: ['x'], title: 'Created task' }),
  );
});

test.skipIf(!NORN)('write parity: create a phase under an initiative', async () => {
  const p = await createProject(sqlite, { key: 'MMR', name: 'Mimir' });
  await createInitiative(sqlite, { projectId: p.id, title: 'Init' }); // MMR-1
  await createParity(
    (store) => nodeIdIn(store, 'MMR-1'),
    (store, parentId) => createPhase(store, { parentId, target: 'v2', title: 'Created phase' }),
  );
});

test.skipIf(!NORN)('write parity: create an initiative under a project', async () => {
  await createProject(sqlite, { key: 'MMR', name: 'Mimir' });
  await createParity(
    (store) => projectIdIn(store, 'MMR'),
    (store, projectId) => createInitiative(store, { projectId, title: 'Created initiative' }),
  );
});

/** The prose under `## Task Description` (heading excluded), trimmed. */
function descriptionSection(doc: string): string {
  const lines = doc.split('\n');
  const start = lines.indexOf('## Task Description');
  if (start === -1) {
    throw new Error('no ## Task Description section in the document');
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

// F3 (MMR-153 review): a description edit emits `set_frontmatter description`
// AND a `replace_section` for `## Task Description`, so the body prose can't
// drift from the frontmatter value after the edit.
test.skipIf(!NORN)(
  'write path: a description edit rewrites the ## Task Description body',
  async () => {
    const norn = createNornReadStore(client);
    await createProject(norn, { key: 'MMR', name: 'Mimir' });
    await createInitiative(norn, { projectId: await projectIdIn(norn, 'MMR'), title: 'Init' });
    await createPhase(norn, { parentId: await nodeIdIn(norn, 'MMR-1'), title: 'Phase' });
    await createTask(norn, {
      description: 'old body',
      parentId: await nodeIdIn(norn, 'MMR-2'),
      title: 'T',
    });

    const path = join(root, 'vault', 'MMR', 'MMR-3.md');
    // the freshly created body carries the seeded description
    expect(descriptionSection(readFileSync(path, 'utf8'))).toBe('old body');

    const taskId = await nodeIdIn(norn, 'MMR-3');
    await norn.transact((w) => w.updateNode(taskId, { description: 'new body' }));

    // the on-disk section now matches the new description (was stale before the fix)
    expect(descriptionSection(readFileSync(path, 'utf8'))).toBe('new body');
  },
);

test.skipIf(!NORN)('write parity: create a project (a new vault directory)', async () => {
  // No seed: the vault starts empty, so this exercises the new-directory create
  // path (`apply_plan` runs create_document with parents:false — the writer
  // ensures the KEY/ folder). Both backends create MMR; timestamps are aligned.
  const norn = createNornReadStore(client);
  setSystemTime(new Date(FIXED));
  const sProject = await createProject(sqlite, { description: 'work', key: 'MMR', name: 'Mimir' });
  await createProject(norn, { description: 'work', key: 'MMR', name: 'Mimir' });
  await db
    .updateTable('project')
    .set({ created_at: FIXED, updated_at: FIXED })
    .where('id', '=', sProject.id)
    .execute();
  await assertParity(norn);
});
