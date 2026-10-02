import { expect, test } from 'bun:test';

import { mimirCalls, parseClaudeStream, parseCodexStream } from './skill-eval-transcript';

const lines = (...events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n');

test('a Claude stream yields its shell commands, skill loads, and final text', () => {
  const stream = lines(
    { subtype: 'init', type: 'system' },
    {
      message: { content: [{ input: { skill: 'mimir' }, name: 'Skill', type: 'tool_use' }] },
      type: 'assistant',
    },
    {
      message: {
        content: [
          { text: 'Checking the board.', type: 'text' },
          { input: { command: 'mimir overview' }, name: 'Bash', type: 'tool_use' },
        ],
      },
      type: 'assistant',
    },
    { result: 'QEV-3 is in flight.', subtype: 'success', type: 'result' },
  );
  expect(parseClaudeStream(stream)).toEqual({
    commands: ['mimir overview'],
    finalText: 'QEV-3 is in flight.',
    skills: ['mimir'],
  });
});

test('a Codex stream yields completed commands and the last agent message', () => {
  const stream = lines(
    { thread_id: 't', type: 'thread.started' },
    {
      item: { command: "/bin/zsh -lc 'mimir next'", type: 'command_execution' },
      type: 'item.started',
    },
    {
      item: { command: "/bin/zsh -lc 'mimir next'", exit_code: 0, type: 'command_execution' },
      type: 'item.completed',
    },
    { item: { text: 'Working on it.', type: 'agent_message' }, type: 'item.completed' },
    { item: { text: 'Done: QEV-2.', type: 'agent_message' }, type: 'item.completed' },
    'not json',
  );
  expect(parseCodexStream(stream)).toEqual({
    commands: ["/bin/zsh -lc 'mimir next'"],
    finalText: 'Done: QEV-2.',
    skills: [],
  });
});

test('mimir calls are found at command position inside wrappers, chains, and substitutions', () => {
  const calls = mimirCalls([
    "/bin/zsh -lc 'mimir start QEV-2 --branch x && mimir get QEV-2'",
    'ID=$(mimir create task "Fix it" --parent QEV-1 -f ids); echo $ID',
    'cat notes.md | mimir scratch checkpoint abc "note" --expected-updated-at t',
    'echo mimir is great',
  ]);
  expect(calls.map((c) => [c.verb, c.sub])).toEqual([
    ['start', 'QEV-2'],
    ['get', 'QEV-2'],
    ['create', 'task'],
    ['scratch', 'checkpoint'],
  ]);
});

test('a call through an absolute path to any other mimir binary is flagged as an escape', () => {
  const [inside, outside] = mimirCalls(
    ['/eval/run/bin/mimir list', '~/.local/bin/mimir list'],
    '/eval/run/bin/mimir',
  );
  expect(inside?.escaped).toBe(false);
  expect(outside?.escaped).toBe(true);
});
