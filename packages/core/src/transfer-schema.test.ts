import { beforeAll, expect, test } from 'bun:test';

import type { StoreExport } from './export';
import { createSqliteTestStore } from './store-sqlite/testing';
import { seedWorkingSet } from './testing/conformance';
import { parseTransferDocument } from './transfer-validate';

/**
 * The import parse releases the hold an older binary's terminal verbs left on a
 * done or abandoned task (MMR-616). This reads the parsed document itself: an
 * export cannot show the stored value, because the read path also reads a
 * terminal row as unheld.
 */

let document: StoreExport;

beforeAll(async () => {
  const fixture = await createSqliteTestStore();
  try {
    await seedWorkingSet(fixture.store);
    document = await fixture.store.export();
  } finally {
    await fixture.close();
  }
});

/** The fixture's blocked task, closed and held as the given residue. */
function residue(
  lifecycle: 'done' | 'abandoned',
  hold: 'blocked' | 'parked',
): { id: string; input: StoreExport } {
  const input = structuredClone(document);
  const task = input.nodes.find((node) => node.type === 'task' && node.hold === 'blocked');
  if (task === undefined) {
    throw new Error('the fixture has no blocked task');
  }
  Object.assign(task, {
    block_owner: hold === 'blocked' ? 'you' : null,
    completed_at: '2026-09-03T00:00:00.000Z',
    hold,
    hold_reason: 'left behind',
    lifecycle,
    rank: null,
  });
  return { id: task.id, input };
}

const cases = (['done', 'abandoned'] as const).flatMap((lifecycle) =>
  (['blocked', 'parked'] as const).map((hold) => ({ hold, lifecycle })),
);

test.each(cases)('a $lifecycle task left $hold parses unheld', ({ hold, lifecycle }) => {
  const { id, input } = residue(lifecycle, hold);
  const parsed = parseTransferDocument(input).nodes.find((node) => node.id === id);
  expect(parsed).toMatchObject({ block_owner: null, hold: 'none', hold_reason: null, lifecycle });
});

test('a live hold parses as it was', () => {
  const parsed = parseTransferDocument(structuredClone(document)).nodes.find(
    (node) => node.hold === 'blocked',
  );
  expect(parsed).toMatchObject({ block_owner: 'others', hold_reason: 'waiting on the vendor' });
});

test.each(['done', 'abandoned'] as const)(
  'a %s task with no hold drops a stray reason, as migration 0011 does',
  (lifecycle) => {
    const { id, input } = residue(lifecycle, 'blocked');
    const task = input.nodes.find((node) => node.id === id);
    Object.assign(task ?? {}, { block_owner: null, hold: 'none', hold_reason: 'stray' });
    const parsed = parseTransferDocument(input).nodes.find((node) => node.id === id);
    expect(parsed).toMatchObject({ block_owner: null, hold: 'none', hold_reason: null });
  },
);

test('a live unheld task keeps its stored reason: only terminal tasks are normalized', () => {
  const input = structuredClone(document);
  const task = input.nodes.find((node) => node.type === 'task' && node.hold === 'none');
  if (task === undefined) {
    throw new Error('the fixture has no unheld task');
  }
  task.hold_reason = 'stray';
  const parsed = parseTransferDocument(input).nodes.find((node) => node.id === task.id);
  expect(parsed?.hold_reason).toBe('stray');
});
