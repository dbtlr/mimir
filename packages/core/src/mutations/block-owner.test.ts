import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from '../create';
import { createSqliteTestStore } from '../store-sqlite/testing';
import type { SqliteTestStore } from '../store-sqlite/testing';
import { expectMimirError } from '../testing/errors';
import { nodeIdOf, projectIdOf } from '../testing/store';
import { blockTask, completeTask, parkTask, unblockTask, unparkTask, updateNode } from './index';

/**
 * A `blocked` hold records who can clear it (ADR 0001, MMR-438): `you` or
 * `others`. The owner is set only while the hold is `blocked` and NULL
 * otherwise, whichever path wrote the hold.
 */

let fixture: SqliteTestStore;
let phaseId: string;

beforeEach(async () => {
  fixture = await createSqliteTestStore();
  const { store } = fixture;
  await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, 'MMR'),
    title: 'i',
  });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
    title: 'ph',
  });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
});
afterEach(async () => {
  await fixture.close();
});

async function task(upstream?: string): Promise<string> {
  const created = await createTask(fixture.store, { parentId: phaseId, title: 't', upstream });
  return nodeIdOf(fixture.store, `MMR-${String(created.seq)}`);
}
async function reload(id: string) {
  const node = await fixture.store.transact((w) => w.loadNode(id));
  if (node === undefined) {
    throw new Error(`node ${id} vanished`);
  }
  return node;
}
/** The owner exactly as stored, bypassing the read normalization. */
async function stored(id: string): Promise<string | null> {
  const row = await fixture.db
    .selectFrom('node')
    .select('block_owner')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.block_owner;
}

test('block defaults the owner to you without an upstream, and others with one', async () => {
  const plain = await task();
  const asked = await task('OPS-s4');
  expect((await blockTask(fixture.store, plain)).block_owner).toBe('you');
  expect((await blockTask(fixture.store, asked)).block_owner).toBe('others');
});

test('the default is evaluated when the block is placed, not when the task was created', async () => {
  const id = await task();
  await updateNode(fixture.store, id, { upstream: 'OPS-s4' });
  expect((await blockTask(fixture.store, id)).block_owner).toBe('others');
});

test('a stated owner wins over the default, either way', async () => {
  const plain = await task();
  const asked = await task('OPS-s4');
  expect((await blockTask(fixture.store, plain, 'vendor', 'others')).block_owner).toBe('others');
  expect((await blockTask(fixture.store, asked, 'my call', 'you')).block_owner).toBe('you');
  expect(await stored(plain)).toBe('others');
  expect(await stored(asked)).toBe('you');
});

test('unblock clears the owner, and a re-block takes the new one', async () => {
  const id = await task();
  await blockTask(fixture.store, id, undefined, 'you');
  const released = await unblockTask(fixture.store, id);
  expect(released.block_owner).toBeNull();
  expect(await stored(id)).toBeNull();
  expect((await blockTask(fixture.store, id, undefined, 'others')).block_owner).toBe('others');
});

test('a held task cannot be re-blocked to change its owner: unblock, then block', async () => {
  const id = await task();
  await blockTask(fixture.store, id, undefined, 'you');
  await expectMimirError('validation', () => blockTask(fixture.store, id, undefined, 'others'));
  expect((await reload(id)).block_owner).toBe('you');
  const parked = await task();
  await parkTask(fixture.store, parked);
  await expectMimirError('validation', () => blockTask(fixture.store, parked, undefined, 'you'));
});

test('park and unpark never carry an owner', async () => {
  const id = await task('OPS-s4');
  const parked = await parkTask(fixture.store, id, 'later');
  expect(parked.block_owner).toBeNull();
  expect(await stored(id)).toBeNull();
  expect((await unparkTask(fixture.store, id)).block_owner).toBeNull();
});

test('a terminal transition leaves the hold, and so the owner, as it was', async () => {
  const id = await task();
  await blockTask(fixture.store, id, undefined, 'others');
  const done = await completeTask(fixture.store, id);
  expect(done.hold).toBe('blocked');
  expect(done.block_owner).toBe('others');
});

test('a row written by an older binary reads by the rule: blocked with no owner derives it', async () => {
  const plain = await task();
  const asked = await task('OPS-s4');
  for (const id of [plain, asked]) {
    await blockTask(fixture.store, id);
    await fixture.db.updateTable('node').set({ block_owner: null }).where('id', '=', id).execute();
  }
  expect((await reload(plain)).block_owner).toBe('you');
  expect((await reload(asked)).block_owner).toBe('others');
});

test('a row written by an older binary reads empty when the hold is not blocked, whatever the column holds', async () => {
  // The older binary's unblock/park left the stale owner behind.
  const unheld = await task();
  const parked = await task();
  await parkTask(fixture.store, parked);
  for (const id of [unheld, parked]) {
    await fixture.db.updateTable('node').set({ block_owner: 'you' }).where('id', '=', id).execute();
    expect((await reload(id)).block_owner).toBeNull();
  }
});

test('containers carry no owner', async () => {
  expect((await reload(phaseId)).block_owner).toBeNull();
});
