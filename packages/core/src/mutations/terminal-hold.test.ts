import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from '../create';
import { createSqliteTestStore } from '../store-sqlite/testing';
import type { SqliteTestStore } from '../store-sqlite/testing';
import { nodeIdOf, projectIdOf } from '../testing/store';
import { abandonTask, blockTask, completeTask, parkTask, reopenTask, startTask } from './index';

/**
 * A terminal task has no hold (MMR-616): `done` and `abandon` release a
 * `blocked` or `parked` hold in the same write, so a finished task never reads
 * as held and a reopen never revives the stale hold. The hold's history stays
 * on its own transition-log row.
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

/** A started task under the named hold. */
async function heldTask(hold: 'blocked' | 'parked'): Promise<string> {
  const created = await createTask(fixture.store, { parentId: phaseId, title: 't' });
  const id = await nodeIdOf(fixture.store, `MMR-${String(created.seq)}`);
  await startTask(fixture.store, id);
  if (hold === 'blocked') {
    await blockTask(fixture.store, id, 'waiting on the vendor', 'others');
  } else {
    await parkTask(fixture.store, id, 'later');
  }
  return id;
}

/** The hold columns exactly as stored, bypassing the read normalization. */
async function storedHold(id: string) {
  return fixture.db
    .selectFrom('node')
    .select(['hold', 'hold_reason', 'block_owner'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

const released = { block_owner: null, hold: 'none', hold_reason: null } as const;

const terminalVerbs = [
  { run: (id: string) => completeTask(fixture.store, id), verb: 'done' },
  { run: (id: string) => abandonTask(fixture.store, id, 'dropped'), verb: 'abandon' },
];
const cases = terminalVerbs.flatMap(({ run, verb }) =>
  (['blocked', 'parked'] as const).map((hold) => ({ hold, run, verb })),
);

test.each(cases)(
  '$verb on a $hold task releases the hold, its reason, and its owner',
  async ({ hold, run }) => {
    const id = await heldTask(hold);
    const node = await run(id);
    expect({
      block_owner: node.block_owner,
      hold: node.hold,
      hold_reason: node.hold_reason,
    }).toEqual(released);
    expect(await storedHold(id)).toEqual(released);
  },
);

test.each(cases)(
  'reopening a $hold task closed by $verb yields an unheld in_progress task',
  async ({ hold, run }) => {
    const id = await heldTask(hold);
    await run(id);
    const reopened = await reopenTask(fixture.store, id, 'not finished');
    expect(reopened.lifecycle).toBe('in_progress');
    expect(reopened.hold).toBe('none');
    expect(reopened.block_owner).toBeNull();
    expect(reopened.rank).not.toBeNull();
  },
);

test('the hold keeps its history: the block row stays, and the terminal verb adds no hold row', async () => {
  const id = await heldTask('blocked');
  await completeTask(fixture.store, id);
  const rows = await fixture.db
    .selectFrom('transition_log')
    .select(['kind', 'from_value', 'to_value'])
    .where('node_id', '=', id)
    .orderBy('id')
    .execute();
  expect(rows.filter((row) => row.kind === 'hold')).toEqual([
    { from_value: 'none', kind: 'hold', to_value: 'blocked' },
  ]);
  expect(rows.at(-1)).toEqual({ from_value: 'in_progress', kind: 'lifecycle', to_value: 'done' });
});
