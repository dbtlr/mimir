import { expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';

/** Each CLI invocation gets an isolated shell environment and disposable in-memory store. */
function invoke(
  env: Record<string, string>,
  flags: string[] = [],
  verb = 'start',
  format = 'json',
  before: string[][] = [],
) {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      '--eval',
      `
      import { createProject, createInitiative, createTask } from '@mimir/core';
      import { createTestStore } from '@mimir/core/testing';
      import { runCli } from './run';
      import { fakeIo } from './testing';
      const { store, close } = await createTestStore();
      try {
        await createProject(store, { key: 'MMR', name: 'test' });
        const parent = await createInitiative(store, { projectId: 'MMR', title: 'parent' });
        const task = await createTask(store, { parentId: parent.id, title: 'task' });
        const id = 'MMR-' + task.seq;
        for (const [verb, ...flags] of ${JSON.stringify(before)}) {
          const setup = fakeIo();
          const code = await runCli([verb, id, ...flags], () => store, setup);
          if (code !== 0) throw new Error(setup.err.join('\\n'));
        }
        const io = fakeIo();
        const code = await runCli([${JSON.stringify(verb)}, id, ...${JSON.stringify(flags)}, '-f', ${JSON.stringify(format)}], () => store, io);
        const read = fakeIo();
        await runCli(['get', id, '-f', 'json'], () => store, read);
        process.stdout.write(JSON.stringify({ code, err: io.err, out: io.out, node: JSON.parse(read.out.join('')) }));
      } finally {
        await close();
      }
    `,
    ],
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
      CODEX_THREAD_ID: undefined,
      OPENCODE: undefined,
      OPENCODE_SESSION_ID: undefined,
      ...env,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  return parseJson<{
    code: number;
    err: string[];
    out: string[];
    node: { harness?: string | null; session?: string | null; lifecycle: string; status: string };
  }>(result.stdout.toString());
}

test('start records the Claude Code shell identity when handle flags are omitted', () => {
  const result = invoke({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'claude-session' });
  expect(result.code).toBe(0);
  expect(result.node).toMatchObject({
    harness: 'claude',
    session: 'claude-session',
    status: 'in_progress',
  });
  expect(result.err).toEqual([]);
});

test('start retains its todo source in the human transition echo', () => {
  const result = invoke({}, [], 'start', 'records');
  expect(result.code).toBe(0);
  expect(result.out.join('\n')).toContain('todo -> in_progress');
});

test('unqueue requires a nonblank reason before attempting its mutation', () => {
  for (const flags of [[], ['  ']]) {
    const result = invoke({}, flags, 'unqueue');
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('unqueue requires a reason');
    expect(result.node.lifecycle).toBe('todo');
  }
});

test.each([
  ['codex', { CODEX_THREAD_ID: 'codex-thread' }, 'codex-thread'],
  ['opencode', { OPENCODE: '1', OPENCODE_SESSION_ID: 'opencode-session' }, 'opencode-session'],
] satisfies [string, Record<string, string>, string][])(
  'start records %s shell handles when flags are omitted',
  (harness, env, session) => {
    const result = invoke(env);
    expect(result.code).toBe(0);
    expect(result.node).toMatchObject({ harness, session });
  },
);

test.each([
  ['claude', { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'claude-session' }, 'claude-session'],
  ['codex', { CODEX_THREAD_ID: 'codex-thread' }, 'codex-thread'],
  ['opencode', { OPENCODE: '1', OPENCODE_SESSION_ID: 'opencode-session' }, 'opencode-session'],
] satisfies [string, Record<string, string>, string][])(
  'queue records %s shell handles when flags are omitted',
  (harness, env, session) => {
    const result = invoke(env, [], 'queue');
    expect(result.code).toBe(0);
    expect(result.node).toMatchObject({ harness, lifecycle: 'queued', session, status: 'queued' });
    expect(result.err).toEqual([]);
  },
);

test('explicit handle flags override fallback independently', () => {
  const env = { CODEX_THREAD_ID: 'detected-thread' };
  expect(invoke(env, ['--harness', 'custom']).node).toMatchObject({
    harness: 'custom',
    session: 'detected-thread',
  });
  expect(invoke(env, ['--session', 'explicit-session']).node).toMatchObject({
    harness: 'codex',
    session: 'explicit-session',
  });
});

test('explicit blank handle flags clear instead of accepting fallback', () => {
  const env = { CODEX_THREAD_ID: 'detected-thread' };
  const cleared = invoke(env, ['--harness', '', '--session', '  ']);
  expect(cleared.code).toBe(0);
  expect(cleared.node).toMatchObject({ harness: null, session: null });
  expect(invoke(env, ['--harness', '']).node).toMatchObject({
    harness: null,
    session: 'detected-thread',
  });
  expect(invoke(env, ['--session', '']).node).toMatchObject({
    harness: 'codex',
    session: null,
  });
});

const nestedEnv = {
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'outer',
  CODEX_THREAD_ID: 'inner',
};

test('nested harnesses leave omitted handles empty and explain the explicit flags on stderr', () => {
  const result = invoke(nestedEnv);
  expect(result.code).toBe(0);
  expect(result.node).toMatchObject({ harness: null, session: null });
  expect(result.err).toEqual([
    'note: detected multiple harnesses (claude, codex); pass --harness and --session explicitly',
  ]);
  expect(result.out).toHaveLength(1);
  expect(JSON.parse(result.out[0] ?? '{}').lifecycle).toBe('in_progress');
});

test('nested harnesses preserve an explicit flag and fill nothing else', () => {
  const result = invoke(nestedEnv, ['--harness', 'custom']);
  expect(result.code).toBe(0);
  expect(result.node).toMatchObject({ harness: 'custom', session: null });
  expect(result.err.join('\n')).toContain('claude, codex');
});

test('explicit harness and session resolve a nested environment without a note', () => {
  const result = invoke(nestedEnv, ['--harness', 'codex', '--session', 'chosen']);
  expect(result.code).toBe(0);
  expect(result.node).toMatchObject({ harness: 'codex', session: 'chosen' });
  expect(result.err).toEqual([]);
});

test('queue refuses an ambiguous or explicitly blank session without changing the task', () => {
  for (const [env, flags] of [
    [nestedEnv, []],
    [{ CODEX_THREAD_ID: 'thread' }, ['--session', '']],
  ] satisfies [Record<string, string>, string[]][]) {
    const result = invoke(env, flags, 'queue');
    expect(result.code).toBe(1);
    expect(result.node).toMatchObject({ harness: null, lifecycle: 'todo', session: null });
    expect(result.err.join('\n')).toContain('session');
  }
});

test('no harness signals leave handles empty', () => {
  const result = invoke({});
  expect(result.code).toBe(0);
  expect(result.node).toMatchObject({ harness: null, session: null });
  expect(result.err).toEqual([]);
});

test('ordinary update does not infer handles from the shell', () => {
  const result = invoke({ CODEX_THREAD_ID: 'thread' }, ['--title', 'renamed'], 'update');
  expect(result.code).toBe(0);
  expect(result.node).toMatchObject({ harness: null, session: null });
  expect(result.err).toEqual([]);
});

test('starting queued work names the queued source in its human echo', () => {
  const result = invoke({}, [], 'start', 'records', [['queue', '--session', 'queued-session']]);
  expect(result.code).toBe(0);
  expect(result.out.join('\n')).toContain('queued -> in_progress');
});

test('unqueue accepts its required reason and returns reserved work to todo', () => {
  const result = invoke({}, ['run cancelled'], 'unqueue', 'json', [
    ['queue', '--session', 'reserved'],
  ]);
  expect(result.code).toBe(0);
  expect(result.node).toMatchObject({ lifecycle: 'todo', session: null });
});
