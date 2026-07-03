import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTestDb } from '../db/testing';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { converge } from '../vault/converge';
import { nornSeedWrite, seedNodes } from '../vault/node-seed';
import { createNornArtifactStore } from './artifacts';
import { restoreArtifact } from './artifacts/norn';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { renderArtifactRef, renderId } from './ids';
import { getArtifact, getNode, listNodes, nextTasks, statusOfNode } from './intent/queries';
import type { Node } from './model';
import { archiveProject } from './mutations/archive';
import { reorder } from './mutations/data';
import { depend } from './mutations/dependency';
import { blockTask, parkTask } from './mutations/hold';
import { abandonTask, completeTask } from './mutations/lifecycle';
import { tagEntities } from './mutations/tags';
import { listProjects, nodeTree } from './resource';
import type { Store, WorkingSet } from './store';
import { loadWorkingSetOverNorn } from './store-norn';
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

/** Frontmatter facets — the parity scope; annotations/history read `db` (Phase 3). */
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
  await client.close();
  await db.destroy();
  rmSync(root, { force: true, recursive: true });
});

/**
 * A read-only Store backed by the Norn vault: reads project off
 * `loadWorkingSetOverNorn`, artifacts off the Norn slice. `db` is a trap — a
 * frontmatter read must never touch it (only annotations/history/transitions
 * do, and those are Phase 3, out of parity scope); `transact` is unsupported.
 */
function createNornReadStore(c: NornClient): Store {
  const dbTrap = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `Norn read store: store.db.${String(prop)} touched — a frontmatter read must not read db`,
        );
      },
    },
  ) as Db;
  return {
    artifacts: createNornArtifactStore(c),
    db: dbTrap,
    loadWorkingSet: () => loadWorkingSetOverNorn(c),
    transact: () => {
      throw new Error('Norn read store is read-only');
    },
  };
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
  const same = async (a: Promise<unknown>, b: Promise<unknown>): Promise<void> => {
    expect(canon(await a)).toEqual(canon(await b));
  };

  // tripwire: the projection itself
  expect(normalizeWs(await norn.loadWorkingSet())).toEqual(normalizeWs(ws));

  const F = [...FACETS];
  const archived = new Set(ws.projects.filter((p) => p.archived_at !== null).map((p) => p.id));
  for (const n of ws.nodes) {
    if (archived.has(n.project_id)) {
      continue;
    } // an archived subtree reads as absent (ADR 0015)
    const stem = stemOf(ws, n);
    await same(getNode(norn, stem, { facets: F }), getNode(sqlite, stem, { facets: F }));
    await same(statusOfNode(norn, stem), statusOfNode(sqlite, stem));
    // mid-tree: the resource.ts node-id branch (findNodeInSet + subtree), not just projectTree
    await same(nodeTree(norn, stem, F), nodeTree(sqlite, stem, F));
  }
  for (const p of ws.projects) {
    if (p.archived_at !== null) {
      continue;
    } // archived projects 404 on get/tree (ADR 0015)
    await same(getNode(norn, p.key, { facets: F }), getNode(sqlite, p.key, { facets: F }));
    await same(statusOfNode(norn, p.key), statusOfNode(sqlite, p.key));
    await same(nodeTree(norn, p.key, F), nodeTree(sqlite, p.key, F));
    // scoped `next` — resolveScope over the Norn working set
    await same(
      nextTasks(norn, { facets: F, scope: p.key }),
      nextTasks(sqlite, { facets: F, scope: p.key }),
    );
  }

  // collection surfaces, across the status universes (exercises byCompletedOrder for terminals)
  await same(nextTasks(norn, { facets: F }), nextTasks(sqlite, { facets: F }));
  for (const status of ['live', 'all', 'terminal', 'done', 'abandoned'] as const) {
    await same(listNodes(norn, { facets: F, status }), listNodes(sqlite, { facets: F, status }));
  }
  for (const filter of ['active', 'archived', 'all'] as const) {
    await same(listProjects(norn, F, filter), listProjects(sqlite, F, filter));
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
 * KNOWN DIVERGENCE (reported to the controller — fix in core derivation, not
 * 149/150): unscoped/multi-project `next` orders by `byProjectRank`, which leads
 * with the surrogate `project_id`. SQLite assigns it in creation order; the Norn
 * reader assigns it in KEY order — so when a project's creation order differs
 * from its KEY order, `next` returns ready tasks in a different project order
 * across backends. The stable key is the project KEY (the stem), not the
 * surrogate int. `test.failing` documents this until `byProjectRank` is fixed to
 * order by KEY; it flips RED (alerting) the moment it is. (list/`byRankOrder`
 * has a narrower sibling: its `seq` tiebreak is per-project, not globally
 * unique.) Not normalized away — a real output divergence, surfaced.
 */
test.failing.skipIf(!NORN)(
  'DIVERGENCE: unscoped next orders by surrogate project_id, not project KEY',
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
