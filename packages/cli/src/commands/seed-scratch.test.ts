import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app';
import { boundClone, parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

/** The tool hints each write command declares for MCP, by command path. */
const MCP_HINTS: [string[], boolean][] = [
  [['seed'], false],
  [['promote'], false],
  [['reject'], false],
  [['resolve'], false],
  [['triage'], false],
  [['scratch', 'create'], false],
  [['scratch', 'update'], false],
  [['scratch', 'checkpoint'], false],
  [['scratch', 'agenda'], false],
  [['scratch', 'freeze'], false],
  [['scratch', 'discard'], true],
];

test.each(MCP_HINTS)('%p opts in to MCP as a write', (path, destructive) => {
  let node = board.app().inspect().root;
  for (const name of path) {
    node = node.children.find((child) => child.name === name) ?? node;
  }
  const mcp = node.extensions['@loomcli/plugins/mcp/command'] as {
    annotations: { destructive?: boolean; readOnly: boolean };
  };
  expect(mcp.annotations.readOnly).toBe(false);
  expect(mcp.annotations.destructive ?? false).toBe(destructive);
});

/** The inputs the `scratch_checkpoint` tool lists: the command's arguments, then its local options. */
test('the scratch checkpoint tool lists its inputs by name', () => {
  const node = board
    .app()
    .inspect()
    .root.children.find((child) => child.name === 'scratch')
    ?.children.find((child) => child.name === 'checkpoint');
  expect(node?.arguments.map((a) => a.name)).toEqual(['id', 'text']);
  // `file` is a content option, which the tool lists as a server-side path (seed LM-s31):
  // the body an agent should send is `text`.
  expect(node?.options.map((o) => o.name)).toEqual([
    'expected-updated-at',
    'file',
    'ascii',
    'format',
  ]);
});

test('scratch checkpoint --file refuses a file it cannot read, with the parser exit code 2', async () => {
  const app = createApp({ git: boundClone('MMR'), store: () => Promise.resolve(board.store) });
  const pad = await board.engine.scratchCreate({ project: 'MMR', title: 'Probe' });
  const run = await runArgv(app, [
    'scratch',
    'checkpoint',
    pad.id,
    '--file',
    '/nonexistent/mimir-checkpoint.md',
    '--expected-updated-at',
    pad.updatedAt.toISOString(),
    '-f',
    'json',
  ]);
  expect(run.exitCode).toBe(2);
  expect(JSON.parse(run.stderr)).toMatchObject({
    error: { code: 'invalid-input', message: expect.stringContaining('--file') },
  });
});

test('a guard that reads as no instant is refused as changed concurrently, not as a crash', async () => {
  const app = createApp({ git: boundClone('MMR'), store: () => Promise.resolve(board.store) });
  const pad = await board.engine.scratchCreate({ project: 'MMR', title: 'Guarded' });
  const run = await runArgv(app, [
    'scratch',
    'update',
    pad.id,
    '--title',
    'Renamed',
    '--expected-updated-at',
    'not-a-time',
    '-f',
    'json',
  ]);
  expect(run.exitCode).toBe(1);
  expect(JSON.parse(run.stderr)).toMatchObject({
    error: { code: 'validation', message: 'the scratchpad changed concurrently' },
  });
});

test('no seed or scratch write opens the store for a wrong invocation', async () => {
  let opened = false;
  const app = createApp({
    git: boundClone('MMR'),
    store: () => {
      opened = true;
      return Promise.resolve(board.store);
    },
  });
  await runArgv(app, ['seed', 'Title']);
  await runArgv(app, ['promote', 'MMR-3', '--parent', 'MMR-2']);
  await runArgv(app, ['reject', 'MMR-s1', ' ']);
  await runArgv(app, [
    'scratch',
    'update',
    'x',
    '--expected-updated-at',
    'x',
    '--clear-links',
    '--link',
    'MMR-3',
  ]);
  await runArgv(app, ['scratch', 'agenda', 'frob', 'x']);
  const empty = join(mkdtempSync(join(tmpdir(), 'mimir-checkpoint-')), 'empty.md');
  writeFileSync(empty, '');
  const refusals = [
    ['scratch', 'checkpoint', 'x', '--file', empty, '--expected-updated-at', 'x'],
    ['scratch', 'agenda', 'add', 'x', '--expected-updated-at', 'x'],
    ['scratch', 'agenda', 'complete', 'x', '--expected-updated-at', 'x'],
    ['scratch', 'agenda', 'supersede', 'x', '3', '--expected-updated-at', 'x'],
  ];
  for (const argv of refusals) {
    expect((await runArgv(app, argv)).exitCode).toBe(2);
  }
  expect(opened).toBe(false);
});
