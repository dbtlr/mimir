import { expect, test } from 'bun:test';

import { detectHarness } from './harness-env';

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
