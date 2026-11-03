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

// No verb leaves a reason on an unheld open task, and the import refuses one
// rather than dropping it (MMR-621). Each case first parses the open task
// without the reason, so the refusal is the reason's alone; a queued task
// carries the session a reservation requires.
test.each(['todo', 'queued', 'in_progress', 'under_review'] as const)(
  'an open %s task with no hold and a reason is refused: only terminal tasks are normalized',
  (lifecycle) => {
    const input = structuredClone(document);
    const task = input.nodes.find(
      (node) =>
        node.type === 'task' &&
        node.hold === 'none' &&
        node.lifecycle !== 'done' &&
        node.lifecycle !== 'abandoned',
    );
    if (task === undefined) {
      throw new Error('the fixture has no open unheld task');
    }
    task.lifecycle = lifecycle;
    if (lifecycle === 'queued') {
      task.session = 'smoke-session';
    }
    expect(() => parseTransferDocument(input)).not.toThrow();
    task.hold_reason = 'stray';
    expect(() => parseTransferDocument(input)).toThrow(
      `node ${task.id}.hold_reason must be null while the hold is none`,
    );
  },
);
