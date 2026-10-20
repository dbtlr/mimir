import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { OP_FACTS, UNIFORM_VERBS } from '@mimir/contract';
import type { OpFact } from '@mimir/contract';

import { createApp } from '../app';
import { boundClone, parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';

/**
 * The uniform verbs declare themselves from their operation facts (ADR 0025):
 * what a fact says, the command's inputs and help say. Each page is pinned
 * rather than compared with the old CLI.
 */
let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

const page = (name: string): string =>
  readFileSync(new URL(`../help-pages/${name}.txt`, import.meta.url), 'utf8');

const commandOf = (verb: string) => {
  const found = board
    .app()
    .inspect()
    .root.children.find((child) => child.name === verb);
  if (found === undefined) {
    throw new Error(`no command ${verb}`);
  }
  return found;
};

test.each([...UNIFORM_VERBS])('%s declares the inputs its fact names', (verb) => {
  const fact: OpFact = OP_FACTS[verb];
  const command = commandOf(verb);
  const subject = fact.subject === 'project' ? 'key' : 'id';
  expect(command.arguments.map((argument) => argument.name)).toEqual(
    fact.reason === 'none' ? [subject] : [subject, 'reason'],
  );
  const declared = command.options.map((option) => option.name);
  for (const field of fact.fields ?? []) {
    expect(declared).toContain(field.replaceAll('_', '-'));
  }
  expect(declared.includes(fact.choice?.name ?? '')).toBe(fact.choice !== undefined);
  expect((command.description ?? '').toLowerCase()).toStartWith(fact.summary.toLowerCase());
});

test.each([...UNIFORM_VERBS])('%s opts in to MCP as a write', (verb) => {
  const mcp = commandOf(verb).extensions['@loomcli/plugins/mcp/command'];
  expect(mcp).toMatchObject({ annotations: { readOnly: false } });
});

const SEED_CLAUSE =
  ' A seed id (KEY-sN) is accepted too: it moves the seed between untriaged and parked and echoes the seed.';

/** The agent-facing description each verb's MCP tool carries. */
const AGENT_DESCRIPTIONS: Record<string, string> = {
  abandon:
    'Abandon a task (kept, not deleted). Optionally records a reason on the transition. Echoes the updated node.',
  archive:
    'Archive a project — freeze + hide it and its subtree (reversible). Optionally records a reason on the transition. Echoes the project.',
  block:
    'Mark as externally blocked. Optionally records a reason on the transition. Optional on (you|others): who can clear the block (default: others when the task has an upstream, else you). Echoes the updated node.',
  done: 'Complete a task (approves a review). Echoes the updated node.',
  park: `Put a task on hold. Optionally records a reason on the transition. Echoes the updated node.${SEED_CLAUSE}`,
  queue:
    'Reserve a task for an autonomous run (todo → queued). Requires session. Echoes the updated node.',
  reopen:
    'Reopen a terminal task (done/abandoned → in_progress). Optionally records a reason on the transition. Echoes the updated node.',
  return:
    'Send back for changes (under_review → in_progress). Optionally records a reason on the transition. Echoes the updated node.',
  start:
    'Begin a task (todo/queued → in_progress). Echoes the updated node. Preserves the main conversation. Explicit worker-session assigns a distinct whole-task owner; worker-harness is optional and is never inferred from the shell.',
  submit: 'Submit for review (in_progress → under_review). Echoes the updated node.',
  unarchive: 'Restore an archived project. Echoes the project.',
  unblock: 'Clear the blocked hold. Echoes the updated node.',
  unpark: `Clear the parked hold. Echoes the updated node.${SEED_CLAUSE}`,
  unqueue:
    'Cancel a reservation and return the task to todo (queued → todo). Requires a reason recorded on the transition. Echoes the updated node.',
};

test.each([...UNIFORM_VERBS])('%s carries its pinned agent description', (verb) => {
  const mcp = commandOf(verb).extensions['@loomcli/plugins/mcp/command'];
  expect(mcp).toMatchObject({ description: AGENT_DESCRIPTIONS[verb] });
});

test.each([...UNIFORM_VERBS])('the %s help page is pinned', async (verb) => {
  const run = await runArgv(board.app(), [verb, '--help']);
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe(page(verb));
});

test('a blank subject is a usage error that never opens the store', async () => {
  let opened = false;
  const app = createApp({
    git: boundClone(undefined),
    store: () => {
      opened = true;
      return Promise.resolve(board.store);
    },
  });
  const run = await runArgv(app, ['start', ' ']);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('start requires an id (KEY-seq)');
  expect(opened).toBe(false);
});

/** Run argv on a fresh board, since a queue or start writes. */
async function onFreshBoard(argv: string[], env: Record<string, string>) {
  const fresh = await parityBoard();
  try {
    return await runArgv(fresh.app(), argv, { env: { TERM: 'xterm-256color', ...env } });
  } finally {
    await fresh.close();
  }
}

test('queue fills its harness and session from a shell naming one harness', async () => {
  const run = await onFreshBoard(['queue', 'MMR-3', '-f', 'json'], {
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'claude-session',
  });
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ harness: 'claude', session: 'claude-session' });
});

test('a queued handoff preserves main identity and leaves an omitted worker harness unknown', async () => {
  const fresh = await parityBoard();
  try {
    await fresh.engine.queue({ harness: 'codex', id: 'MMR-3', session: 'main-session' });
    const run = await runArgv(
      fresh.app(),
      ['start', 'MMR-3', '--worker-session', 'worker-session', '-f', 'json'],
      { env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'incidental-session' } },
    );
    expect(run.exitCode, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      harness: 'codex',
      session: 'main-session',
      worker_harness: null,
      worker_session: 'worker-session',
    });
    expect(run.stderr).toBe('');
  } finally {
    await fresh.close();
  }
});

test('queue prefers the flags to the shell', async () => {
  const run = await onFreshBoard(
    ['queue', 'MMR-3', '--harness', 'codex', '--session', 'run-1', '-f', 'json'],
    { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'claude-session' },
  );
  expect(JSON.parse(run.stdout)).toMatchObject({ harness: 'codex', session: 'run-1' });
});

const claudeShell = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'claude-session' };

test('start with a different harness records the harness without the shell session', async () => {
  const run = await onFreshBoard(
    ['start', 'MMR-3', '--harness', 'codex', '-f', 'json'],
    claudeShell,
  );
  expect(JSON.parse(run.stdout)).toMatchObject({ harness: 'codex', session: null });
});

test('start with a blank session records no harness from the shell', async () => {
  const run = await onFreshBoard(['start', 'MMR-3', '--session', '', '-f', 'json'], claudeShell);
  expect(JSON.parse(run.stdout)).toMatchObject({ harness: null, session: null });
});

test('start with the shell session fills the harness', async () => {
  const run = await onFreshBoard(
    ['start', 'MMR-3', '--session', 'claude-session', '-f', 'json'],
    claudeShell,
  );
  expect(JSON.parse(run.stdout)).toMatchObject({ harness: 'claude', session: 'claude-session' });
});

test('queue with a different harness refuses rather than borrow the shell session', async () => {
  const run = await onFreshBoard(['queue', 'MMR-3', '--harness', 'codex'], claudeShell);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('queue requires a nonblank session');
});

test('queue with a blank session refuses', async () => {
  const run = await onFreshBoard(['queue', 'MMR-3', '--session', ''], claudeShell);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('queue requires a nonblank session');
});

test('start fills only what the flags leave out', async () => {
  const run = await onFreshBoard(['start', 'MMR-3', '--session', 'codex-thread', '-f', 'json'], {
    CODEX_THREAD_ID: 'codex-thread',
  });
  expect(JSON.parse(run.stdout)).toMatchObject({ harness: 'codex', session: 'codex-thread' });
});

test('queue names the harnesses it will not choose between and refuses without a session', async () => {
  const run = await onFreshBoard(['queue', 'MMR-3'], {
    CLAUDECODE: '1',
    CODEX_THREAD_ID: 'codex-thread',
  });
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('detected multiple harnesses (claude, codex)');
  expect(run.stderr).toContain('queue requires a nonblank session');
});

test('unqueue refuses a blank reason before it reaches the Engine', async () => {
  const run = await onFreshBoard(['unqueue', 'MMR-3', ' '], {});
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('unqueue requires a reason');
});

test.each([
  ['start', 'MMR-3'],
  ['queue', 'MMR-3'],
  ['done', 'MMR-5'],
  ['unarchive', 'XX'],
])('%s refuses words after -- rather than dropping them', async (verb, subject) => {
  const run = await runArgv(board.app(), [verb, subject, '--', 'x']);
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('unexpected argument: x');
});
