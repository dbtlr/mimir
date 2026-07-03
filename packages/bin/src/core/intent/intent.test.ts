import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb, expectReject } from '../../db/testing';
import type { Db } from '../context';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { attachArtifact, blockTask, completeTask, depend, startTask } from '../mutations';
import type { Store } from '../store';
import { createSqliteStore } from '../store-sqlite';
import { getArtifact, getNode, listNodes, nextTasks, statusOfNode } from './index';

let db: Db;
let store: Store;
let phaseId: number;
let key: string;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  key = p.key;
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  phaseId = phase.id;
});
afterEach(async () => {
  await db.destroy();
});

const idOf = (n: { seq: number }) => `${key}-${n.seq}`;

test('next returns ready tasks in rank order, excluding awaiting/held', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a' });
  const b = await createTask(store, { parentId: phaseId, title: 'b' });
  const c = await createTask(store, { parentId: phaseId, title: 'c' });
  // b awaits a; c is blocked → only a and (later) others are ready
  await depend(store, b.id, [a.id]);
  await blockTask(store, c.id, 'later');

  const res = await nextTasks(createSqliteStore(db), { scope: key });
  expect(res.items.map((n) => n.id)).toEqual([idOf(a)]);
  expect(res.total).toBe(1);
  expect(res.items[0]?.status).toBe('ready');

  // completing a unblocks b
  await completeTask(store, a.id);
  const res2 = await nextTasks(createSqliteStore(db), { scope: key });
  expect(res2.items.map((n) => n.id)).toEqual([idOf(b)]);
});

test('next respects priority filter and the limit', async () => {
  await createTask(store, { parentId: phaseId, priority: 'p2', title: 'p2' });
  const hi = await createTask(store, { parentId: phaseId, priority: 'p0', title: 'p0' });
  const onlyP0 = await nextTasks(createSqliteStore(db), { priority: 'p0', scope: key });
  expect(onlyP0.items.map((n) => n.id)).toEqual([idOf(hi)]);

  const limited = await nextTasks(createSqliteStore(db), { limit: 1, scope: key });
  expect(limited.returned).toBe(1);
  expect(limited.total).toBe(2); // total reflects the full ready set
});

test('a direct prerequisite surfaces in awaitingOn (no via) and clears when settled', async () => {
  const x = await createTask(store, { parentId: phaseId, title: 'x' });
  const y = await createTask(store, { parentId: phaseId, title: 'y' });
  await depend(store, y.id, [x.id]);

  const view = await getNode(store, idOf(y));
  expect(view.deps?.dependsOn.map((r) => r.id)).toEqual([idOf(x)]);
  expect(view.deps?.awaitingOn.map((r) => ({ id: r.id, via: r.via }))).toEqual([
    { id: idOf(x), via: undefined },
  ]);

  await completeTask(store, x.id); // prerequisite terminal → gate clears
  expect((await getNode(store, idOf(y))).deps?.awaitingOn).toEqual([]);
});

test('an inherited prerequisite surfaces in awaitingOn, tagged via the ancestor', async () => {
  const { parent_id } = await db
    .selectFrom('node')
    .select('parent_id')
    .where('id', '=', phaseId)
    .executeTakeFirstOrThrow();
  const initId = parent_id as number;
  const phase1 = await createPhase(store, { parentId: initId, title: 'phase 1' });
  const phase2 = await createPhase(store, { parentId: initId, title: 'phase 2' });
  await depend(store, phase2.id, [phase1.id]); // edge on the ancestor phase
  const t = await createTask(store, { parentId: phase2.id, title: 't' });

  const view = await getNode(store, idOf(t));
  expect(view.deps?.dependsOn).toEqual([]); // t declares nothing of its own
  expect(view.deps?.awaitingOn.map((r) => ({ id: r.id, via: r.via }))).toEqual([
    { id: idOf(phase1), via: idOf(phase2) }, // inherited from phase 2
  ]);
});

test('awaitingOn lists a prereq reachable both directly and via an ancestor only once', async () => {
  const { parent_id } = await db
    .selectFrom('node')
    .select('parent_id')
    .where('id', '=', phaseId)
    .executeTakeFirstOrThrow();
  const initId = parent_id as number;
  const prereq = await createPhase(store, { parentId: initId, title: 'prereq phase' }); // empty → unsettled
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  await depend(store, t.id, [prereq.id]); // direct edge
  await depend(store, phaseId, [prereq.id]); // same prereq, now also inherited via the phase

  const awaitingOn = (await getNode(store, idOf(t))).deps?.awaitingOn ?? [];
  expect(awaitingOn.map((r) => ({ id: r.id, via: r.via }))).toEqual([
    { id: idOf(prereq), via: undefined }, // listed once, the direct entry wins
  ]);
});

test('get returns a full record with cheap facets and resolves KEY-seq', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a' });
  const b = await createTask(store, { parentId: phaseId, title: 'b' });
  await depend(store, b.id, [a.id]);

  const view = await getNode(store, idOf(b));
  expect(view.id).toBe(idOf(b));
  expect(view.title).toBe('b');
  expect(view.lifecycle).toBe('todo');
  expect(view.deps?.dependsOn.map((r) => r.id)).toEqual([idOf(a)]);
  expect(view.tags).toEqual([]); // cheap facet present, empty
  expect(view.history).toBeUndefined(); // heavy facet opt-in
});

test('get throws on a missing or malformed id', async () => {
  await expectReject(() => getNode(store, 'MMR-999'));
  await expectReject(() => getNode(store, 'not-an-id'));
});

test('status_of returns label + distribution for a non-leaf', async () => {
  const t1 = await createTask(store, { parentId: phaseId, title: 't1' });
  await createTask(store, { parentId: phaseId, title: 't2' });
  await startTask(store, t1.id);

  const phase = await db
    .selectFrom('node')
    .select('seq')
    .where('id', '=', phaseId)
    .executeTakeFirstOrThrow();
  const status = await statusOfNode(store, `${key}-${String(phase.seq)}`);
  expect(status.status).toBe('in_progress');
  expect(status.distribution).toEqual({ in_progress: 1, ready: 1 });
});

// addressability (MMR-32): the full grammar on get/status

test('get on a bare KEY returns the whole-project view', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  await startTask(store, t.id);

  const view = await getNode(store, key);
  expect(view.id).toBe(key);
  expect(view.type).toBe('project');
  expect(view.title).toBe('m');
  expect(view.status).toBe('in_progress'); // interpret over the root initiative
  expect(view.children?.length).toBe(1); // the root initiative
  expect(view.distribution).toEqual({ in_progress: 1 });
});

test("status_of on a bare KEY rolls up the project's roots", async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  await startTask(store, t.id);

  const status = await statusOfNode(store, key);
  expect(status.id).toBe(key);
  expect(status.status).toBe('in_progress');
  expect(status.distribution).toEqual({ in_progress: 1 });
});

test('get on KEY-aN returns the artifact detail with rendered links', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const project = await db.selectFrom('project').select('id').executeTakeFirstOrThrow();
  const { renderedId } = await attachArtifact(store, {
    content: '# frozen\n',
    linkNodeIds: [t.id],
    projectId: project.id,
    title: 'frozen plan',
  });
  expect(renderedId).toBe(`${key}-a1`);

  const detail = await getArtifact(store, renderedId);
  expect(detail.id).toBe(`${key}-a1`);
  expect(detail.project).toBe(key);
  expect(detail.links).toEqual([idOf(t)]);
});

test('status_of rejects an artifact id as a behavioral error', async () => {
  await expectReject(() => statusOfNode(store, `${key}-a1`));
});

test('the node artifacts facet speaks KEY-aN', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const project = await db.selectFrom('project').select('id').executeTakeFirstOrThrow();
  await attachArtifact(store, {
    content: 'x',
    linkNodeIds: [t.id],
    projectId: project.id,
    title: 'x',
  });

  const view = await getNode(store, idOf(t));
  expect(view.artifacts?.map((a) => a.id)).toEqual([`${key}-a1`]);

  const projectView = await getNode(store, key, { facets: ['artifacts'] });
  expect(projectView.artifacts?.map((a) => a.id)).toEqual([`${key}-a1`]);
});

test('list selects by status universe (MMR-33)', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a' });
  const b = await createTask(store, { parentId: phaseId, title: 'b' });
  await blockTask(store, b.id, 'x');

  const blocked = await listNodes(createSqliteStore(db), { scope: key, status: 'blocked' });
  expect(blocked.items.map((n) => n.id)).toEqual([idOf(b)]);

  const ready = await listNodes(createSqliteStore(db), { scope: key, status: 'ready' });
  expect(ready.items.map((n) => n.id)).toEqual([idOf(a)]);

  const live = await listNodes(createSqliteStore(db), { scope: key });
  expect(live.total).toBe(2); // live is the default universe

  await completeTask(store, a.id);
  const terminal = await listNodes(createSqliteStore(db), { scope: key, status: 'terminal' });
  expect(terminal.items.map((n) => n.id)).toEqual([idOf(a)]);
  const all = await listNodes(createSqliteStore(db), { scope: key, status: 'all' });
  expect(all.total).toBe(2);
});

test('list filters by q — case-insensitive substring over title (MMR-78)', async () => {
  const auth = await createTask(store, { parentId: phaseId, title: 'Wire up AUTH gate' });
  await createTask(store, { parentId: phaseId, title: 'Polish the board' });

  const hit = await listNodes(createSqliteStore(db), { q: 'auth', scope: key });
  expect(hit.items.map((n) => n.id)).toEqual([idOf(auth)]);

  expect((await listNodes(createSqliteStore(db), { q: 'zzz', scope: key })).total).toBe(0);
  // an empty q is a no-op, not a match-nothing
  expect((await listNodes(createSqliteStore(db), { q: '', scope: key })).total).toBe(2);

  // LIKE parity: %/_ inside q act as wildcards, and a regex special is literal
  expect((await listNodes(createSqliteStore(db), { q: 'a_th', scope: key })).total).toBe(1);
  expect((await listNodes(createSqliteStore(db), { q: 'wire%gate', scope: key })).total).toBe(1);
  expect((await listNodes(createSqliteStore(db), { q: 'auth.', scope: key })).total).toBe(0);
});

test('deps facet lists prerequisites in ascending id order regardless of edge insertion order', async () => {
  const older = await createTask(store, { parentId: phaseId, title: 'older prereq' });
  const newer = await createTask(store, { parentId: phaseId, title: 'newer prereq' });
  const dependent = await createTask(store, { parentId: phaseId, title: 'dependent' });
  // insert edges newest-first — the SQL path read them back id-ascending (PK index)
  await depend(store, dependent.id, [newer.id, older.id]);

  const view = await getNode(store, idOf(dependent), { facets: ['deps'] });
  expect(view.deps?.dependsOn.map((r) => r.id)).toEqual([idOf(older), idOf(newer)]);
  expect(view.deps?.awaitingOn.map((r) => r.id)).toEqual([idOf(older), idOf(newer)]);
});

test('list q matches SQL LIKE for non-ASCII case (SQLite lower() is ASCII-only)', async () => {
  await createTask(store, { parentId: phaseId, title: 'Über refactor' });
  await createTask(store, { parentId: phaseId, title: 'über cleanup' });

  // ASCII case folds both ways; non-ASCII stays case-sensitive — LIKE parity.
  expect((await listNodes(createSqliteStore(db), { q: 'über', scope: key })).total).toBe(1);
  expect((await listNodes(createSqliteStore(db), { q: 'ÜBER', scope: key })).total).toBe(1);
  expect((await listNodes(createSqliteStore(db), { q: 'REFACTOR', scope: key })).total).toBe(1);
});

test('list q: the _ wildcard consumes one full code point, astral included (LIKE parity)', async () => {
  await createTask(store, { parentId: phaseId, title: 'a😀b' });

  expect((await listNodes(createSqliteStore(db), { q: 'a_b', scope: key })).total).toBe(1);
  expect((await listNodes(createSqliteStore(db), { q: 'a__b', scope: key })).total).toBe(0);
});

test('list applies verdicts and field operators within the universe', async () => {
  const a = await createTask(store, { parentId: phaseId, priority: 'p1', title: 'a' });
  const b = await createTask(store, { parentId: phaseId, priority: 'p2', title: 'b' });
  await depend(store, b.id, [a.id]); // a blocks b

  const blocking = await listNodes(createSqliteStore(db), {
    scope: key,
    verdicts: [{ negate: false, verdict: 'blocking' }],
  });
  expect(blocking.items.map((n) => n.id)).toEqual([idOf(a)]);

  const notBlocking = await listNodes(createSqliteStore(db), {
    scope: key,
    verdicts: [{ negate: true, verdict: 'blocking' }],
  });
  expect(notBlocking.items.map((n) => n.id)).toEqual([idOf(b)]);

  const p2 = await listNodes(createSqliteStore(db), {
    filters: [{ field: 'priority', op: 'eq', value: 'p2' }],
    scope: key,
  });
  expect(p2.items.map((n) => n.id)).toEqual([idOf(b)]);
});

test('a value fault returns an empty set with warnings, not an error', async () => {
  await createTask(store, { parentId: phaseId, priority: 'p1', title: 'a' });
  const res = await listNodes(createSqliteStore(db), {
    filters: [{ field: 'priority', op: 'eq', value: 'p9' }],
    scope: key,
  });
  expect(res.total).toBe(0);
  expect(res.items).toEqual([]);
  expect(res.warnings?.[0]?.code).toBe('no_match_value');
  expect(res.warnings?.[0]?.expected).toEqual(['p0', 'p1', 'p2', 'p3']);
});

test('a type filter widens list beyond tasks', async () => {
  await createTask(store, { parentId: phaseId, title: 'a' });
  const phases = await listNodes(createSqliteStore(db), {
    filters: [{ field: 'type', op: 'eq', value: 'phase' }],
    scope: key,
  });
  expect(phases.items.map((n) => n.type)).toEqual(['phase']);
});

test('terminal universe orders by completed_at desc', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a' });
  const b = await createTask(store, { parentId: phaseId, title: 'b' });
  await completeTask(store, a.id);
  await completeTask(store, b.id);
  // pin distinct completion instants (same-ms completions would tie)
  await db
    .updateTable('node')
    .set({ completed_at: '2026-06-01T00:00:00.000Z' })
    .where('id', '=', a.id)
    .execute();
  await db
    .updateTable('node')
    .set({ completed_at: '2026-06-02T00:00:00.000Z' })
    .where('id', '=', b.id)
    .execute();
  const done = await listNodes(createSqliteStore(db), { scope: key, status: 'done' });
  expect(done.items.map((n) => n.id)).toEqual([idOf(b), idOf(a)]);
});

test("the tag pseudo-field filters via the node's tag set", async () => {
  const a = await createTask(store, { parentId: phaseId, tags: ['spec'], title: 'a' });
  await createTask(store, { parentId: phaseId, title: 'b' });
  const tagged = await listNodes(createSqliteStore(db), {
    filters: [{ field: 'tag', op: 'eq', value: 'spec' }],
    scope: key,
  });
  expect(tagged.items.map((n) => n.id)).toEqual([idOf(a)]);
  const untagged = await listNodes(createSqliteStore(db), {
    filters: [{ field: 'tag', op: 'missing', value: null }],
    scope: key,
  });
  expect(untagged.items.map((n) => n.title)).toEqual(['b']);
});
