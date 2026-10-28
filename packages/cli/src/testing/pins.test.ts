import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedRecords, quoted } from './pins';
import { boardSnapshot } from './snapshot';
import { openBoard } from './writes';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** The records a priority change to `id` touched, read the way a write case pins them. */
async function priorityChange(id: string): Promise<string> {
  const before = await openBoard();
  const after = await openBoard();
  try {
    await after.board.engine.update({ id, priority: 'p0' });
    return changedRecords(
      await boardSnapshot(before.board, before.tokens, [id]),
      await boardSnapshot(after.board, after.tokens, [id]),
    );
  } finally {
    await before.close();
    await after.close();
  }
}

test('a change to MMR-3 and the same change to MMR-4 pin differently', async () => {
  const three = await priorityChange('MMR-3');
  const four = await priorityChange('MMR-4');
  expect(three).toContain('MMR-3');
  expect(four).toContain('MMR-4');
  expect(three).not.toBe(four);
});

test('a changed field is pinned by record and path with its old and new value', () => {
  const before = JSON.stringify({ board: { MMR: { nodes: [{ id: 'MMR-3', priority: 'p1' }] } } });
  const after = JSON.stringify({ board: { MMR: { nodes: [{ id: 'MMR-3', priority: 'p0' }] } } });
  expect(changedRecords(before, after)).toBe('~ board.MMR.nodes[MMR-3].priority: "p1" -> "p0"\n');
});

test('a created record is pinned whole and a removed one is marked', () => {
  const before = JSON.stringify({ seeds: { MMR: [{ id: 'MMR-s1', title: 'a' }] } });
  const after = JSON.stringify({ seeds: { MMR: [{ id: 'MMR-s2', title: 'b' }] } });
  expect(changedRecords(before, after)).toBe(
    '- seeds.MMR[MMR-s1]: {"id":"MMR-s1","title":"a"}\n+ seeds.MMR[MMR-s2]: {"id":"MMR-s2","title":"b"}\n',
  );
});

test('equal states pin no change', () => {
  expect(changedRecords('{"a":[1]}', '{"a":[1]}')).toBe('');
});

test('real ANSI bytes and the printable text of them pin differently', () => {
  expect(quoted('\u001B[32mok\n')).not.toBe(quoted('␛[32mok\n'));
  expect(quoted('⟦1b⟧\n')).not.toBe(quoted('\u001B\n'));
  expect(quoted('\u0007\n')).not.toBe(quoted('⟦7⟧\n'));
});

/** Run a fixture test file in update mode through the update script; its exit and the pin file it left. */
function updateFixture(source: string): { exitCode: number; pins: string | undefined } {
  mkdirSync(join(REPO, '.scratch'), { recursive: true });
  const dir = mkdtempSync(join(REPO, '.scratch', 'pins-fixture-'));
  try {
    const file = join(dir, 'fixture.test.ts');
    writeFileSync(
      file,
      `import { expect, test } from 'bun:test';\nimport { pinsOf } from '${join(REPO, 'packages/cli/src/testing/pins')}';\n${source}`,
    );
    const run = Bun.spawnSync(['bun', join(REPO, 'packages/cli/scripts/update-pins.ts'), file], {
      cwd: REPO,
      env: { ...process.env, MIMIR_UPDATE_PINS: undefined },
    });
    const pinFile = join(dir, 'parity-pins', 'fixture.txt');
    return {
      exitCode: run.exitCode,
      pins: existsSync(pinFile) ? readFileSync(pinFile, 'utf8') : undefined,
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

const PASSING = `
const pins = pinsOf(import.meta.url);
const key = pins.claim('one');
test('case', () => pins.check(key, 'text\\n'));
`;

test('a recording whose every test passed is promoted', () => {
  const run = updateFixture(PASSING);
  expect(run.exitCode).toBe(0);
  expect(run.pins).toBe('### one\ntext\n\n');
});

test('a failure in a test that is not a case writes no pins', () => {
  const run = updateFixture(`${PASSING}\ntest('another', () => expect(1).toBe(2));\n`);
  expect(run.exitCode).not.toBe(0);
  expect(run.pins).toBeUndefined();
});
