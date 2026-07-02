import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb } from '../../db/testing';
import type { Db } from '../context';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { parseIdentity } from '../ids';
import { getArtifact } from '../intent';
import { loadNode, renderNodeId, resolveEntityToken } from '../lookup';
import { RANK_STEP } from '../rank';
import type { Store } from '../store';
import { createSqliteStore } from '../store-sqlite';
import { expectMimirError } from '../testing';
import {
  abandonTask,
  annotate,
  archiveProject,
  attachArtifact,
  blockTask,
  completeTask,
  depend,
  moveNode,
  parkTask,
  reorder,
  startTask,
  tagEntities,
  unblockTask,
  unparkTask,
  undepend,
  untagEntities,
  updateArtifact,
  updateNode,
  updateProject,
} from './index';

let db: Db;
let store: Store;
let projectId: number;
let initId: number;
let phaseId: number;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  projectId = p.id;
  const init = await createInitiative(store, { projectId, title: 'i' });
  initId = init.id;
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  phaseId = phase.id;
});
afterEach(async () => {
  await db.destroy();
});

async function task(title = 't'): Promise<number> {
  const t = await createTask(store, { parentId: phaseId, title });
  return t.id;
}
async function reload(id: number) {
  const node = await loadNode(db, id);
  if (node === undefined) {
    throw new Error(`node ${id} vanished`);
  }
  return node;
}
async function logs(nodeId: number) {
  return db
    .selectFrom('transition_log')
    .select(['kind', 'from_value', 'to_value', 'reason'])
    .where('node_id', '=', nodeId)
    .orderBy('id', 'asc')
    .execute();
}

test('start keeps rank and logs a lifecycle transition', async () => {
  const id = await task();
  const before = await reload(id);
  expect(before.rank).toBe(RANK_STEP);
  const echoed = await startTask(store, id);
  expect(echoed.lifecycle).toBe('in_progress');
  expect(echoed.rank).toBe(RANK_STEP); // todo->in_progress stays in the rankable set
  expect(await logs(id)).toEqual([
    { from_value: 'todo', kind: 'lifecycle', reason: null, to_value: 'in_progress' },
  ]);
  await expectMimirError('validation', () => startTask(store, id)); // not a todo anymore
});

test('complete is terminal: stamps completed_at and clears rank', async () => {
  const id = await task();
  await startTask(store, id);
  const done = await completeTask(store, id);
  expect(done.lifecycle).toBe('done');
  expect(done.completed_at).not.toBeNull();
  expect(done.rank).toBeNull();
  await expectMimirError('validation', () => completeTask(store, id)); // already terminal
});

test('abandon clears rank and records its reason on the log row', async () => {
  const id = await task();
  const gone = await abandonTask(store, id, 'scope cut');
  expect(gone.lifecycle).toBe('abandoned');
  expect(gone.rank).toBeNull();
  expect(gone.completed_at).toBeNull(); // only complete stamps it
  expect((await logs(id)).at(-1)).toEqual({
    from_value: 'todo',
    kind: 'lifecycle',
    reason: 'scope cut',
    to_value: 'abandoned',
  });
});

test('park/unpark and block/unblock leave and re-enter the rankable set', async () => {
  const id = await task();
  const parked = await parkTask(store, id, 'later');
  expect(parked.hold).toBe('parked');
  expect(parked.hold_reason).toBe('later');
  expect(parked.rank).toBeNull();
  await expectMimirError('validation', () => parkTask(store, id)); // already held

  const unparked = await unparkTask(store, id);
  expect(unparked.hold).toBe('none');
  expect(unparked.hold_reason).toBeNull();
  expect(unparked.rank).toBe(RANK_STEP); // re-appended to bottom (only task)

  const blocked = await blockTask(store, id, 'waiting on API');
  expect(blocked.hold).toBe('blocked');
  expect(blocked.rank).toBeNull();
  const unblocked = await unblockTask(store, id);
  expect(unblocked.hold).toBe('none');
  expect(unblocked.rank).toBe(RANK_STEP);

  expect((await logs(id)).map((l) => `${String(l.from_value)}>${String(l.to_value)}`)).toEqual([
    'none>parked',
    'parked>none',
    'none>blocked',
    'blocked>none',
  ]);
});

test('depend builds acyclic edges and rejects cycles and self-deps', async () => {
  const a = await task('a');
  const b = await task('b');
  const c = await task('c');
  await depend(store, b, [a]); // b depends on a
  await depend(store, c, [b]); // c depends on b
  await expectMimirError('validation', () => depend(store, a, [c])); // a->c would close a->c->b->a
  await expectMimirError('validation', () => depend(store, a, [a])); // self

  const edges = await db.selectFrom('dependency').selectAll().where('node_id', '=', b).execute();
  expect(edges).toHaveLength(1);
  expect((await logs(b)).at(-1)?.kind).toBe('dependency');

  await undepend(store, b, [a]);
  expect(
    await db.selectFrom('dependency').selectAll().where('node_id', '=', b).execute(),
  ).toHaveLength(0);
});

test('depend rejects same-lineage edges (ancestor/descendant) and allows cross-lineage', async () => {
  const t = await task('t'); // under phaseId → initId → project
  // depend on your own descendant: the phase would await a task it contains
  await expectMimirError('validation', () => depend(store, phaseId, [t]));
  // depend on your own ancestor (parent phase, and grandparent initiative)
  await expectMimirError('validation', () => depend(store, t, [phaseId]));
  await expectMimirError('validation', () => depend(store, t, [initId]));

  // a sibling branch is fine — neither node contains the other
  const phase2 = await createPhase(store, { parentId: initId, title: 'ph2' });
  const t2 = await createTask(store, { parentId: phase2.id, title: 't2' });
  await depend(store, t, [t2.id]); // task → task in another phase
  await depend(store, phaseId, [phase2.id]); // sibling phase → sibling phase
  expect(
    await db.selectFrom('dependency').selectAll().where('node_id', '=', t).execute(),
  ).toHaveLength(1);
});

test('depend rejects an edge that closes a derivation cycle through container rollups', async () => {
  // task b under initiative A (via phaseId); initiative C with task d
  const b = await task('b');
  const initC = await createInitiative(store, { projectId, title: 'C' });
  const d = await createTask(store, { parentId: initC.id, title: 'd' });
  await depend(store, b, [initC.id]); // b awaits C's rollup — fine on its own

  // d → A closes the loop: word(b) ← settled(C) ← word(d) ← settled(A) ← word(b)
  await expectMimirError('validation', () => depend(store, d.id, [initId]));
  expect(
    await db.selectFrom('dependency').selectAll().where('node_id', '=', d.id).execute(),
  ).toHaveLength(0);
});

test('depend rejects a multi-hop derivation cycle across three containers', async () => {
  const b = await task('b'); // under A (initId)
  const initC = await createInitiative(store, { projectId, title: 'C' });
  const d = await createTask(store, { parentId: initC.id, title: 'd' });
  const initE = await createInitiative(store, { projectId, title: 'E' });
  const f = await createTask(store, { parentId: initE.id, title: 'f' });
  await depend(store, b, [initC.id]); // A's task awaits C
  await depend(store, d.id, [initE.id]); // C's task awaits E

  // E's task awaiting A closes the three-container loop
  await expectMimirError('validation', () => depend(store, f.id, [initId]));
});

test('move is rejected when re-parenting closes a derivation cycle', async () => {
  const b = await task('b'); // under A (initId)
  const initC = await createInitiative(store, { projectId, title: 'C' });
  const initE = await createInitiative(store, { projectId, title: 'E' });
  const d = await createTask(store, { parentId: initE.id, title: 'd' });
  await depend(store, b, [initC.id]); // b awaits C
  await depend(store, d.id, [initId]); // d awaits A — acyclic while d lives in E

  // moving d into C makes C's rollup depend on d → the loop closes
  await expectMimirError('validation', () => moveNode(store, d.id, initC.id));
  expect((await reload(d.id)).parent_id).toBe(initE.id);

  // a neutral destination still works
  const initN = await createInitiative(store, { projectId, title: 'N' });
  const moved = await moveNode(store, d.id, initN.id);
  expect(moved.parent_id).toBe(initN.id);
});

test('a pre-existing derivation cycle in legacy data does not reject unrelated writes', async () => {
  // raw-write a container cycle the guards would now refuse (pre-guard data)
  const initX = await createInitiative(store, { projectId, title: 'X' });
  const x = await createTask(store, { parentId: initX.id, title: 'x' });
  const initY = await createInitiative(store, { projectId, title: 'Y' });
  const y = await createTask(store, { parentId: initY.id, title: 'y' });
  await db
    .insertInto('dependency')
    .values([
      { depends_on_node_id: initY.id, node_id: x.id },
      { depends_on_node_id: initX.id, node_id: y.id },
    ])
    .execute();

  // an unrelated depend-on-container and an unrelated move both still work
  const initP = await createInitiative(store, { projectId, title: 'P' });
  const p = await createTask(store, { parentId: initP.id, title: 'p' });
  const initQ = await createInitiative(store, { projectId, title: 'Q' });
  await depend(store, p.id, [initQ.id]);
  const moved = await moveNode(store, p.id, initX.id);
  expect(moved.parent_id).toBe(initX.id);
});

test('move rejects a loop threaded through an archived project (dormant until unarchive)', async () => {
  // live shape, acyclic: b under N awaits C (project P2); d under C awaits A
  const initN = await createInitiative(store, { projectId, title: 'N' });
  const b = await createTask(store, { parentId: initN.id, title: 'b' });
  const p2 = await createProject(store, { key: 'PTW', name: 'p2' });
  const initC = await createInitiative(store, { projectId: p2.id, title: 'C' });
  const d = await createTask(store, { parentId: initC.id, title: 'd' });
  await depend(store, b.id, [initC.id]);
  await depend(store, d.id, [initId]);

  // archived, C reads as settled at runtime — but moving b under A would close
  // the loop the moment P2 is unarchived, so the guard counts it as real
  await archiveProject(store, p2.id);
  await expectMimirError('validation', () => moveNode(store, b.id, initId));
  expect((await reload(b.id)).parent_id).toBe(initN.id);
});

test('move is rejected when it would create a same-lineage dependency edge', async () => {
  const phase2 = await createPhase(store, { parentId: initId, title: 'ph2' });
  const a = await task('a'); // under phaseId
  await depend(store, a, [phase2.id]); // cross-lineage at depend-time → allowed

  // moving a under phase2 would make a depend on its own (new) ancestor → reject
  await expectMimirError('validation', () => moveNode(store, a, phase2.id));
  // the edge and parent are untouched
  expect((await reload(a)).parent_id).toBe(phaseId);

  // a benign move to a sibling with no conflicting edge still works
  const phase3 = await createPhase(store, { parentId: initId, title: 'ph3' });
  await moveNode(store, a, phase3.id);
  expect((await reload(a)).parent_id).toBe(phase3.id);
});

test('move lineage guard covers the moved subtree, not just the moved node', async () => {
  const init2 = await createInitiative(store, { projectId, title: 'i2' });
  const child = await task('child'); // under phaseId, which is under initId
  await depend(store, child, [init2.id]); // child depends on init2 (cross-lineage)

  // moving phaseId under init2 makes child a descendant of init2 it depends on → reject
  await expectMimirError('validation', () => moveNode(store, phaseId, init2.id));
});

test('move re-parents with type + cycle validation', async () => {
  const phase2 = await createPhase(store, { parentId: initId, title: 'ph2' });
  const t = await task('t');
  const moved = await moveNode(store, t, phase2.id);
  expect(moved.parent_id).toBe(phase2.id);
  expect((await logs(t)).at(-1)?.kind).toBe('move');

  // a task cannot parent to another task
  const other = await task('other');
  await expectMimirError('validation', () => moveNode(store, t, other));
  // a phase cannot move under its own descendant task... use node cycle: move init under its phase
  await expectMimirError('validation', () => moveNode(store, initId, phaseId));
  // an initiative may go top-level
  const reparented = await moveNode(store, initId, null);
  expect(reparented.parent_id).toBeNull();
});

test('update is a dumb scalar patch with type-applicability checks', async () => {
  const id = await task();
  const patched = await updateNode(store, id, { priority: 'p0', title: 'renamed' });
  expect(patched.title).toBe('renamed');
  expect(patched.priority).toBe('p0');

  // target is phase-only; priority is task-only
  await expectMimirError('validation', () => updateNode(store, id, { target: 'x' }));
  await expectMimirError('validation', () => updateNode(store, phaseId, { priority: 'p1' }));

  // status is not reachable through update (lifecycle unchanged)
  expect((await reload(id)).lifecycle).toBe('todo');
});

test('annotate and attachArtifact persist and link', async () => {
  const id = await task();
  await annotate(store, id, 'realized X');
  const notes = await db.selectFrom('annotation').selectAll().where('node_id', '=', id).execute();
  expect(notes.map((n) => n.content)).toEqual(['realized X']);

  const { renderedId } = await attachArtifact(store, {
    content: '# session log',
    linkNodeIds: [id],
    projectId,
    title: 'session log',
  });
  const detail = await getArtifact(store, renderedId);
  const stem = await renderNodeId(db, id);
  expect(detail.links).toEqual(stem === null ? [] : [stem]);
});

test('tag/untag an artifact route through the seam by external identity (MMR-143)', async () => {
  const { renderedId } = await attachArtifact(store, {
    content: 'x',
    projectId,
    title: 'doc',
  });
  // The verb path: resolve the token, then tag — an artifact target carries
  // (key, seq), not a numeric id, so it survives a backend with no SQLite row.
  const target = await resolveEntityToken(db, renderedId);
  expect(target.entityType).toBe('artifact');
  await tagEntities(store, [target], ['urgent']);
  expect((await getArtifact(store, renderedId)).tags).toEqual(['urgent']);

  const removed = await untagEntities(store, [target], ['urgent', 'absent']);
  expect(removed).toBe(1);
  expect((await getArtifact(store, renderedId)).tags).toEqual([]);
});

test('updateArtifact retitles; content frozen; blank title and unknown id refused (MMR-40)', async () => {
  const id = await task();
  const { renderedId } = await attachArtifact(store, {
    content: '# body',
    linkNodeIds: [id],
    projectId,
    title: 'first title',
  });
  const parsed = parseIdentity(renderedId);
  if (parsed?.kind !== 'artifact') {
    throw new Error('expected an artifact id');
  }
  const ref = { key: parsed.key, seq: parsed.seq };
  await updateArtifact(store, ref, { title: 'fixed title' });
  const row = await db
    .selectFrom('artifact')
    .innerJoin('project', 'project.id', 'artifact.project_id')
    .select(['artifact.title as title', 'artifact.content as content'])
    .where('project.key', '=', ref.key)
    .where('artifact.seq', '=', ref.seq)
    .executeTakeFirstOrThrow();
  expect(row.title).toBe('fixed title');
  expect(row.content).toBe('# body'); // content is never touched
  await expectMimirError('validation', () => updateArtifact(store, ref, { title: '  ' }));
  await expectMimirError('not_found', () =>
    updateArtifact(store, { key: 'MMR', seq: 9999 }, { title: 'x' }),
  );
});

test('updateProject patches name and description; key is immutable (MMR-88)', async () => {
  const updated = await updateProject(store, projectId, {
    description: 'details',
    name: 'New Name',
  });
  expect(updated.name).toBe('New Name');
  expect(updated.description).toBe('details');

  // Patch only description — name untouched
  const again = await updateProject(store, projectId, { description: 'updated desc' });
  expect(again.name).toBe('New Name');
  expect(again.description).toBe('updated desc');

  // Clear description with explicit null
  const cleared = await updateProject(store, projectId, { description: null });
  expect(cleared.description).toBeNull();

  // Blank name is rejected
  await expectMimirError('validation', () => updateProject(store, projectId, { name: '  ' }));

  // Missing project
  await expectMimirError('not_found', () => updateProject(store, 9999, { name: 'x' }));
});

test('reorder moves within the rankable set and refuses terminal/held tasks', async () => {
  const a = await task('a');
  const b = await task('b');
  await reorder(store, b, 'top');
  const ranked = await db
    .selectFrom('node')
    .select('id')
    .where('project_id', '=', projectId)
    .where('rank', 'is not', null)
    .orderBy('rank', 'asc')
    .execute();
  expect(ranked.map((r) => r.id)).toEqual([b, a]);

  await completeTask(store, a);
  await expectMimirError('validation', () => reorder(store, a, 'top')); // terminal -> no rank
});
