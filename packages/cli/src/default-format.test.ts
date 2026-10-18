import { expect, test } from 'bun:test';

import { Application, Command } from '@loomcli/core';
import { format } from '@loomcli/plugins/format';

import { defaultFormat, defaultFormats } from './default-format';
import { runArgv } from './testing/run';

const view = (name: string) => ({ render: () => `${name}\n` });

/** A command whose default view is `records` on a terminal and `json` when piped. */
function fixture(extensions = [defaultFormat({ piped: 'json', terminal: 'records' })]) {
  return new Application('probe', {
    description: 'A probe.',
    plugins: [defaultFormats(), format({ short: 'f' })],
  }).command(
    new Command('show', { description: 'Show one value.', extensions })
      .result<{ n: number }>({ views: { json: view('json'), records: view('records') } })
      .action(async ({ out }) => {
        await out.results({ n: 1 });
      }),
  );
}

test('a terminal renders the terminal default and a pipe the piped default', async () => {
  expect((await runArgv(fixture(), ['show'], { tty: true })).stdout).toBe('records\n');
  expect((await runArgv(fixture(), ['show'])).stdout).toBe('json\n');
});

test('an explicit --format wins on either destination', async () => {
  expect((await runArgv(fixture(), ['show', '-f', 'json'], { tty: true })).stdout).toBe('json\n');
  expect((await runArgv(fixture(), ['show', '-f', 'records'])).stdout).toBe('records\n');
});

test('a command that declares no default keeps its first view', async () => {
  expect((await runArgv(fixture([]), ['show'])).stdout).toBe('json\n');
  expect((await runArgv(fixture([]), ['show'], { tty: true })).stdout).toBe('json\n');
});
