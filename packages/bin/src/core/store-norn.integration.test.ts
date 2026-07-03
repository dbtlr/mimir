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
import { loadWorkingSetOverNorn } from './store-norn';
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

const tagNames = (records: readonly { tag: string }[]): string[] => records.map((t) => t.tag);

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
  await tagEntities(store, [{ entityId: b.id, entityType: 'node' }], ['workspace:mmr']);
  await tagEntities(store, [{ entityId: project.id, entityType: 'project' }], ['release:v1']);

  const sqliteWs = await store.loadWorkingSet();
  await seedVaultFromWorkingSet(sqliteWs);
  const nornWs = await loadWorkingSetOverNorn(client);

  expect(normalize(nornWs)).toEqual(normalize(sqliteWs));
});
