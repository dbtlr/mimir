import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTestDb } from '../db/testing';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { converge } from '../vault/converge';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { renderId } from './ids';
import type { Node, Project } from './model';
import { depend } from './mutations/dependency';
import { tagEntities } from './mutations/tags';
import type { Store, WorkingSet } from './store';
import { loadWorkingSetOverNorn, readVaultGraph } from './store-norn';
import { createSqliteStore } from './store-sqlite';

/**
 * The Norn node read path over a real `norn` subprocess (MMR-149). Skipped when
 * the binary isn't on PATH (CI); the derivation suite already covers the
 * WorkingSet consumers, so this proves the vault→WorkingSet projection itself.
 */
const NORN = Bun.which('norn') !== null;

let root: string;
let client: NornClient;
let db: Db;
let store: Store;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-norn-read-'));
  await converge(join(root, 'vault'), { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: join(root, 'vault') });
  db = await createTestDb();
  store = createSqliteStore(db);
});
afterEach(async () => {
  await client.close();
  await db.destroy();
  rmSync(root, { force: true, recursive: true });
});

/** Test-local invariant: a lookup that must resolve (avoids non-null assertions). */
function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected the lookup to resolve');
  }
  return value;
}

const jsonField = (key: string, value: unknown): string => `${key}=${JSON.stringify(value)}`;
const wikilink = (stem: string): string => `[[${stem}]]`;
const aliasedWikilink = (stem: string, alias: string): string => `[[${stem}|${alias}]]`;

async function writeDoc(path: string, fields: string[]): Promise<void> {
  await client.newDoc({ confirm: true, field_json: fields, parents: true, path });
}

/**
 * Project a SQLite WorkingSet into vault documents — a test-local seed (the
 * shipped one is MMR-150) that guarantees the two backends describe the *same*
 * logical graph, timestamps included, so the parity assertion is real.
 */
async function seedVaultFromWorkingSet(ws: WorkingSet): Promise<void> {
  const projectById = new Map(ws.projects.map((p) => [p.id, p]));
  const nodeById = new Map(ws.nodes.map((n) => [n.id, n]));
  const keyOf = (n: Node): string => must(projectById.get(n.project_id)).key;
  const stemOf = (n: Node): string => renderId({ key: keyOf(n), seq: n.seq });

  const prereqStems = new Map<number, string[]>();
  for (const e of ws.edges) {
    const list = prereqStems.get(e.node_id) ?? [];
    list.push(stemOf(must(nodeById.get(e.depends_on_node_id))));
    prereqStems.set(e.node_id, list);
  }

  for (const p of ws.projects) {
    const fields = [
      jsonField('type', 'project'),
      jsonField('key', p.key),
      jsonField('name', p.name),
      jsonField('created', p.created_at),
      jsonField('updated_at', p.updated_at),
    ];
    if (p.description !== null) {
      fields.push(jsonField('description', p.description));
    }
    if (p.archived_at !== null) {
      fields.push(jsonField('archived_at', p.archived_at));
    }
    const tags = (ws.projectTags.get(p.id) ?? []).map((t) => t.tag);
    if (tags.length > 0) {
      fields.push(jsonField('tags', tags));
    }
    await writeDoc(`${p.key}/${p.key}.md`, fields);
  }

  for (const n of ws.nodes) {
    const parentStem = n.parent_id === null ? keyOf(n) : stemOf(must(nodeById.get(n.parent_id)));
    const fields = [
      jsonField('type', n.type),
      jsonField('title', n.title),
      jsonField('parent', wikilink(parentStem)),
      jsonField('created', n.created_at),
      jsonField('updated_at', n.updated_at),
    ];
    const scalars: [string, string | number | null][] = [
      ['description', n.description],
      ['lifecycle', n.lifecycle],
      ['hold_reason', n.hold_reason],
      ['priority', n.priority],
      ['size', n.size],
      ['rank', n.rank],
      ['external_ref', n.external_ref],
      ['completed_at', n.completed_at],
      ['target', n.target],
    ];
    for (const [key, value] of scalars) {
      if (value !== null) {
        fields.push(jsonField(key, value));
      }
    }
    // hold: the idiomatic vault representation omits the 'none' default (a task's
    // no-hold state), matching the shipped MMR-150 seed; only a real hold is
    // written. The reader must reconstruct 'none' for a task with no hold field.
    if (n.hold !== null && n.hold !== 'none') {
      fields.push(jsonField('hold', n.hold));
    }
    const prereqs = prereqStems.get(n.id) ?? [];
    if (prereqs.length > 0) {
      fields.push(jsonField('depends_on', prereqs.map(wikilink)));
    }
    const tags = (ws.nodeTags.get(n.id) ?? []).map((t) => t.tag);
    if (tags.length > 0) {
      fields.push(jsonField('tags', tags));
    }
    await writeDoc(`${keyOf(n)}/${stemOf(n)}.md`, fields);
  }
}

const projectView = (p: Project) => ({
  archived_at: p.archived_at,
  created_at: p.created_at,
  description: p.description,
  name: p.name,
  updated_at: p.updated_at,
});

// Tags are a set (ADR 0005): Norn sorts by name, SQLite orders by (created_at,
// tag) — so compare the sorted name sets, not the raw lists, or a multi-tag
// entity false-fails on order alone.
const tagNames = (records: readonly { tag: string }[]): string[] =>
  records.map((t) => t.tag).toSorted();

/**
 * A backend-independent view of a WorkingSet keyed by `KEY-seq` identity — drops
 * the synthetic ints and the two documented deltas (SQLite-only allocation
 * counters; per-tag note/timestamp), so equality is the real parity oracle.
 */
function normalize(ws: WorkingSet): unknown {
  const projectById = new Map(ws.projects.map((p) => [p.id, p]));
  const nodeById = new Map(ws.nodes.map((n) => [n.id, n]));
  const stemOf = (n: Node): string =>
    renderId({ key: must(projectById.get(n.project_id)).key, seq: n.seq });
  const nodeView = (n: Node) => ({
    completed_at: n.completed_at,
    created_at: n.created_at,
    description: n.description,
    external_ref: n.external_ref,
    hold: n.hold,
    hold_reason: n.hold_reason,
    lifecycle: n.lifecycle,
    parent: n.parent_id === null ? null : stemOf(must(nodeById.get(n.parent_id))),
    priority: n.priority,
    rank: n.rank,
    size: n.size,
    target: n.target,
    title: n.title,
    type: n.type,
    updated_at: n.updated_at,
  });
  return {
    edges: ws.edges
      .map(
        (e) =>
          `${stemOf(must(nodeById.get(e.node_id)))}->${stemOf(must(nodeById.get(e.depends_on_node_id)))}`,
      )
      .toSorted(),
    nodeTags: Object.fromEntries(
      ws.nodes
        .map((n) => [stemOf(n), tagNames(ws.nodeTags.get(n.id) ?? [])] as const)
        .filter(([, tags]) => tags.length > 0),
    ),
    nodes: Object.fromEntries(ws.nodes.map((n) => [stemOf(n), nodeView(n)] as const)),
    projectTags: Object.fromEntries(
      ws.projects
        .map((p) => [p.key, tagNames(ws.projectTags.get(p.id) ?? [])] as const)
        .filter(([, tags]) => tags.length > 0),
    ),
    projects: Object.fromEntries(ws.projects.map((p) => [p.key, projectView(p)] as const)),
  };
}

test.skipIf(!NORN)(
  'loadWorkingSetOverNorn projects nodes, edges, and tags from a vault',
  async () => {
    await writeDoc('MMR/MMR.md', [
      jsonField('type', 'project'),
      jsonField('key', 'MMR'),
      jsonField('name', 'Mimir'),
      jsonField('created', '2026-06-01T00:00:00.000Z'),
      jsonField('updated_at', '2026-06-02T00:00:00.000Z'),
      jsonField('tags', ['release:v1']),
    ]);
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'phase'),
      jsonField('title', 'Phase A'),
      jsonField('parent', wikilink('MMR')),
      jsonField('created', '2026-06-01T00:00:00.000Z'),
      jsonField('updated_at', '2026-06-02T00:00:00.000Z'),
    ]);
    await writeDoc('MMR/MMR-2.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Prereq'),
      jsonField('parent', wikilink('MMR-1')),
      jsonField('lifecycle', 'todo'),
      jsonField('created', '2026-06-01T00:00:00.000Z'),
      jsonField('updated_at', '2026-06-02T00:00:00.000Z'),
    ]);
    await writeDoc('MMR/MMR-3.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Dependent'),
      jsonField('parent', wikilink('MMR-1')),
      jsonField('lifecycle', 'todo'),
      jsonField('priority', 'p1'),
      jsonField('rank', 1),
      jsonField('depends_on', [wikilink('MMR-2')]),
      jsonField('tags', ['zebra', 'alpha']),
      jsonField('created', '2026-06-01T00:00:00.000Z'),
      jsonField('updated_at', '2026-06-02T00:00:00.000Z'),
    ]);

    const ws = await loadWorkingSetOverNorn(client);

    expect(ws.projects).toHaveLength(1);
    expect(ws.projects[0]).toMatchObject({ key: 'MMR', last_seq: 3, name: 'Mimir' });
    expect(ws.nodes).toHaveLength(3);

    const byStem = new Map(ws.nodes.map((n) => [renderId({ key: 'MMR', seq: n.seq }), n] as const));
    const phase = must(byStem.get('MMR-1'));
    const prereq = must(byStem.get('MMR-2'));
    const dependent = must(byStem.get('MMR-3'));

    // parent: project root → null; node parent → that node's synthetic int.
    expect(phase.parent_id).toBeNull();
    expect(prereq.parent_id).toBe(phase.id);
    expect(dependent.priority).toBe('p1');
    expect(dependent.rank).toBe(1);

    // the depends_on edge resolves both endpoints to synthetic ints.
    expect(ws.edges).toEqual([{ depends_on_node_id: prereq.id, node_id: dependent.id }]);

    // tags: sorted, note-less, project + node.
    expect(ws.nodeTags.get(dependent.id)).toEqual([
      { created_at: '2026-06-01T00:00:00.000Z', note: null, tag: 'alpha' },
      { created_at: '2026-06-01T00:00:00.000Z', note: null, tag: 'zebra' },
    ]);
    expect(ws.projectTags.get(must(ws.projects[0]).id)).toEqual([
      { created_at: '2026-06-01T00:00:00.000Z', note: null, tag: 'release:v1' },
    ]);
  },
);

test.skipIf(!NORN)('parity: SQLite and Norn WorkingSets agree on the same graph', async () => {
  // Build the graph through the SQLite verbs, then project it into the vault.
  const project = await createProject(store, {
    description: 'the work tool',
    key: 'MMR',
    name: 'Mimir',
  });
  const initiative = await createInitiative(store, {
    projectId: project.id,
    title: 'Backend swap',
  });
  const phase = await createPhase(store, { parentId: initiative.id, title: 'Read path' });
  const a = await createTask(store, { parentId: phase.id, priority: 'p1', title: 'Seam' });
  const b = await createTask(store, { parentId: phase.id, size: 'medium', title: 'Backend' });
  await depend(store, b.id, [a.id]);
  // Two tags on b, then backdate one so SQLite's (created_at, tag) order — [zebra,
  // alpha] — differs from Norn's alphabetical [alpha, zebra]. This exercises the
  // tag-SET oracle: it false-fails against an ordered compare, passes as a set.
  await tagEntities(store, [{ entityId: b.id, entityType: 'node' }], ['alpha', 'zebra']);
  await db
    .updateTable('tag')
    .set({ created_at: '2020-01-01T00:00:00.000Z' })
    .where('entity_type', '=', 'node')
    .where('entity_id', '=', b.id)
    .where('tag', '=', 'zebra')
    .execute();
  await tagEntities(store, [{ entityId: project.id, entityType: 'project' }], ['release:v1']);

  const sqliteWs = await store.loadWorkingSet();
  await seedVaultFromWorkingSet(sqliteWs);
  const nornWs = await loadWorkingSetOverNorn(client);

  expect(normalize(nornWs)).toEqual(normalize(sqliteWs));
});

// ── Referential-integrity guards: a malformed vault fails loud, never silently
// projects a corrupt WorkingSet (the reader enforces SQLite's CHECK/FK). ──

const TS = '2026-06-01T00:00:00.000Z';

async function writeProjectDoc(key: string): Promise<void> {
  await writeDoc(`${key}/${key}.md`, [
    jsonField('type', 'project'),
    jsonField('key', key),
    jsonField('name', key),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
}

// ADR 0017 / MMR-181: the reader is data-tolerant of referential corruption —
// it drops the invalid node/edge and emits a valid closed subgraph instead of
// throwing, so one bad record can't take the whole load down.
test.skipIf(!NORN)('drops a node whose owning project is absent (no throw)', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Kept'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  // ZZZ-1 has no ZZZ project document → hidden, and its siblings would be too.
  await writeDoc('ZZZ/ZZZ-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Orphan'),
    jsonField('parent', wikilink('ZZZ')),
    jsonField('lifecycle', 'todo'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  // ZZZ-1 dropped (no ZZZ project); MMR-1 the lone survivor. Resolve each
  // survivor's REAL project key (not a hardcoded 'MMR') so an inverted regression
  // — keep ZZZ-1, drop MMR-1 — can't render as 'MMR-1' and pass green.
  const keyById = new Map(ws.projects.map((p) => [p.id, p.key]));
  expect(
    ws.nodes.map((n) => renderId({ key: must(keyById.get(n.project_id)), seq: n.seq })),
  ).toEqual(['MMR-1']);
});

test.skipIf(!NORN)('drops a dangling KEY-seq parent edge; the node floats to root', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Lost'),
    jsonField('parent', wikilink('MMR-99')), // no such node
    jsonField('lifecycle', 'todo'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  const node = must(ws.nodes.find((n) => n.seq === 1));
  expect(node.parent_id).toBeNull(); // dangling parent dropped → floats to project root
});

// MMR-190: a relational ref written as an ALIASED wikilink `[[STEM|display]]`.
// `collapse` must keep the STEM so the ref resolves through the normal
// valid/dangling path — a dangling aliased parent floats to root with a proper
// drop (not a silent float on the `|`-laden literal that used to slip parseId),
// and readVaultGraph surfaces the de-aliased stem for doctor's finding.
test.skipIf(!NORN)(
  'drops a dangling aliased parent; readVaultGraph de-aliases the ref',
  async () => {
    await writeProjectDoc('MMR');
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Aliased orphan'),
      jsonField('parent', aliasedWikilink('MMR-99', 'Some Title')), // no such node
      jsonField('lifecycle', 'todo'),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    // The raw graph surfaces the STEM, not the `|`-laden literal.
    const graph = await readVaultGraph(client);
    const orphan = must(graph.nodes.find((n) => n.stem === 'MMR-1'));
    expect(orphan.parent).toBe('MMR-99');
    // The loader drops the dangling edge and floats the node to root — no silent skip.
    const ws = await loadWorkingSetOverNorn(client);
    const node = must(ws.nodes.find((n) => n.seq === 1));
    expect(node.parent_id).toBeNull();
  },
);

test.skipIf(!NORN)(
  'drops a dangling aliased depends_on; readVaultGraph de-aliases the ref',
  async () => {
    await writeProjectDoc('MMR');
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Dependent'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('depends_on', [aliasedWikilink('MMR-99', 'Some Title')]), // no such node
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    // The raw graph surfaces the STEM, not the `|`-laden literal.
    const graph = await readVaultGraph(client);
    const dependent = must(graph.nodes.find((n) => n.stem === 'MMR-1'));
    expect(dependent.dependsOn).toEqual(['MMR-99']);
    // The loader keeps the node and drops only the dangling prerequisite edge.
    const ws = await loadWorkingSetOverNorn(client);
    expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq }))).toEqual(['MMR-1']);
    expect(ws.edges).toEqual([]);
  },
);

// ADR 0017 / MMR-177: field-level corruption is tolerated too. A load-bearing
// field — lifecycle (drives status) or hold (drives blocked/parked) — missing or
// foreign drops the NODE (no safe absent value); an optional field — priority or
// size — foreign nulls just the FIELD and the node loads. Was a loud throw.
test.skipIf(!NORN)(
  'drops a task with no lifecycle but keeps a healthy sibling (no throw)',
  async () => {
    await writeProjectDoc('MMR');
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'task'),
      jsonField('title', 'No lifecycle'),
      jsonField('parent', wikilink('MMR')),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    // A healthy sibling proves the drop is SURGICAL — only the corrupt node goes.
    await writeDoc('MMR/MMR-2.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Healthy'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    const ws = await loadWorkingSetOverNorn(client);
    // MMR-1 dropped for the missing load-bearing field; MMR-2 survives.
    expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq }))).toEqual(['MMR-2']);
  },
);

test.skipIf(!NORN)('drops a dangling prerequisite edge; the node stays (no throw)', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Dependent'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('depends_on', [wikilink('MMR-99')]), // no such node
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq }))).toEqual(['MMR-1']); // kept
  expect(ws.edges).toEqual([]); // dangling prerequisite dropped
});

// ADR 0017 / MMR-174: a self-dependency is the degenerate cycle — the validator
// drops the self-edge and the node loads cleanly, no throw (was a loud throw).
test.skipIf(!NORN)(
  'drops a self-dependency; the node stays with no self-edge (no throw)',
  async () => {
    await writeProjectDoc('MMR');
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Self'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('depends_on', [wikilink('MMR-1')]),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    const ws = await loadWorkingSetOverNorn(client);
    expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq }))).toEqual(['MMR-1']); // kept
    expect(ws.edges).toEqual([]); // the self-dependency dropped — no edge
  },
);

// A longer depends_on cycle: both nodes load, only the cycle-closing back edge is
// dropped — the loader once silently accepted this and then derived wrongly.
test.skipIf(!NORN)('drops one edge of a 2-node depends_on cycle; both nodes load', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'One'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('depends_on', [wikilink('MMR-2')]),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  await writeDoc('MMR/MMR-2.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Two'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('depends_on', [wikilink('MMR-1')]), // closes the cycle
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  const byId = new Map(ws.nodes.map((n) => [n.id, n]));
  expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq })).toSorted()).toEqual([
    'MMR-1',
    'MMR-2',
  ]);
  // The canonical back edge MMR-2 → MMR-1 is dropped; the forward edge MMR-1 →
  // MMR-2 survives. Assert the one surviving edge resolves that way.
  expect(ws.edges).toHaveLength(1);
  const edge = must(ws.edges[0]);
  expect(must(byId.get(edge.node_id)).seq).toBe(1); // MMR-1 depends on...
  expect(must(byId.get(edge.depends_on_node_id)).seq).toBe(2); // ...MMR-2
});

test.skipIf(!NORN)('drops a task with a foreign hold value (no throw)', async () => {
  await writeProjectDoc('MMR');
  // hold drives blocked/parked, so a foreign value has no safe coercion (unlike an
  // absent hold, which legitimately reconstructs to the 'none' default) — the node
  // is dropped rather than silently coerced.
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Bogus hold'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('hold', 'bogus'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  // A healthy sibling proves the drop is surgical — only the corrupt node goes.
  await writeDoc('MMR/MMR-2.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Healthy'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  // MMR-1 dropped for the foreign load-bearing field; MMR-2 survives.
  expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq }))).toEqual(['MMR-2']);
});

test.skipIf(!NORN)('loads a task with a foreign priority as null (no throw)', async () => {
  await writeProjectDoc('MMR');
  // priority is optional (null is a truthful "unset"), so a foreign value nulls the
  // field and the node survives — no throw, no drop.
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Bogus priority'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('priority', 'p9'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  const node = must(ws.nodes.find((n) => n.seq === 1));
  expect(node.priority).toBeNull();
});

test.skipIf(!NORN)('loads a task with a foreign size as null (no throw)', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Bogus size'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('size', 'huge'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  const node = must(ws.nodes.find((n) => n.seq === 1));
  expect(node.size).toBeNull();
});

test.skipIf(!NORN)('deduplicates repeated depends_on wikilinks into one edge', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Prereq'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  await writeDoc('MMR/MMR-2.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Dependent'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('depends_on', [wikilink('MMR-1'), wikilink('MMR-1')]),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  expect(ws.edges).toHaveLength(1);
});

test.skipIf(!NORN)('ignores task-only fields on a non-task document', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'phase'),
    jsonField('title', 'Phase with stray fields'),
    jsonField('parent', wikilink('MMR')),
    jsonField('priority', 'p1'),
    jsonField('rank', 5),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  const phase = must(ws.nodes[0]);
  expect(phase.type).toBe('phase');
  expect(phase.priority).toBeNull();
  expect(phase.rank).toBeNull();
});

// MMR-169: readVaultGraph reads raw parent/depends_on stems for doctor to
// enumerate; the tolerant loader (MMR-181) drops the same dangling edge and
// keeps loading. Both read the vault's referential truth — one raw, one dropped.
test.skipIf(!NORN)(
  'readVaultGraph reads raw refs; the loader tolerates a dangling parent',
  async () => {
    const at = '2026-07-05T00:00:00.000Z';
    await writeDoc('MMR/MMR.md', [
      jsonField('type', 'project'),
      jsonField('key', 'MMR'),
      jsonField('name', 'Mimir'),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'initiative'),
      jsonField('title', 'Init'),
      jsonField('parent', wikilink('MMR')),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);
    // MMR-2's parent points at MMR-99, which does not exist — an orphan.
    await writeDoc('MMR/MMR-2.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Orphan'),
      jsonField('parent', wikilink('MMR-99')),
      jsonField('lifecycle', 'todo'),
      jsonField('depends_on', [wikilink('MMR-1')]),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);

    // Reading the raw graph never throws and surfaces the dangling parent verbatim.
    const graph = await readVaultGraph(client);
    const orphan = must(graph.nodes.find((n) => n.stem === 'MMR-2'));
    expect(orphan.parent).toBe('MMR-99');
    expect(orphan.dependsOn).toEqual(['MMR-1']); // a resolvable prereq decodes too
    expect(graph.projectKeys).toEqual(['MMR']); // the project partition, by `key`

    // The tolerant loader (MMR-181) no longer throws: MMR-2 loads with its
    // dangling parent dropped (floated to root), its resolvable prereq intact.
    const ws = await loadWorkingSetOverNorn(client);
    const loaded = must(ws.nodes.find((n) => n.seq === 2));
    expect(loaded.parent_id).toBeNull(); // MMR-99 edge dropped
    expect(ws.edges).toHaveLength(1); // MMR-2 → MMR-1 survives
  },
);

// readVaultGraph.nodes must hold only the docs the loader actually resolves refs
// for — its `rawNodes` partition (task/phase/initiative with a KEY-seq stem). A
// project's stray ref and an invalid-stem node's ref are NEVER resolved by the
// loader, so surfacing them would make doctor false-positive a vault that loads.
test.skipIf(!NORN)(
  'readVaultGraph skips projects and invalid-stem docs from nodes (no false positives)',
  async () => {
    const at = '2026-07-05T00:00:00.000Z';
    // A project carrying a stray depends_on the loader never resolves...
    await writeDoc('MMR/MMR.md', [
      jsonField('type', 'project'),
      jsonField('key', 'MMR'),
      jsonField('name', 'Mimir'),
      jsonField('depends_on', [wikilink('MMR-99')]),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);
    // ...and a task at a non-KEY-seq stem the loader drops.
    await writeDoc('MMR/notes.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Loose'),
      jsonField('parent', wikilink('MMR-99')),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);

    // Neither breaks the load: the project isn't a node, 'notes' is dropped.
    const ws = await loadWorkingSetOverNorn(client);
    expect(ws.nodes).toHaveLength(0);
    // So readVaultGraph.nodes must surface neither — else doctor flags a readable
    // vault. The project's `key` is still captured (its own partition).
    const graph = await readVaultGraph(client);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.projectKeys).toEqual(['MMR']);
  },
);

// MMR-178: a node whose owning project has no document. readVaultGraph surfaces
// the node with an empty projectKeys set; the tolerant loader (MMR-181) hides
// it — the premise the missing-project check exists for.
test.skipIf(!NORN)(
  'readVaultGraph surfaces a node with no project; the loader hides it',
  async () => {
    const at = '2026-07-05T00:00:00.000Z';
    // A well-formed task MMR-2 (root under project MMR, with a lifecycle so a
    // failure to drop it would surface the node rather than throw on a missing
    // field — the drop is then the sole reason the load returns []) but NO
    // project MMR doc.
    await writeDoc('MMR/MMR-2.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Homeless'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);

    const graph = await readVaultGraph(client);
    expect(graph.nodes.map((n) => n.stem)).toEqual(['MMR-2']);
    expect(graph.projectKeys).toEqual([]); // no project doc → the missing-project case

    // The tolerant loader (MMR-181) hides the node instead of throwing — a
    // missing container has no valid place for its nodes to live.
    const ws = await loadWorkingSetOverNorn(client);
    expect(ws.nodes).toEqual([]);
  },
);
