import { expect, test } from 'bun:test';

import {
  binaryPaths,
  mimirCalls,
  relativeCalls,
  parseClaudeStream,
  parseCodexStream,
} from './skill-eval-transcript';

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

test('calls stay on their own line, so a following call is never swallowed', () => {
  const calls = mimirCalls(['mimir overview\n/abs/bin/mimir create task x', '(mimir done X)']);
  expect(calls.map((c) => [c.verb, c.sub])).toEqual([
    ['overview', undefined],
    ['create', 'task'],
    ['done', 'X'],
  ]);
});

test('every path naming a mimir file is surfaced, from any position', () => {
  expect(
    binaryPaths([
      'mimir list',
      'env ~/.local/bin/mimir list',
      "'/opt/x/mimir' next && cat .agents/skills/mimir/SKILL.md",
      'ls /tmp/skills/mimir/',
    ]),
  ).toEqual(['~/.local/bin/mimir', '/opt/x/mimir']);
});

test('a help lookup is marked, and a nested substitution stays its own call', () => {
  const calls = mimirCalls([
    "/bin/zsh -lc 'mimir create project --help'",
    'mimir update QEV-2 --upstream "$(mimir seed "x" -k bug -p QOT -f ids)" -h',
    'mimir done QEV-2',
  ]);
  expect(calls.map((c) => [c.verb, c.help])).toEqual([
    ['create', true],
    ['update', false],
    ['seed', false],
    ['done', false],
  ]);
});

test('a PATH assignment surfaces the mimir in each absolute directory it adds', () => {
  expect(
    binaryPaths(['PATH=/opt/live/bin:$PATH mimir overview', 'export PATH="~/tools:$PATH"']),
  ).toEqual(['/opt/live/bin/mimir', '~/tools/mimir']);
});

test('a call through a relative path is surfaced; reading a skill file is not', () => {
  expect(
    relativeCalls([
      './mimir next',
      'cd x && bin/mimir list',
      'cat .agents/skills/mimir/SKILL.md',
      'mimir next',
    ]),
  ).toEqual(['./mimir next', 'cd x && bin/mimir list']);
});
