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

test('an unknown or misspelled flag is a usage fault naming that flag', () => {
  for (const [args, named] of [
    [['--stores', 'fixture.sqlite'], "'--stores'"],
    [['--ports', '4100'], "'--ports'"],
    [['stray'], "'stray'"],
  ] as const) {
    const parsed = parseServeArgs(args);
    expect(parsed).toHaveProperty('error');
    expect((parsed as { error: string }).error).toContain(named);
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
