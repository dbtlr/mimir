import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Hold, Lifecycle } from '@mimir/contract';

import { createTestDb } from '../db/testing';
import { attentionOf } from './attention';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';

/**
 * MMR-101 — the derived project attention-state. Bands resolve highest-wins over
 * a project's leaf tasks; `stale` is a modifier; `lastActivity` is the recency
 * floor the consumer (MMR-102) sorts within a band.
 */

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.destroy();
});

async function patch(id: number, fields: { lifecycle?: Lifecycle; hold?: Hold }): Promise<void> {
  await db.updateTable('node').set(fields).where('id', '=', id).execute();
}
async function touch(id: number, at: string): Promise<void> {
  await db.updateTable('node').set({ updated_at: at }).where('id', '=', id).execute();
}
async function dep(nodeId: number, dependsOn: number): Promise<void> {
  await db
    .insertInto('dependency')
    .values({ depends_on_node_id: dependsOn, node_id: nodeId })
    .execute();
}

/** A project with one empty phase ready to hang tasks under. */
async function fixture(key = 'MMR') {
  const p = await createProject(db, { key, name: 'm' });
  const init = await createInitiative(db, { projectId: p.id, title: 'i' });
  const phase = await createPhase(db, { parentId: init.id, title: 'ph' });
  return { p, phase };
}

test('an empty project (no leaf tasks) is at_rest, recency falling back to the project itself', async () => {
  const { p } = await fixture();
  const a = await attentionOf(db, p);
  expect(a.band).toBe('at_rest');
  expect(a.stale).toBe(false);
  expect(a.lastActivity).toBe(p.updated_at);
});

test('a project whose only live signal is under_review lands in awaiting_you', async () => {
  const { p, phase } = await fixture();
  const t = await createTask(db, { parentId: phase.id, title: 't' });
  await patch(t.id, { lifecycle: 'under_review' });
  expect((await attentionOf(db, p)).band).toBe('awaiting_you');
});

test('in_progress and ready leaves both read as live', async () => {
  const { p, phase } = await fixture();
  const running = await createTask(db, { parentId: phase.id, title: 'running' });
  await patch(running.id, { lifecycle: 'in_progress' });
  expect((await attentionOf(db, p)).band).toBe('live');

  const { p: p2, phase: ph2 } = await fixture('RDY');
  await createTask(db, { parentId: ph2.id, title: 'fresh' }); // todo + none, no deps → ready
  expect((await attentionOf(db, p2)).band).toBe('live');
});

test('blocked and awaiting leaves both read as needs_unsticking', async () => {
  const { p, phase } = await fixture();
  const stuck = await createTask(db, { parentId: phase.id, title: 'stuck' });
  await patch(stuck.id, { hold: 'blocked' });
  expect((await attentionOf(db, p)).band).toBe('needs_unsticking');

  const { p: p2, phase: ph2 } = await fixture('AWT');
  const prereq = await createTask(db, { parentId: ph2.id, title: 'prereq' });
  const dependent = await createTask(db, { parentId: ph2.id, title: 'dependent' });
  await dep(dependent.id, prereq.id); // prereq unsettled → dependent awaits
  await patch(prereq.id, { hold: 'parked' }); // park the prereq so the project's top band is the awaiting leaf
  expect((await attentionOf(db, p2)).band).toBe('needs_unsticking');
});

test('a project of only parked/terminal leaves is at_rest', async () => {
  const { p, phase } = await fixture();
  const parked = await createTask(db, { parentId: phase.id, title: 'parked' });
  await patch(parked.id, { hold: 'parked' });
  const done = await createTask(db, { parentId: phase.id, title: 'done' });
  await patch(done.id, { lifecycle: 'done' });
  const gone = await createTask(db, { parentId: phase.id, title: 'gone' });
  await patch(gone.id, { lifecycle: 'abandoned' });
  const a = await attentionOf(db, p);
  expect(a.band).toBe('at_rest');
  expect(a.stale).toBe(false);
});

test('the highest band wins when leaves span several bands', async () => {
  const { p, phase } = await fixture();
  const review = await createTask(db, { parentId: phase.id, title: 'review' });
  await patch(review.id, { lifecycle: 'under_review' });
  await createTask(db, { parentId: phase.id, title: 'ready' }); // live
  const blocked = await createTask(db, { parentId: phase.id, title: 'blocked' });
  await patch(blocked.id, { hold: 'blocked' }); // needs_unsticking

  // awaiting_you (under_review) outranks live and needs_unsticking
  expect((await attentionOf(db, p)).band).toBe('awaiting_you');

  // drop the review to done → highest remaining is live (the ready leaf)
  await patch(review.id, { lifecycle: 'done' });
  expect((await attentionOf(db, p)).band).toBe('live');
});

test('highest-wins is independent of scan order — the winning leaf created last still wins', async () => {
  const { p, phase } = await fixture();
  // lower bands first, the awaiting_you leaf created last (so it scans last)
  const blocked = await createTask(db, { parentId: phase.id, title: 'blocked' });
  await patch(blocked.id, { hold: 'blocked' }); // needs_unsticking
  await createTask(db, { parentId: phase.id, title: 'ready' }); // live
  const review = await createTask(db, { parentId: phase.id, title: 'review' });
  await patch(review.id, { lifecycle: 'under_review' }); // awaiting_you, created last
  expect((await attentionOf(db, p)).band).toBe('awaiting_you');
});

test('stale is a modifier that decorates the live band, not a band of its own', async () => {
  const { p, phase } = await fixture();
  const t = await createTask(db, { parentId: phase.id, title: 't' });
  await patch(t.id, { lifecycle: 'in_progress' });
  await touch(t.id, '2000-01-01T00:00:00.000Z'); // ancient
  const asOf = '2026-06-05T00:00:00.000Z';

  const a = await attentionOf(db, p, { asOf });
  expect(a.band).toBe('live'); // still its real band
  expect(a.stale).toBe(true); // going cold rides on top

  // a fresh in_progress leaf is not stale
  await touch(t.id, asOf);
  expect((await attentionOf(db, p, { asOf })).stale).toBe(false);
});

test("lastActivity is the max updated_at across the project's leaf tasks", async () => {
  const { p, phase } = await fixture();
  const older = await createTask(db, { parentId: phase.id, title: 'older' });
  const newer = await createTask(db, { parentId: phase.id, title: 'newer' });
  await touch(older.id, '2026-01-01T00:00:00.000Z');
  await touch(newer.id, '2026-06-20T12:00:00.000Z');
  expect((await attentionOf(db, p)).lastActivity).toBe('2026-06-20T12:00:00.000Z');
});
