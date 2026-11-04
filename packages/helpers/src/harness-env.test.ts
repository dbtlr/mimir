import { expect, test } from 'bun:test';

import { detectHarness, fillFromShell, t3HostFromShell } from './harness-env';

const claudeShell = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'S' };

type Passed = { harness?: string | null; session?: string | null };

test.each([
  ['no flags fill both', {}, 'claude', 'S'],
  ['a matching harness fills the session', { harness: 'claude' }, 'claude', 'S'],
  ['a matching session fills the harness', { session: 'S' }, 'claude', 'S'],
  ['both matching stay as passed', { harness: 'claude', session: 'S' }, 'claude', 'S'],
  ['a different harness fills nothing', { harness: 'codex' }, 'codex', undefined],
  ['a different session fills nothing', { session: 'other' }, undefined, 'other'],
  ['a blank session fills nothing', { session: '' }, undefined, ''],
  ['a cleared session fills nothing', { session: null }, undefined, null],
  ['a blank harness fills nothing', { harness: '' }, '', undefined],
  [
    'a harness with a different session fills nothing',
    { harness: 'claude', session: 'x' },
    'claude',
    'x',
  ],
] satisfies [string, Passed, string | null | undefined, string | null | undefined][])(
  '%s',
  (_name, passed, harness, session) => {
    expect(
      fillFromShell({ harness: undefined, session: undefined, ...passed }, claudeShell),
    ).toEqual({ harness, kind: 'filled', session });
  },
);

test('several detected harnesses fill nothing and are reported', () => {
  expect(
    fillFromShell(
      { harness: undefined, session: undefined },
      { ...claudeShell, CODEX_THREAD_ID: 'T' },
    ),
  ).toEqual({ harnesses: ['claude', 'codex'], kind: 'conflict' });
});

test('no detected harness leaves the passed fields alone', () => {
  expect(fillFromShell({ harness: 'x', session: undefined }, {})).toEqual({
    harness: 'x',
    kind: 'filled',
    session: undefined,
  });
});

test('Claude Code identifies its shell and resumable session', () => {
  expect(detectHarness({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'claude-session' })).toEqual({
    harness: 'claude',
    kind: 'single',
    session: 'claude-session',
  });
});

test('Codex identifies its resumable thread without a separate marker', () => {
  expect(detectHarness({ CODEX_THREAD_ID: 'codex-thread' })).toEqual({
    harness: 'codex',
    kind: 'single',
    session: 'codex-thread',
  });
});

test('OpenCode identifies its shell and resumable session', () => {
  expect(detectHarness({ OPENCODE: '1', OPENCODE_SESSION_ID: 'opencode-session' })).toEqual({
    harness: 'opencode',
    kind: 'single',
    session: 'opencode-session',
  });
});

test('nested harnesses are reported together without choosing a session', () => {
  expect(
    detectHarness({
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'outer',
      CODEX_THREAD_ID: 'inner',
      OPENCODE: '1',
      OPENCODE_SESSION_ID: 'other',
    }),
  ).toEqual({ harnesses: ['claude', 'codex', 'opencode'], kind: 'conflict' });
});

test('missing signals, empty threads, and orphan session ids do not identify a harness', () => {
  for (const env of [
    {},
    { CODEX_THREAD_ID: '' },
    { CODEX_THREAD_ID: '  ' },
    { CLAUDE_CODE_SESSION_ID: 'orphan', OPENCODE_SESSION_ID: 'orphan' },
    { CLAUDECODE: '0', CLAUDE_CODE_SESSION_ID: 'disabled', OPENCODE: 'true' },
  ]) {
    expect(detectHarness(env)).toEqual({ kind: 'none' });
  }
});

test('a shell marker identifies the harness even before a session id is available', () => {
  expect(detectHarness({ CLAUDECODE: '1' })).toEqual({
    harness: 'claude',
    kind: 'single',
    session: undefined,
  });
  expect(detectHarness({ OPENCODE: '1' })).toEqual({
    harness: 'opencode',
    kind: 'single',
    session: undefined,
  });
});

test('each pair of nested harnesses conflicts even with a missing session id', () => {
  expect(detectHarness({ CLAUDECODE: '1', CODEX_THREAD_ID: 'thread' })).toEqual({
    harnesses: ['claude', 'codex'],
    kind: 'conflict',
  });
  expect(detectHarness({ CODEX_THREAD_ID: 'thread', OPENCODE: '1' })).toEqual({
    harnesses: ['codex', 'opencode'],
    kind: 'conflict',
  });
  expect(detectHarness({ CLAUDECODE: '1', OPENCODE: '1' })).toEqual({
    harnesses: ['claude', 'opencode'],
    kind: 'conflict',
  });
});

test('T3 identifies the thread it runs, over the agent it wraps', () => {
  expect(detectHarness({ T3CODE_THREAD_ID: 't3-thread' })).toEqual({
    harness: 't3',
    kind: 'single',
    session: 't3-thread',
  });
  expect(detectHarness({ ...claudeShell, T3CODE_THREAD_ID: 't3-thread' })).toEqual({
    harness: 't3',
    kind: 'single',
    session: 't3-thread',
  });
});

test('T3 settles nested agents that would otherwise conflict', () => {
  expect(
    detectHarness({ ...claudeShell, CODEX_THREAD_ID: 'inner', T3CODE_THREAD_ID: 't3-thread' }),
  ).toEqual({ harness: 't3', kind: 'single', session: 't3-thread' });
  expect(
    detectHarness({ OPENCODE: '1', OPENCODE_SESSION_ID: 'oc', T3CODE_THREAD_ID: 't3-thread' }),
  ).toEqual({ harness: 't3', kind: 'single', session: 't3-thread' });
});

test('a blank T3 thread leaves detection to the agents', () => {
  expect(detectHarness({ ...claudeShell, T3CODE_THREAD_ID: '' })).toEqual({
    harness: 'claude',
    kind: 'single',
    session: 'S',
  });
  expect(
    detectHarness({ ...claudeShell, CODEX_THREAD_ID: 'inner', T3CODE_THREAD_ID: '  ' }),
  ).toEqual({ harnesses: ['claude', 'codex'], kind: 'conflict' });
});

test('inside T3, a passed agent harness fills nothing and the T3 session fills the harness', () => {
  const t3Shell = { ...claudeShell, T3CODE_THREAD_ID: 't3-thread' };
  expect(fillFromShell({ harness: 'claude', session: undefined }, t3Shell)).toEqual({
    harness: 'claude',
    kind: 'filled',
    session: undefined,
  });
  expect(fillFromShell({ harness: undefined, session: 't3-thread' }, t3Shell)).toEqual({
    harness: 't3',
    kind: 'filled',
    session: 't3-thread',
  });
});

const t3Thread = { T3CODE_ENVIRONMENT_ID: 'env-1', T3CODE_THREAD_ID: 't3-thread' };
const thisThread = { harness: 't3', session: 't3-thread' };

test('the T3 environment fills the host of the T3 thread being recorded', () => {
  expect(t3HostFromShell(thisThread, t3Thread)).toBe('env-1');
  expect(t3HostFromShell(thisThread, { ...claudeShell, ...t3Thread })).toBe('env-1');
});

test('a passed host wins over the T3 environment, a blank one included', () => {
  expect(t3HostFromShell({ ...thisThread, host: 'laptop' }, t3Thread)).toBe('laptop');
  expect(t3HostFromShell({ ...thisThread, host: '' }, t3Thread)).toBe('');
});

test.each([
  ['no environment id', { T3CODE_THREAD_ID: 't3-thread' }],
  ['a blank environment id', { T3CODE_ENVIRONMENT_ID: '  ', T3CODE_THREAD_ID: 't3-thread' }],
  ['an environment id outside a T3 thread', { ...claudeShell, T3CODE_ENVIRONMENT_ID: 'env-1' }],
  ['a blank T3 thread', { T3CODE_ENVIRONMENT_ID: 'env-1', T3CODE_THREAD_ID: '' }],
] satisfies [string, Record<string, string>][])('%s fills no host', (_, env) => {
  expect(t3HostFromShell(thisThread, env)).toBeUndefined();
});

test.each([
  ['another harness', { harness: 'claude', session: 't3-thread' }],
  ['another session', { harness: 't3', session: 'other-thread' }],
  ['no harness', { session: 't3-thread' }],
  ['no session', { harness: 't3' }],
] satisfies [string, Passed][])(
  'an identity with %s runs elsewhere and fills no host',
  (_, passed) => {
    expect(t3HostFromShell(passed, t3Thread)).toBeUndefined();
  },
);
