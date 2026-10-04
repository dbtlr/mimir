import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { parseServeArgs } from './serve-args';

/**
 * `serve`'s flags parse strictly: a flag serve does not know is a usage fault,
 * never ignored — a misspelled `--store` must not quietly serve the
 * installation's store instead of the named file.
 */
test('no flags leave every choice to config and defaults', () => {
  expect(parseServeArgs([])).toEqual({ noHunt: false });
});

test('the port, the no-hunt switch, and the store file parse together', () => {
  expect(parseServeArgs(['--port', '4100', '--no-hunt', '--store', 'fixture.sqlite'])).toEqual({
    noHunt: true,
    port: 4100,
    storeFile: resolve('fixture.sqlite'),
  });
});

test('the inline --store=<file> form names the same file', () => {
  expect(parseServeArgs(['--store=fixture.sqlite'])).toEqual({
    noHunt: false,
    storeFile: resolve('fixture.sqlite'),
  });
});

test('an unknown flag, a stray word, or a value on a switch is a usage fault in house voice', () => {
  for (const [args, error] of [
    [['--stores', 'fixture.sqlite'], "unknown flag '--stores'"],
    [['stray'], "unexpected argument 'stray'"],
    [['--no-hunt=1'], "'--no-hunt' doesn't take a value"],
  ] as const) {
    expect(parseServeArgs(args)).toEqual({ error, hint: "run 'mimir serve -h' for its flags" });
  }
});

test('--store without a file is a usage fault, never the next flag as a path', () => {
  expect(parseServeArgs(['--store'])).toEqual({
    error: '--store expects a SQLite store file',
  });
  expect(parseServeArgs(['--store', '--no-hunt'])).toEqual({
    error: '--store expects a SQLite store file',
  });
});

test('an unusable port is a usage fault', () => {
  for (const args of [['--port'], ['--port', 'abc'], ['--port', '70000']]) {
    expect(parseServeArgs(args)).toEqual({ error: '--port expects an integer in 1–65535' });
  }
});
