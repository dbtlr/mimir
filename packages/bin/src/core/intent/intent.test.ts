import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb, expectReject } from '../../db/testing';
import type { Db } from '../context';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { attachArtifact, blockTask, completeTask, depend, startTask } from '../mutations';
import { getArtifact, getNode, listNodes, nextTasks, statusOfNode } from './index';

let db: Db;
let phaseId: number;
let key: string;
beforeEach(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: 'MMR', name: 'm' });
  key = p.key;
  const init = await createInitiative(db, { projectId: p.id, title: 'i' });
  const phase = await createPhase(db, { parentId: init.id, title: 'ph' });
  phaseId = phase.id;
});
afterEach(async () => {
  await db.destroy();
});

const idOf = (n: { seq: number }) => `${key}-${n.seq}`;

test('next returns ready tasks in rank order, excluding awaiting/held', async () => {
  const a = await createTask(db, { parentId: phaseId, title: 'a' });
  const b = await createTask(db, { parentId: phaseId, title: 'b' });
  const c = await createTask(db, { parentId: phaseId, title: 'c' });
  // b awaits a; c is blocked → only a and (later) others are ready
  await depend(db, b.id, [a.id]);
  await blockTask(db, c.id, 'later');

  const res = await nextTasks(db, { scope: key });
  expect(res.items.map((n) => n.id)).toEqual([idOf(a)]);
  expect(res.total).toBe(1);
  expect(res.items[0]?.status).toBe('ready');

  // completing a unblocks b
  await completeTask(db, a.id);
  const res2 = await nextTasks(db, { scope: key });
  expect(res2.items.map((n) => n.id)).toEqual([idOf(b)]);
});

test('next respects priority filter and the limit', async () => {
  await createTask(db, { parentId: phaseId, priority: 'p2', title: 'p2' });
  const hi = await createTask(db, { parentId: phaseId, priority: 'p0', title: 'p0' });
  const onlyP0 = await nextTasks(db, { priority: 'p0', scope: key });
  expect(onlyP0.items.map((n) => n.id)).toEqual([idOf(hi)]);

  const limited = await nextTasks(db, { limit: 1, scope: key });
  expect(limited.returned).toBe(1);
  expect(limited.total).toBe(2); // total reflects the full ready set
});

test('a direct prerequisite surfaces in awaitingOn (no via) and clears when settled', async () => {
  const x = await createTask(db, { parentId: phaseId, title: 'x' });
  const y = await createTask(db, { parentId: phaseId, title: 'y' });
  await depend(db, y.id, [x.id]);

  const view = await getNode(db, idOf(y));
  expect(view.deps?.dependsOn.map((r) => r.id)).toEqual([idOf(x)]);
  expect(view.deps?.awaitingOn.map((r) => ({ id: r.id, via: r.via }))).toEqual([
    { id: idOf(x), via: undefined },
  ]);

  await completeTask(db, x.id); // prerequisite terminal → gate clears
  expect((await getNode(db, idOf(y))).deps?.awaitingOn).toEqual([]);
});

test('an inherited prerequisite surfaces in awaitingOn, tagged via the ancestor', async () => {
  const { parent_id } = await db
    .selectFrom('node')
    .select('parent_id')
    .where('id', '=', phaseId)
    .executeTakeFirstOrThrow();
  const initId = parent_id as number;
  const phase1 = await createPhase(db, { parentId: initId, title: 'phase 1' });
  const phase2 = await createPhase(db, { parentId: initId, title: 'phase 2' });
  await depend(db, phase2.id, [phase1.id]); // edge on the ancestor phase
  const t = await createTask(db, { parentId: phase2.id, title: 't' });

  const view = await getNode(db, idOf(t));
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
  const prereq = await createPhase(db, { parentId: initId, title: 'prereq phase' }); // empty → unsettled
  const t = await createTask(db, { parentId: phaseId, title: 't' });
  await depend(db, t.id, [prereq.id]); // direct edge
  await depend(db, phaseId, [prereq.id]); // same prereq, now also inherited via the phase

  const awaitingOn = (await getNode(db, idOf(t))).deps?.awaitingOn ?? [];
  expect(awaitingOn.map((r) => ({ id: r.id, via: r.via }))).toEqual([
    { id: idOf(prereq), via: undefined }, // listed once, the direct entry wins
  ]);
});

test('get returns a full record with cheap facets and resolves KEY-seq', async () => {
  const a = await createTask(db, { parentId: phaseId, title: 'a' });
  const b = await createTask(db, { parentId: phaseId, title: 'b' });
  await depend(db, b.id, [a.id]);

  const view = await getNode(db, idOf(b));
  expect(view.id).toBe(idOf(b));
  expect(view.title).toBe('b');
  expect(view.lifecycle).toBe('todo');
  expect(view.deps?.dependsOn.map((r) => r.id)).toEqual([idOf(a)]);
  expect(view.tags).toEqual([]); // cheap facet present, empty
  expect(view.history).toBeUndefined(); // heavy facet opt-in
});

test('get throws on a missing or malformed id', async () => {
  await expectReject(() => getNode(db, 'MMR-999'));
  await expectReject(() => getNode(db, 'not-an-id'));
});

test('status_of returns label + distribution for a non-leaf', async () => {
  const t1 = await createTask(db, { parentId: phaseId, title: 't1' });
  await createTask(db, { parentId: phaseId, title: 't2' });
  await startTask(db, t1.id);

  const phase = await db
    .selectFrom('node')
    .select('seq')
    .where('id', '=', phaseId)
    .executeTakeFirstOrThrow();
  const status = await statusOfNode(db, `${key}-${String(phase.seq)}`);
  expect(status.status).toBe('in_progress');
  expect(status.distribution).toEqual({ in_progress: 1, ready: 1 });
});

// addressability (MMR-32): the full grammar on get/status

test('get on a bare KEY returns the whole-project view', async () => {
  const t = await createTask(db, { parentId: phaseId, title: 't' });
  await startTask(db, t.id);

  const view = await getNode(db, key);
  expect(view.id).toBe(key);
  expect(view.type).toBe('project');
  expect(view.title).toBe('m');
  expect(view.status).toBe('in_progress'); // interpret over the root initiative
  expect(view.children?.length).toBe(1); // the root initiative
  expect(view.distribution).toEqual({ in_progress: 1 });
});

test("status_of on a bare KEY rolls up the project's roots", async () => {
  const t = await createTask(db, { parentId: phaseId, title: 't' });
  await startTask(db, t.id);

  const status = await statusOfNode(db, key);
  expect(status.id).toBe(key);
  expect(status.status).toBe('in_progress');
  expect(status.distribution).toEqual({ in_progress: 1 });
});

test('get on KEY-aN returns the artifact detail with rendered links', async () => {
  const t = await createTask(db, { parentId: phaseId, title: 't' });
  const project = await db.selectFrom('project').select('id').executeTakeFirstOrThrow();
  const { renderedId } = await attachArtifact(db, {
    content: '# frozen\n',
    linkNodeIds: [t.id],
    projectId: project.id,
    title: 'frozen plan',
  });
  expect(renderedId).toBe(`${key}-a1`);

  const detail = await getArtifact(db, renderedId);
  expect(detail.id).toBe(`${key}-a1`);
  expect(detail.project).toBe(key);
  expect(detail.links).toEqual([idOf(t)]);
});

test('status_of rejects an artifact id as a behavioral error', async () => {
  await expectReject(() => statusOfNode(db, `${key}-a1`));
});

test('the node artifacts facet speaks KEY-aN', async () => {
  const t = await createTask(db, { parentId: phaseId, title: 't' });
  const project = await db.selectFrom('project').select('id').executeTakeFirstOrThrow();
  await attachArtifact(db, {
    content: 'x',
    linkNodeIds: [t.id],
    projectId: project.id,
    title: 'x',
  });

  const view = await getNode(db, idOf(t));
  expect(view.artifacts?.map((a) => a.id)).toEqual([`${key}-a1`]);

  const projectView = await getNode(db, key, { facets: ['artifacts'] });
  expect(projectView.artifacts?.map((a) => a.id)).toEqual([`${key}-a1`]);
});

test('list selects by status universe (MMR-33)', async () => {
  const a = await createTask(db, { parentId: phaseId, title: 'a' });
  const b = await createTask(db, { parentId: phaseId, title: 'b' });
  await blockTask(db, b.id, 'x');

  const blocked = await listNodes(db, { scope: key, status: 'blocked' });
  expect(blocked.items.map((n) => n.id)).toEqual([idOf(b)]);

  const ready = await listNodes(db, { scope: key, status: 'ready' });
  expect(ready.items.map((n) => n.id)).toEqual([idOf(a)]);

  const live = await listNodes(db, { scope: key });
  expect(live.total).toBe(2); // live is the default universe

  await completeTask(db, a.id);
  const terminal = await listNodes(db, { scope: key, status: 'terminal' });
  expect(terminal.items.map((n) => n.id)).toEqual([idOf(a)]);
  const all = await listNodes(db, { scope: key, status: 'all' });
  expect(all.total).toBe(2);
});

test('list filters by q — case-insensitive substring over title (MMR-78)', async () => {
  const auth = await createTask(db, { parentId: phaseId, title: 'Wire up AUTH gate' });
  await createTask(db, { parentId: phaseId, title: 'Polish the board' });

  const hit = await listNodes(db, { q: 'auth', scope: key });
  expect(hit.items.map((n) => n.id)).toEqual([idOf(auth)]);

  expect((await listNodes(db, { q: 'zzz', scope: key })).total).toBe(0);
  // an empty q is a no-op, not a match-nothing
  expect((await listNodes(db, { q: '', scope: key })).total).toBe(2);
});

test('list applies verdicts and field operators within the universe', async () => {
  const a = await createTask(db, { parentId: phaseId, priority: 'p1', title: 'a' });
  const b = await createTask(db, { parentId: phaseId, priority: 'p2', title: 'b' });
  await depend(db, b.id, [a.id]); // a blocks b

  const blocking = await listNodes(db, {
    scope: key,
    verdicts: [{ negate: false, verdict: 'blocking' }],
  });
  expect(blocking.items.map((n) => n.id)).toEqual([idOf(a)]);

  const notBlocking = await listNodes(db, {
    scope: key,
    verdicts: [{ negate: true, verdict: 'blocking' }],
  });
  expect(notBlocking.items.map((n) => n.id)).toEqual([idOf(b)]);

  const p2 = await listNodes(db, {
    filters: [{ field: 'priority', op: 'eq', value: 'p2' }],
    scope: key,
  });
  expect(p2.items.map((n) => n.id)).toEqual([idOf(b)]);
});

test('a value fault returns an empty set with warnings, not an error', async () => {
  await createTask(db, { parentId: phaseId, priority: 'p1', title: 'a' });
  const res = await listNodes(db, {
    filters: [{ field: 'priority', op: 'eq', value: 'p9' }],
    scope: key,
  });
  expect(res.total).toBe(0);
  expect(res.items).toEqual([]);
  expect(res.warnings?.[0]?.code).toBe('no_match_value');
  expect(res.warnings?.[0]?.expected).toEqual(['p0', 'p1', 'p2', 'p3']);
});

test('a type filter widens list beyond tasks', async () => {
  await createTask(db, { parentId: phaseId, title: 'a' });
  const phases = await listNodes(db, {
    filters: [{ field: 'type', op: 'eq', value: 'phase' }],
    scope: key,
  });
  expect(phases.items.map((n) => n.type)).toEqual(['phase']);
});

test('terminal universe orders by completed_at desc', async () => {
  const a = await createTask(db, { parentId: phaseId, title: 'a' });
  const b = await createTask(db, { parentId: phaseId, title: 'b' });
  await completeTask(db, a.id);
  await completeTask(db, b.id);
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
  const done = await listNodes(db, { scope: key, status: 'done' });
  expect(done.items.map((n) => n.id)).toEqual([idOf(b), idOf(a)]);
});

test("the tag pseudo-field filters via the node's tag set", async () => {
  const a = await createTask(db, { parentId: phaseId, tags: ['spec'], title: 'a' });
  await createTask(db, { parentId: phaseId, title: 'b' });
  const tagged = await listNodes(db, {
    filters: [{ field: 'tag', op: 'eq', value: 'spec' }],
    scope: key,
  });
  expect(tagged.items.map((n) => n.id)).toEqual([idOf(a)]);
  const untagged = await listNodes(db, {
    filters: [{ field: 'tag', op: 'missing', value: null }],
    scope: key,
  });
  expect(untagged.items.map((n) => n.title)).toEqual(['b']);
});
