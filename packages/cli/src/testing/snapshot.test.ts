import { expect, test } from 'bun:test';

import type { LocalEngine } from '@mimir/core';

import { changedRecords } from './pins';
import { boardSnapshot } from './snapshot';
import { openBoard } from './writes';

/** The records `write` changed on a populated board, read the way a write case pins them. */
async function changesOf(write: (engine: LocalEngine) => Promise<unknown>): Promise<string> {
  const open = await openBoard();
  try {
    const before = await boardSnapshot(open.board, open.tokens);
    await write(open.board.engine);
    return changedRecords(before, await boardSnapshot(open.board, open.tokens));
  } finally {
    await open.close();
  }
}

test('a write pins the stored fields it changed, not the rollups core derives from them', async () => {
  // MMR-3 counts in its phase's distribution and the project's leaf counts, and MMR-4 depends on it.
  expect(await changesOf((engine) => engine.start({ id: 'MMR-3' }))).toBe(
    [
      '+ nodes[MMR-3].history[@0]: {"at":"2026-10-01T12:00:00.000Z","from":"todo","kind":"lifecycle","reason":null,"to":"in_progress"}',
      '~ nodes[MMR-3].lifecycle: "todo" -> "in_progress"',
      '',
    ].join('\n'),
  );
});

test('a write that touches a record other than its subject still shows', async () => {
  const changes = await changesOf(async (engine) => {
    await engine.update({ id: 'MMR-3', priority: 'p0' });
    await engine.update({ id: 'XX-3', title: 'Not ours either' });
  });
  expect(changes).toContain('~ nodes[MMR-3].priority: "p1" -> "p0"');
  expect(changes).toContain('~ nodes[XX-3].title: "Not ours" -> "Not ours either"');
});

test('a dependency is pinned on its dependent as the prerequisite id alone', async () => {
  const changes = await changesOf((engine) => engine.depend({ id: 'MMR-6', on: ['MMR-3'] }));
  expect(changes).toContain('+ nodes[MMR-6].deps.dependsOn[MMR-3]: {"id":"MMR-3"}\n');
  // MMR-3's blocking set is the same edge read from the other end.
  expect(changes).not.toContain('nodes[MMR-3]');
});

test('a record in a project the write archived still shows as stored', async () => {
  const changes = await changesOf(async (engine) => {
    await engine.park({ id: 'XX-3', reason: 'archived with its project' });
    await engine.archive({ id: 'XX' });
  });
  expect(changes).toContain('~ nodes[XX-3].hold: "none" -> "parked"');
  // Archiving hides the project's records from reads; the store still holds them.
  expect(changes).not.toContain('failed');
});
