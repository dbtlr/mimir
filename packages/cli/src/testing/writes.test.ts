import { expect, test } from 'bun:test';

import { argvCase, argvLine } from './argv-case';
import { formatVariance, writeKey } from './writes';

test('a write keys the same under every format, --ascii, and the terminal', () => {
  const plain = writeKey(argvLine('update MMR-3 --title x'), 0);
  for (const variant of [
    argvLine('update MMR-3 --title x -f ids'),
    argvLine('update MMR-3 -f json --title x'),
    argvLine('update MMR-3 --title x --format=jsonl'),
    argvLine('update MMR-3 --title x --ascii'),
    argvLine('update MMR-3 --title x', { tty: true }),
  ]) {
    expect(writeKey(variant, 0)).toBe(plain);
  }
  const named = { name: 'a', options: { title: 'x' }, path: ['update'] };
  expect(writeKey({ ...named, options: { format: 'ids', title: 'x' } }, 0)).toBe(
    writeKey(named, 0),
  );
});

test('a different write, board, or setup keys apart', () => {
  const plain = writeKey(argvLine('update MMR-3 --title x'), 0);
  expect(writeKey(argvLine('update MMR-3 --title y'), 0)).not.toBe(plain);
  expect(writeKey(argvLine('update MMR-3 --title x', { bound: 'MMR' }), 0)).not.toBe(plain);
  expect(writeKey(argvLine('update MMR-3 --title x'), 1)).not.toBe(plain);
  // Words after `--` are text, never the format.
  expect(writeKey(argvCase(['unqueue', 'MMR-3', '--', '-f', 'ids']), 0)).not.toBe(
    writeKey(argvCase(['unqueue', 'MMR-3', '--']), 0),
  );
});

/** One run of the write keyed `k`. */
const run = (name: string, state: string, exitCode = 0) => ({ exitCode, key: 'k', name, state });

test('a format variant that pins other records is reported; a refusal is not compared', () => {
  expect(formatVariance([run('a', 'S'), run('a -f ids', 'S'), run('a -f bogus', '', 2)])).toEqual(
    [],
  );
  expect(formatVariance([run('a', 'S'), run('a -f ids', 'T')])).toEqual([
    'a -f ids: changed other records than a',
  ]);
});
