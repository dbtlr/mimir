import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Db } from '../core/context';
import { createInitiative, createPhase, createProject, createTask } from '../core/create';
import { depend } from '../core/mutations/dependency';
import type { Store } from '../core/store';
import { createSqliteStore } from '../core/store-sqlite';
import { createTestDb } from '../db/testing';
import type { NornClient } from '../norn/client';
import { nodeFrontmatter, nornSeedWrite, projectFrontmatter, seedNodes } from './node-seed';
import type { SeedDoc } from './node-seed';

let db: Db;
let store: Store;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
});
afterEach(async () => {
  await db.destroy();
});

/** A recording write — captures every doc in order, always reports `created`. */
function recorder(): { docs: SeedDoc[]; write: (doc: SeedDoc) => Promise<'created'> } {
  const docs: SeedDoc[] = [];
  return {
    docs,
    write: (doc) => {
      docs.push(doc);
      return Promise.resolve('created');
    },
  };
}

const byPath = (docs: SeedDoc[], path: string): SeedDoc | undefined =>
  docs.find((d) => d.path === path);

// ── Field mapping ──────────────────────────────────────────────────────────

test('projectFrontmatter carries key/name/type + timestamps, omits empty, drops seq counters', () => {
  const fm = projectFrontmatter(
    {
      archived_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      description: null,
      id: 1,
      key: 'FOO',
      last_artifact_seq: 3,
      last_seq: 9,
      name: 'Foo',
      updated_at: '2026-01-02T00:00:00.000Z',
    },
    [],
  );
  expect(fm).toEqual({
    created: '2026-01-01T00:00:00.000Z',
    key: 'FOO',
    name: 'Foo',
    type: 'project',
    updated_at: '2026-01-02T00:00:00.000Z',
  });
  // seq counters and null fields never surface
  expect(fm).not.toHaveProperty('last_seq');
  expect(fm).not.toHaveProperty('description');
  expect(fm).not.toHaveProperty('archived_at');
});

test('projectFrontmatter includes archived_at, description, and tag names when present', () => {
  const fm = projectFrontmatter(
    {
      archived_at: '2026-03-01T00:00:00.000Z',
      created_at: 'c',
      description: 'a thing',
      id: 1,
      key: 'FOO',
      last_artifact_seq: 0,
      last_seq: 0,
      name: 'Foo',
      updated_at: 'u',
    },
    [
      { created_at: 'c', note: null, tag: 'release:v1' },
      { created_at: 'c', note: 'x', tag: 'workspace:foo' },
    ],
  );
  expect(fm.archived_at).toBe('2026-03-01T00:00:00.000Z');
  expect(fm.description).toBe('a thing');
  expect(fm.tags).toEqual(['release:v1', 'workspace:foo']);
});

const bareNode = {
  completed_at: null,
  created_at: 'c',
  description: null,
  external_ref: null,
  hold: null,
  hold_reason: null,
  id: 10,
  lifecycle: null,
  parent_id: null,
  priority: null,
  project_id: 1,
  rank: null,
  seq: 5,
  size: null,
  target: null,
  title: 'A node',
  type: 'initiative' as const,
  updated_at: 'u',
};

test('nodeFrontmatter for a bare initiative is type/title/timestamps only', () => {
  const fm = nodeFrontmatter(bareNode, { dependsOn: [], parentStem: null, tags: [] });
  expect(fm).toEqual({ created: 'c', title: 'A node', type: 'initiative', updated_at: 'u' });
});

test('nodeFrontmatter writes parent + depends_on as wikilinks and tags as names', () => {
  const fm = nodeFrontmatter(
    { ...bareNode, hold: 'none', lifecycle: 'todo', parent_id: 3, type: 'task' },
    {
      dependsOn: ['FOO-2', 'BAR-7'],
      parentStem: 'FOO-1',
      tags: [{ created_at: 'c', note: null, tag: 'urgent' }],
    },
  );
  expect(fm.parent).toBe('[[FOO-1]]');
  expect(fm.depends_on).toEqual(['[[FOO-2]]', '[[BAR-7]]']);
  expect(fm.tags).toEqual(['urgent']);
  expect(fm.lifecycle).toBe('todo');
});

test("nodeFrontmatter omits hold when 'none', keeps a real hold + reason", () => {
  const none = nodeFrontmatter(
    { ...bareNode, hold: 'none', type: 'task' },
    { dependsOn: [], parentStem: null, tags: [] },
  );
  expect(none).not.toHaveProperty('hold');
  const held = nodeFrontmatter(
    { ...bareNode, hold: 'parked', hold_reason: 'waiting upstream', type: 'task' },
    { dependsOn: [], parentStem: null, tags: [] },
  );
  expect(held.hold).toBe('parked');
  expect(held.hold_reason).toBe('waiting upstream');
});

test('nodeFrontmatter carries task signals and a phase target, rank as a number', () => {
  const task = nodeFrontmatter(
    {
      ...bareNode,
      completed_at: 'done-at',
      external_ref: 'JIRA-9',
      priority: 'p1',
      rank: 7,
      size: 'large',
      type: 'task',
    },
    { dependsOn: [], parentStem: null, tags: [] },
  );
  expect(task).toMatchObject({
    completed_at: 'done-at',
    external_ref: 'JIRA-9',
    priority: 'p1',
    rank: 7,
    size: 'large',
  });
  expect(typeof task.rank).toBe('number');
  const phase = nodeFrontmatter(
    { ...bareNode, target: 'v2', type: 'phase' },
    { dependsOn: [], parentStem: null, tags: [] },
  );
  expect(phase.target).toBe('v2');
});

// ── Orchestration over a real working set ────────────────────────────────────

test('seedNodes projects a real store: projects first, then nodes with resolved relations', async () => {
  const foo = await createProject(store, { key: 'FOO', name: 'Foo', tags: ['release:v1'] });
  const init = await createInitiative(store, { projectId: foo.id, title: 'Init' });
  const phase = await createPhase(store, { parentId: init.id, target: 'v2', title: 'Phase' });
  const t1 = await createTask(store, {
    parentId: phase.id,
    priority: 'p1',
    tags: ['urgent'],
    title: 'First',
  });
  const t2 = await createTask(store, { parentId: phase.id, title: 'Second' });
  await depend(store, t2.id, [t1.id]);

  const ws = await store.loadWorkingSet();
  const rec = recorder();
  const report = await seedNodes(ws, rec.write);

  expect(report).toEqual({ created: 5, nodes: 4, projects: 1 });
  // Project doc lands before any node doc (parents-on-disk-first).
  expect(rec.docs[0]?.path).toBe('FOO/FOO.md');
  expect(rec.docs.slice(1).every((d) => d.path.startsWith('FOO/FOO-'))).toBe(true);

  const initStem = `FOO-${String(init.seq)}`;
  const phaseStem = `FOO-${String(phase.seq)}`;
  const t1Stem = `FOO-${String(t1.seq)}`;
  const t2Stem = `FOO-${String(t2.seq)}`;

  expect(byPath(rec.docs, 'FOO/FOO.md')?.frontmatter.tags).toEqual(['release:v1']);
  // phase.parent -> initiative wikilink
  expect(byPath(rec.docs, `FOO/${phaseStem}.md`)?.frontmatter.parent).toBe(`[[${initStem}]]`);
  // t1: parent phase, tag, priority; hold 'none' omitted
  const t1fm = byPath(rec.docs, `FOO/${t1Stem}.md`)?.frontmatter;
  expect(t1fm?.parent).toBe(`[[${phaseStem}]]`);
  expect(t1fm?.priority).toBe('p1');
  expect(t1fm?.tags).toEqual(['urgent']);
  expect(t1fm).not.toHaveProperty('hold');
  // t2 depends_on t1
  expect(byPath(rec.docs, `FOO/${t2Stem}.md`)?.frontmatter.depends_on).toEqual([`[[${t1Stem}]]`]);
});

test('seedNodes resolves a cross-project dependency to the prerequisite stem', async () => {
  const foo = await createProject(store, { key: 'FOO', name: 'Foo' });
  const bar = await createProject(store, { key: 'BAR', name: 'Bar' });
  const fooInit = await createInitiative(store, { projectId: foo.id, title: 'FI' });
  const fooPhase = await createPhase(store, { parentId: fooInit.id, title: 'FP' });
  const barInit = await createInitiative(store, { projectId: bar.id, title: 'BI' });
  const barPhase = await createPhase(store, { parentId: barInit.id, title: 'BP' });
  const consumer = await createTask(store, { parentId: fooPhase.id, title: 'consumer' });
  const prereq = await createTask(store, { parentId: barPhase.id, title: 'prereq' });
  await depend(store, consumer.id, [prereq.id]);

  const ws = await store.loadWorkingSet();
  const rec = recorder();
  await seedNodes(ws, rec.write);

  const consumerFm = byPath(rec.docs, `FOO/FOO-${String(consumer.seq)}.md`)?.frontmatter;
  expect(consumerFm?.depends_on).toEqual([`[[BAR-${String(prereq.seq)}]]`]);
});

// ── The live-Norn write ─────────────────────────────────────────────────────

test('nornSeedWrite: fresh path -> newDoc(field_json) reports created', async () => {
  const calls: { method: string; args: unknown }[] = [];
  const client = {
    newDoc: (args: unknown) => {
      calls.push({ args, method: 'newDoc' });
      return Promise.resolve({});
    },
    set: (args: unknown) => {
      calls.push({ args, method: 'set' });
      return Promise.resolve({});
    },
  } as unknown as NornClient;

  const outcome = await nornSeedWrite(client)({
    frontmatter: { depends_on: ['[[FOO-2]]'], rank: 7, type: 'task' },
    path: 'FOO/FOO-3.md',
  });

  expect(outcome).toBe('created');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe('newDoc');
  const args = calls[0]?.args as { path: string; field_json: string[]; parents: boolean };
  expect(args.path).toBe('FOO/FOO-3.md');
  expect(args.parents).toBe(true);
  // field_json is `name=<json>`, so rank stays a number and lists stay JSON arrays
  expect(args.field_json).toContain('rank=7');
  expect(args.field_json).toContain('type="task"');
  expect(args.field_json).toContain('depends_on=["[[FOO-2]]"]');
});

test('nornSeedWrite: a path collision fails loud, never merging onto the occupant', async () => {
  const calls: { method: string }[] = [];
  const client = {
    newDoc: () => Promise.reject(new Error('destination already exists: FOO/FOO-3.md')),
    set: () => {
      calls.push({ method: 'set' });
      return Promise.resolve({});
    },
  } as unknown as NornClient;

  let caught: unknown;
  try {
    await nornSeedWrite(client)({
      frontmatter: { lifecycle: 'in_progress', type: 'task' },
      path: 'FOO/FOO-3.md',
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/already has a document at FOO\/FOO-3\.md/);
  // no fallback merge: it would leave fields cleared in SQLite stale, and could clobber a foreign doc
  expect(calls).toHaveLength(0);
});

test('nornSeedWrite: a non-collision newDoc error propagates (no silent skip)', async () => {
  const client = {
    newDoc: () => Promise.reject(new Error('norn transport closed')),
    set: () => Promise.reject(new Error('should not be called')),
  } as unknown as NornClient;

  let caught: unknown;
  try {
    await nornSeedWrite(client)({ frontmatter: { type: 'task' }, path: 'FOO/FOO-3.md' });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe('norn transport closed');
});
