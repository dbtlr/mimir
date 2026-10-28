import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readExtension } from '@loomcli/core';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';

import { createApp } from '../app';
import { DASH_TITLE_HINT } from '../failures';
import { boundClone, parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

/**
 * What the parity cases cannot reach: input from stdin (the old CLI reads the
 * process's own), the words after `--`, the leading-dash hint on a parser
 * fault, the MCP opt-in, and that a wrong invocation never opens the store.
 */
let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

const WRITES = [
  ['create', 'project'],
  ['create', 'initiative'],
  ['create', 'phase'],
  ['create', 'task'],
  ['update'],
  ['annotate'],
  ['attach'],
  ['depend'],
  ['undepend'],
  ['move'],
  ['reorder'],
  ['groom'],
  ['tag'],
  ['untag'],
];

test.each(WRITES)('%s opts in to MCP as a write', (...path) => {
  let node = board.app().inspect().root;
  for (const name of path) {
    node = node.children.find((child) => child.name === name) ?? node;
  }
  const mcp = readExtension(node, mcpCommand);
  expect(mcp?.annotations?.readOnly).toBe(false);
  expect(mcp?.annotations?.openWorld).toBe(false);
});

test('annotate takes its text from stdin when none is typed', async () => {
  const run = await runArgv(board.app(), ['annotate', 'MMR-3', '-f', 'ids'], {
    stdin: '  a piped note \n',
  });
  expect(run.exitCode).toBe(0);
  const got = await board.engine.getNode({
    facets: ['annotations'],
    id: 'MMR-3',
  });
  expect(got.annotations?.at(-1)?.content).toBe('a piped note');
});

test('annotate with no text and no stdin is a usage error that opens no store', async () => {
  let opened = false;
  const app = createApp({
    git: boundClone(undefined),
    store: () => {
      opened = true;
      return Promise.resolve(board.store);
    },
  });
  const run = await runArgv(app, ['annotate', 'MMR-3'], { stdin: '' });
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('annotate requires content (positional or stdin)');
  expect(opened).toBe(false);
});

test('annotate on an interactive stdin refuses instead of waiting for the keyboard', async () => {
  const run = await runArgv(board.app(), ['annotate', 'MMR-3'], {
    interactive: true,
    stdin: 'would block a real terminal',
  });
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('annotate requires content (positional or stdin)');
});

test('attach on an interactive stdin refuses instead of waiting for the keyboard', async () => {
  const run = await runArgv(board.app(), ['attach', 'MMR-5', '--title', 'x'], {
    interactive: true,
    stdin: '# would block a real terminal',
  });
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain(
    'attach requires content (--content <text>, --file <path>, or piped stdin)',
  );
});

test('attach reads the document from stdin and needs a title then', async () => {
  const titled = await runArgv(
    board.app(),
    ['attach', 'MMR-5', '--title', 'Piped notes', '-f', 'json'],
    { stdin: '# Piped\n\nBody.\n' },
  );
  expect(titled.exitCode).toBe(0);
  expect(JSON.parse(titled.stdout)).toEqual({ artifact: { id: 'MMR-a2' } });
  const bare = await runArgv(board.app(), ['attach', 'MMR-5'], {
    stdin: '# Piped\n',
  });
  expect(bare.exitCode).toBe(2);
  expect(bare.stderr).toContain('attach from --content or stdin requires --title <text>');
  const none = await runArgv(board.app(), ['attach', 'MMR-5', '--title', 'x'], {
    stdin: ' \n',
  });
  expect(none.exitCode).toBe(2);
  expect(none.stderr).toContain(
    'attach requires content (--content <text>, --file <path>, or piped stdin)',
  );
});

test('attach takes the body inline with --content, and reads no stdin', async () => {
  const run = await runArgv(
    board.app(),
    ['attach', 'MMR-5', '--content', '# Inline\n', '--title', 'Inline notes', '-f', 'json'],
    { stdin: 'ignored piped text' },
  );
  expect(run.exitCode).toBe(0);
  const { id } = JSON.parse(run.stdout).artifact;
  const got = await board.engine.getArtifact({ content: true, id });
  expect(got.content).toBe('# Inline');
  expect(got.title).toBe('Inline notes');
});

test('attach --content needs a title, as the old MCP attach did', async () => {
  const run = await runArgv(board.app(), ['attach', 'MMR-5', '--content', 'body']);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('attach from --content or stdin requires --title <text>');
});

test('attach refuses blank --content', async () => {
  const run = await runArgv(board.app(), ['attach', 'MMR-5', '--content', '  ', '--title', 'x']);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain(
    'attach requires content (--content <text>, --file <path>, or piped stdin)',
  );
});

test('attach refuses --content with --file, naming both', async () => {
  const run = await runArgv(board.app(), [
    'attach',
    'MMR-5',
    '--content',
    'body',
    '--file',
    '/does/not/matter.md',
    '--title',
    'x',
  ]);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('--content');
  expect(run.stderr).toContain('--file');
});

test('attach titles a file by its name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-attach-unit-'));
  try {
    const file = join(dir, 'plan.md');
    writeFileSync(file, '# Plan\n');
    const run = await runArgv(board.app(), ['attach', 'MMR-5', '--file', file, '-f', 'ids']);
    expect(run.exitCode).toBe(0);
    const artifact = await board.engine.getArtifact({ id: run.stdout.trim() });
    expect(artifact.title).toBe('plan.md');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('words after -- are the title, so a title may lead with a dash', async () => {
  const run = await runArgv(board.app(), [
    'create',
    'task',
    '--parent',
    'MMR-2',
    '-f',
    'ids',
    '--',
    '--two',
    'words',
  ]);
  expect(run.exitCode).toBe(0);
  const made = await board.engine.getNode({ id: run.stdout.trim() });
  expect(made.title).toBe('--two words');
});

/** An app whose failures read `argv` as the run's words. */
const appFor = (argv: string[]) =>
  createApp({
    argv: () => argv,
    git: boundClone(undefined),
    store: () => Promise.resolve(board.store),
  });

test('a title the parser reads as an option is refused with the hint to use --', async () => {
  const argv = ['create', 'task', '--weird-title', '--parent', 'MMR-2'];
  const run = await runArgv(appFor(argv), argv);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain(DASH_TITLE_HINT);
});

test.each<{ argv: string[] }>([
  { argv: ['create', 'task', 'Ship docs', '--parent', 'MMR-2', '--bogus'] },
  { argv: ['create', 'project', 'Gamma', '--key', 'GAM', '-y', '--bogus'] },
  { argv: ['create', 'task', '--parent', 'MMR-2', '--bogus', 'Ship docs'] },
])('an unknown option beside a title gets no leading-dash advice: $argv', async ({ argv }) => {
  const run = await runArgv(appFor(argv), argv);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).not.toContain(DASH_TITLE_HINT);
});

test('a by-name create with an unknown option gets no dash hint', async () => {
  const app = appFor(['mcp', 'serve']);
  const outcome = await app.invoke(['create', 'task'], {
    args: { title: 'Ship docs' },
    options: { bogus: 'x' },
  });
  expect(outcome.status).toBe('failed');
  expect(outcome.status === 'failed' ? outcome.form.hints : []).not.toContain(DASH_TITLE_HINT);
});

test('create project takes its name as --name too', async () => {
  const run = await runArgv(board.app(), [
    'create',
    'project',
    '--name',
    'Gamma',
    '--key',
    'GAM',
    '-y',
    '-f',
    'json',
  ]);
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({
    project: { key: 'GAM', name: 'Gamma' },
  });
});

test('attach names a missing file as a Loom content fault, exit 2', async () => {
  const run = await runArgv(board.app(), ['attach', 'MMR-5', '--file', '/nonexistent/missing.md']);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('Option "--file": Expected a readable file that exists.');
});

const projectKeys = async () =>
  (await board.engine.projects({ status: 'all' })).map((project) => project.id);

test('create project proceeds when the terminal confirms', async () => {
  const run = await runArgv(
    board.app(),
    ['create', 'project', 'Epsilon', '--key', 'EPS', '-f', 'json'],
    {
      interactive: true,
      keys: 'y\r',
      tty: true,
    },
  );
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain('create project EPS ("Epsilon") — the key is immutable. proceed?');
  expect(await projectKeys()).toContain('EPS');
});

test('create project aborts, exit 1, and writes nothing when the terminal declines', async () => {
  const run = await runArgv(board.app(), ['create', 'project', 'Delta', '--key', 'DEL'], {
    interactive: true,
    keys: 'n\r',
    tty: true,
  });
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('aborted');
  expect(await projectKeys()).not.toContain('DEL');
});

test('create project cancelled at the prompt exits 130 and writes nothing', async () => {
  const run = await runArgv(board.app(), ['create', 'project', 'Iota', '--key', 'IOT'], {
    interactive: true,
    keys: '\u0003',
    tty: true,
  });
  expect(run.exitCode).toBe(130);
  expect(await projectKeys()).not.toContain('IOT');
});

test('create project with --yes at a terminal creates without asking', async () => {
  // A terminal with no keys typed: any question would fail the run.
  const run = await runArgv(board.app(), ['create', 'project', 'Zeta', '--key', 'ZET', '--yes'], {
    interactive: true,
    tty: true,
  });
  expect(run.exitCode).toBe(0);
  expect(run.stderr).not.toContain('proceed?');
  expect(await projectKeys()).toContain('ZET');
});

test('create project asks for -y where there is no terminal to ask on', async () => {
  const run = await runArgv(board.app(), ['create', 'project', 'Gamma', '--key', 'GAM']);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('create project GAM: the key is immutable — confirmation required');
  expect(run.stderr).toContain('re-run with -y/--yes to confirm');
});

test('create project with --no-input at a terminal asks for -y instead of prompting', async () => {
  const run = await runArgv(
    board.app(),
    ['create', 'project', 'Theta', '--key', 'THE', '--no-input'],
    {
      interactive: true,
      tty: true,
    },
  );
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('re-run with -y/--yes to confirm');
  expect(await projectKeys()).not.toContain('THE');
});

test('update retitles an artifact and echoes it', async () => {
  const run = await runArgv(board.app(), ['update', 'MMR-a1', '--title', 'Retitled', '-f', 'ids']);
  expect(run.exitCode).toBe(0);
  expect(run.stdout.trim()).toBe('MMR-a1');
  expect((await board.engine.getArtifact({ id: 'MMR-a1' })).title).toBe('Retitled');
});

test('update changes a seed kind', async () => {
  const run = await runArgv(board.app(), ['update', 'MMR-s1', '--kind', 'bug', '-f', 'ids']);
  expect(run.exitCode).toBe(0);
  expect((await board.engine.getSeed({ id: 'MMR-s1' })).kind).toBe('bug');
});

test('a usage fault in a node write opens no store', async () => {
  let opened = false;
  const app = createApp({
    git: boundClone(undefined),
    store: () => {
      opened = true;
      return Promise.resolve(board.store);
    },
  });
  const runs = [
    [['update', 'MMR-3', '-p', 'zz'], 'invalid priority: zz'],
    [['update', 'MMR-s1', '--kind', 'nope'], 'invalid kind: nope'],
    [['create', 'task', 'x', '--parent', 'MMR', '-f', 'json'], "a task's parent must be"],
    [['groom', 'MMR-3', 'bogus'], "unknown grooming state 'bogus'"],
    [['depend', 'MMR-4', '--on', ''], 'depend --on expects'],
  ] as const;
  for (const [argv, message] of runs) {
    const run = await runArgv(app, [...argv]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(message);
  }
  expect(opened).toBe(false);
});
